require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('[migrate] Starting...');
    await client.query('BEGIN');

    await client.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    // ── SUPER ADMINS (platform-level, no tenant) ────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS super_admins (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        name          TEXT        NOT NULL,
        email         TEXT        UNIQUE NOT NULL,
        password_hash TEXT        NOT NULL,
        role          TEXT        NOT NULL DEFAULT 'superadmin'
                      CHECK (role IN ('superadmin','support')),
        active        BOOLEAN     NOT NULL DEFAULT TRUE,
        failed_logins INTEGER     NOT NULL DEFAULT 0,
        locked_until  TIMESTAMPTZ,
        last_login    TIMESTAMPTZ,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── SUBSCRIPTION PLANS (fully customisable by super admin) ──────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        name            TEXT        UNIQUE NOT NULL,   -- 'Trial','Monthly','Quarterly'...
        code            TEXT        UNIQUE NOT NULL,   -- 'trial','monthly','quarterly'...
        duration_days   INTEGER     NOT NULL,          -- 7 / 30 / 90 / 180 / 365
        price_inr       NUMERIC(10,2) NOT NULL DEFAULT 0,
        max_employees   INTEGER     NOT NULL DEFAULT 50,
        max_departments INTEGER     NOT NULL DEFAULT 10,
        features        JSONB       NOT NULL DEFAULT '{}',
        is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
        is_custom       BOOLEAN     NOT NULL DEFAULT FALSE,
        sort_order      INTEGER     NOT NULL DEFAULT 0,
        description     TEXT,
        created_by      UUID        REFERENCES super_admins(id),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── TENANTS (companies) ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        name            TEXT        NOT NULL,
        slug            TEXT        UNIQUE NOT NULL,
        email           TEXT        UNIQUE NOT NULL,
        phone           TEXT,
        address         TEXT,
        logo_url        TEXT,
        active          BOOLEAN     NOT NULL DEFAULT TRUE,
        created_by      UUID        REFERENCES super_admins(id),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── TENANT SUBSCRIPTIONS ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_subscriptions (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        plan_id         UUID        NOT NULL REFERENCES subscription_plans(id),
        status          TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','expired','cancelled','suspended')),
        starts_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at      TIMESTAMPTZ NOT NULL,
        price_paid      NUMERIC(10,2) NOT NULL DEFAULT 0,
        -- Override plan limits per company if needed
        custom_max_emp  INTEGER,
        custom_max_dept INTEGER,
        custom_features JSONB,
        notes           TEXT,
        activated_by    UUID        REFERENCES super_admins(id),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── SUBSCRIPTION HISTORY (audit of all plan changes) ───────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_history (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        plan_id         UUID        REFERENCES subscription_plans(id),
        action          TEXT        NOT NULL,
          -- 'created','renewed','upgraded','downgraded','suspended','cancelled','reactivated'
        old_status      TEXT,
        new_status      TEXT,
        old_expires_at  TIMESTAMPTZ,
        new_expires_at  TIMESTAMPTZ,
        price_paid      NUMERIC(10,2),
        performed_by    UUID        REFERENCES super_admins(id),
        notes           TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── DEPARTMENTS ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name        TEXT        NOT NULL,
        head        TEXT,
        color       TEXT        DEFAULT '#10b981',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── EMPLOYEES ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        emp_code        TEXT        NOT NULL,
        name            TEXT        NOT NULL,
        email           TEXT        NOT NULL,
        dept_id         UUID        REFERENCES departments(id) ON DELETE SET NULL,
        designation     TEXT,
        phone           TEXT,
        salary_monthly  NUMERIC(12,2) NOT NULL DEFAULT 0,
        hourly_rate     NUMERIC(8,2)  NOT NULL DEFAULT 0,
        leave_quota     INTEGER     NOT NULL DEFAULT 18,
        joined_date     DATE,
        status          TEXT        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','inactive')),
        password_hash   TEXT        NOT NULL,
        role            TEXT        NOT NULL DEFAULT 'employee'
                        CHECK (role IN ('admin','hr','employee')),
        failed_logins   INTEGER     NOT NULL DEFAULT 0,
        locked_until    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(tenant_id, emp_code),
        UNIQUE(tenant_id, email)
      )
    `);

    // ── ATTENDANCE ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        emp_id        UUID        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        date          DATE        NOT NULL,
        session_no    INTEGER     NOT NULL DEFAULT 1 CHECK (session_no BETWEEN 1 AND 3),
        check_in      TIMESTAMPTZ NOT NULL,
        check_out     TIMESTAMPTZ,
        duration_hr   NUMERIC(5,2),
        location      TEXT,
        qr_token_hash TEXT,
        note          TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(tenant_id, emp_id, date, session_no)
      )
    `);

    // ── LEAVES ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS leaves (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        emp_id        UUID        NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        type          TEXT        NOT NULL,
        from_date     DATE        NOT NULL,
        to_date       DATE        NOT NULL,
        days          INTEGER     NOT NULL CHECK (days > 0),
        reason        TEXT,
        status        TEXT        NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected')),
        approved_by   UUID        REFERENCES employees(id),
        applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at   TIMESTAMPTZ
      )
    `);

    // ── TENANT CONFIG ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_config (
        tenant_id         UUID    PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
        work_hours        NUMERIC(4,1) NOT NULL DEFAULT 8,
        ot_multiplier     NUMERIC(3,1) NOT NULL DEFAULT 1.5,
        grace_min         INTEGER NOT NULL DEFAULT 15,
        shift_start       TEXT    NOT NULL DEFAULT '09:00',
        shift_end         TEXT    NOT NULL DEFAULT '18:00',
        deduct_per_absent NUMERIC(10,2) NOT NULL DEFAULT 2000,
        half_day_hr       NUMERIC(3,1) NOT NULL DEFAULT 4,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── AUDIT LOG ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   UUID        REFERENCES tenants(id) ON DELETE SET NULL,
        actor_id    UUID,
        actor_type  TEXT        NOT NULL DEFAULT 'employee',
                    -- 'employee' | 'superadmin'
        action      TEXT        NOT NULL,
        table_name  TEXT,
        record_id   UUID,
        ip_address  INET,
        user_agent  TEXT,
        detail      JSONB,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // ── INDEXES ──────────────────────────────────────────────────────────────
    const indexes = [
      `CREATE INDEX IF NOT EXISTS idx_att_tenant_date    ON attendance(tenant_id, date)`,
      `CREATE INDEX IF NOT EXISTS idx_att_emp_date       ON attendance(emp_id, date)`,
      `CREATE INDEX IF NOT EXISTS idx_emp_tenant         ON employees(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_emp_email          ON employees(tenant_id, email)`,
      `CREATE INDEX IF NOT EXISTS idx_emp_code           ON employees(tenant_id, emp_code)`,
      `CREATE INDEX IF NOT EXISTS idx_leaves_tenant_emp  ON leaves(tenant_id, emp_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sub_tenant         ON tenant_subscriptions(tenant_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sub_expires        ON tenant_subscriptions(expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_sub_status         ON tenant_subscriptions(status)`,
      `CREATE INDEX IF NOT EXISTS idx_sub_hist_tenant    ON subscription_history(tenant_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_tenant       ON audit_log(tenant_id, created_at DESC)`,
    ];
    for (const idx of indexes) await client.query(idx);

    // ── ROW LEVEL SECURITY (tenant-scoped tables only) ───────────────────────
    // RLS is enforced via app.tenant_id session variable (set in auth middleware).
    // When the variable is empty (e.g. during login via pool), we bypass RLS
    // by granting BYPASSRLS to the database owner role (Railway default).
    // The policy itself only filters when a tenant context is set.
    const rlsTables = ['departments','employees','attendance','leaves','tenant_config'];
    for (const t of rlsTables) {
      await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      // Allow the table owner / superuser to bypass RLS (needed for login query)
      await client.query(`ALTER TABLE ${t} FORCE ROW LEVEL SECURITY`).catch(()=>{});
      await client.query(`DROP POLICY IF EXISTS rls_${t} ON ${t}`);
      await client.query(`DROP POLICY IF EXISTS rls_${t}_bypass ON ${t}`);
      // Main policy: filter by tenant when context is set
      await client.query(`
        CREATE POLICY rls_${t} ON ${t}
          USING (
            current_setting('app.tenant_id', TRUE) IS NOT NULL
            AND current_setting('app.tenant_id', TRUE) != ''
            AND tenant_id = current_setting('app.tenant_id', TRUE)::UUID
          )
      `);
      // Bypass policy: allow all rows when no tenant context (login, migrations, seeds)
      await client.query(`
        CREATE POLICY rls_${t}_bypass ON ${t}
          USING (
            current_setting('app.tenant_id', TRUE) IS NULL
            OR current_setting('app.tenant_id', TRUE) = ''
          )
      `);
    }

    await client.query('COMMIT');
    console.log('[migrate] Done — all tables, indexes, RLS created.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] FAILED:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(() => process.exit(1));
