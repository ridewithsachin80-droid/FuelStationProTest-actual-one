const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

const validate = (req, res, next) => {
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ errors: e.array() });
  next();
};

router.use(requireAuth, requireSuperAdmin);

// ── GET /api/super/companies — list all companies with subscription status ──
router.get('/', async (req, res) => {
  try {
    const { rows } = await req.pool.query(`
      SELECT
        t.id, t.name, t.slug, t.email, t.phone, t.address,
        t.active, t.created_at,
        sp.name        as plan_name,
        sp.code        as plan_code,
        sp.price_inr   as plan_price,
        sub.id         as sub_id,
        sub.status     as sub_status,
        sub.starts_at,
        sub.expires_at,
        sub.price_paid,
        CASE
          WHEN sub.expires_at < NOW()       THEN 'expired'
          WHEN sub.expires_at < NOW() + INTERVAL '7 days' THEN 'expiring_soon'
          ELSE 'ok'
        END as expiry_health,
        (SELECT COUNT(*) FROM employees e WHERE e.tenant_id = t.id AND e.status='active') as emp_count,
        sa.name as created_by_name
      FROM  tenants t
      LEFT JOIN tenant_subscriptions sub
        ON sub.tenant_id = t.id
        AND sub.id = (
          SELECT id FROM tenant_subscriptions
          WHERE tenant_id = t.id
          ORDER BY created_at DESC LIMIT 1
        )
      LEFT JOIN subscription_plans sp ON sp.id = sub.plan_id
      LEFT JOIN super_admins sa ON sa.id = t.created_by
      ORDER BY t.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('[companies/list]', err.message);
    res.status(500).json({ error: 'Failed to fetch companies' });
  }
});

// ── GET /api/super/companies/:id — single company detail ───────────────────
router.get('/:id', param('id').isUUID(), validate, async (req, res) => {
  try {
    const { rows } = await req.pool.query(`
      SELECT t.*,
        sa.name as created_by_name,
        (SELECT COUNT(*) FROM employees WHERE tenant_id=t.id AND status='active') as emp_count,
        (SELECT COUNT(*) FROM departments WHERE tenant_id=t.id) as dept_count,
        (SELECT COUNT(*) FROM attendance WHERE tenant_id=t.id) as att_count
      FROM tenants t
      LEFT JOIN super_admins sa ON sa.id = t.created_by
      WHERE t.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });

    const { rows: subs } = await req.pool.query(`
      SELECT sub.*, sp.name as plan_name, sp.code as plan_code,
             sa.name as activated_by_name
      FROM   tenant_subscriptions sub
      JOIN   subscription_plans sp ON sp.id = sub.plan_id
      LEFT JOIN super_admins sa ON sa.id = sub.activated_by
      WHERE  sub.tenant_id = $1
      ORDER  BY sub.created_at DESC
    `, [req.params.id]);

    const { rows: hist } = await req.pool.query(`
      SELECT h.*, sp.name as plan_name, sa.name as performed_by_name
      FROM   subscription_history h
      LEFT JOIN subscription_plans sp ON sp.id = h.plan_id
      LEFT JOIN super_admins sa ON sa.id = h.performed_by
      WHERE  h.tenant_id = $1
      ORDER  BY h.created_at DESC
      LIMIT  20
    `, [req.params.id]);

    res.json({ company: rows[0], subscriptions: subs, history: hist });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch company' });
  }
});

// ── POST /api/super/companies — create new company ─────────────────────────
router.post('/',
  body('name').trim().isLength({ min: 2, max: 100 }),
  body('email').isEmail().normalizeEmail(),
  body('slug').trim().isLength({ min: 2, max: 50 }).matches(/^[a-z0-9-]+$/),
  body('plan_code').isIn(['trial','monthly','quarterly','halfyearly','yearly']),
  body('admin_password').isLength({ min: 8, max: 128 }),
  validate,
  async (req, res) => {
    const { name, slug, email, phone, address,
            plan_code, admin_password,
            custom_max_emp, custom_price } = req.body;
    const client = await req.pool.connect();
    try {
      await client.query('BEGIN');

      // Get plan
      const { rows: [plan] } = await client.query(
        `SELECT * FROM subscription_plans WHERE code=$1 AND is_active=TRUE`,
        [plan_code]
      );
      if (!plan) return res.status(400).json({ error: 'Invalid or inactive plan' });

      // Create tenant
      const { rows: [tenant] } = await client.query(`
        INSERT INTO tenants (name, slug, email, phone, address, active, created_by)
        VALUES ($1,$2,$3,$4,$5,TRUE,$6)
        RETURNING id
      `, [name, slug, email, phone||null, address||null, req.actorId]);
      const tid = tenant.id;

      // Create subscription
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + plan.duration_days);
      const pricePaid = custom_price !== undefined ? custom_price : plan.price_inr;

      const { rows: [sub] } = await client.query(`
        INSERT INTO tenant_subscriptions
          (tenant_id, plan_id, status, starts_at, expires_at,
           price_paid, custom_max_emp, activated_by)
        VALUES ($1,$2,'active',NOW(),$3,$4,$5,$6)
        RETURNING id
      `, [tid, plan.id, expiresAt, pricePaid,
          custom_max_emp || null, req.actorId]);

      // Log history
      await client.query(`
        INSERT INTO subscription_history
          (tenant_id, plan_id, action, new_status, new_expires_at, price_paid, performed_by)
        VALUES ($1,$2,'created','active',$3,$4,$5)
      `, [tid, plan.id, expiresAt, pricePaid, req.actorId]);

      // Create tenant config
      await client.query(`INSERT INTO tenant_config (tenant_id) VALUES ($1)`, [tid]);

      // Create default department
      const { rows: [dept] } = await client.query(`
        INSERT INTO departments (tenant_id, name, head, color)
        VALUES ($1,'General','Admin','#10b981') RETURNING id
      `, [tid]);

      // Create company admin employee
      const hash = await bcrypt.hash(admin_password, 12);
      await client.query(`
        INSERT INTO employees
          (tenant_id, emp_code, name, email, dept_id, designation,
           salary_monthly, hourly_rate, role, password_hash)
        VALUES ($1,'EMP000',$2,$3,$4,'Company Admin',0,0,'admin',$5)
      `, [tid, `Admin - ${name}`, email, dept.id, hash]);

      // Audit
      await client.query(`
        INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, detail)
        VALUES ($1,$2,'superadmin','COMPANY_CREATED',$3)
      `, [tid, req.actorId, JSON.stringify({ name, plan_code, expires_at: expiresAt })]);

      await client.query('COMMIT');
      res.status(201).json({
        message: 'Company created successfully',
        tenant_id: tid,
        subscription_id: sub.id,
        expires_at: expiresAt,
        login_url: `${process.env.APP_URL || ''}/?company=${slug}`,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') return res.status(409).json({ error: 'Slug or email already exists' });
      console.error('[companies/create]', err.message);
      res.status(500).json({ error: 'Failed to create company' });
    } finally {
      client.release();
    }
  }
);

// ── PATCH /api/super/companies/:id/toggle — enable or disable company ──────
router.patch('/:id/toggle', param('id').isUUID(), validate, async (req, res) => {
  try {
    const { rows: [t] } = await req.pool.query(
      `UPDATE tenants SET active = NOT active, updated_at=NOW()
       WHERE id=$1 RETURNING id, name, active`, [req.params.id]
    );
    if (!t) return res.status(404).json({ error: 'Company not found' });

    await req.pool.query(`
      INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, detail)
      VALUES ($1,$2,'superadmin',$3,$4)
    `, [t.id, req.actorId,
        t.active ? 'COMPANY_ENABLED' : 'COMPANY_DISABLED',
        JSON.stringify({ name: t.name, active: t.active })]);

    res.json({ id: t.id, name: t.name, active: t.active,
               message: `Company ${t.active ? 'enabled' : 'disabled'} successfully` });
  } catch (err) {
    res.status(500).json({ error: 'Toggle failed' });
  }
});

// ── PATCH /api/super/companies/:id — update company details ────────────────
router.patch('/:id',
  param('id').isUUID(),
  body('name').optional().trim().isLength({ min: 2, max: 100 }),
  body('phone').optional().trim(),
  body('address').optional().trim(),
  validate,
  async (req, res) => {
    const { name, phone, address } = req.body;
    try {
      const { rows: [t] } = await req.pool.query(`
        UPDATE tenants SET
          name    = COALESCE($2, name),
          phone   = COALESCE($3, phone),
          address = COALESCE($4, address),
          updated_at = NOW()
        WHERE id=$1 RETURNING id, name, active
      `, [req.params.id, name, phone, address]);
      if (!t) return res.status(404).json({ error: 'Not found' });
      res.json(t);
    } catch (err) {
      res.status(500).json({ error: 'Update failed' });
    }
  }
);

// ── DELETE /api/super/companies/:id — permanently delete company ───────────
router.delete('/:id', param('id').isUUID(), validate, async (req, res) => {
  const client = await req.pool.connect();
  try {
    const { rows: [t] } = await client.query(`SELECT name FROM tenants WHERE id=$1`, [req.params.id]);
    if (!t) return res.status(404).json({ error: 'Company not found' });
    await client.query('BEGIN');
    // Delete in correct order to respect foreign keys
    await client.query(`DELETE FROM audit_log            WHERE tenant_id=$1`, [req.params.id]);
    await client.query(`DELETE FROM attendance            WHERE tenant_id=$1`, [req.params.id]);
    await client.query(`DELETE FROM leaves                WHERE tenant_id=$1`, [req.params.id]);
    await client.query(`DELETE FROM subscription_history WHERE tenant_id=$1`, [req.params.id]);
    await client.query(`DELETE FROM tenant_subscriptions WHERE tenant_id=$1`, [req.params.id]);
    await client.query(`DELETE FROM tenant_config         WHERE tenant_id=$1`, [req.params.id]);
    await client.query(`DELETE FROM employees             WHERE tenant_id=$1`, [req.params.id]);
    await client.query(`DELETE FROM departments           WHERE tenant_id=$1`, [req.params.id]);
    await client.query(`DELETE FROM tenants               WHERE id=$1`,        [req.params.id]);
    await client.query('COMMIT');
    res.json({ message: `${t.name} deleted permanently` });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[companies/delete]', err.message);
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  } finally {
    client.release();
  }
});

// ── POST /api/super/companies/:id/enter — impersonate company admin ─────────
router.post('/:id/enter', param('id').isUUID(), validate, async (req, res) => {
  const jwt = require('jsonwebtoken');
  try {
    const { rows: [emp] } = await req.pool.query(`
      SELECT e.*, t.name as tname, t.slug
      FROM   employees e
      JOIN   tenants t ON t.id = e.tenant_id
      WHERE  e.tenant_id=$1 AND e.role='admin' AND e.status='active'
      LIMIT 1
    `, [req.params.id]);
    if (!emp) return res.status(404).json({ error: 'No active admin found for this company' });

    const token = jwt.sign(
      { id: emp.id, type: 'employee', tenantId: emp.tenant_id, role: emp.role, name: emp.name, impersonated_by: req.actorId },
      process.env.JWT_SECRET,
      { expiresIn: '2h', issuer: 'attendease' }
    );

    await req.pool.query(`
      INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, detail)
      VALUES ($1,$2,'superadmin','COMPANY_ENTERED',$3)
    `, [req.params.id, req.actorId, JSON.stringify({ admin_id: emp.id, admin_email: emp.email })]);

    res.json({ token, admin: { name: emp.name, email: emp.email }, tenant: { name: emp.tname, slug: emp.slug } });
  } catch (err) {
    console.error('[companies/enter]', err.message);
    res.status(500).json({ error: 'Enter failed' });
  }
});

// ── PATCH /api/super/companies/:id/reset-password ──────────────────────────
router.patch('/:id/reset-password',
  param('id').isUUID(),
  body('new_password').isLength({ min: 8, max: 128 }),
  validate,
  async (req, res) => {
    try {
      const hash = await bcrypt.hash(req.body.new_password, 12);
      const { rowCount } = await req.pool.query(`
        UPDATE employees
        SET password_hash=$1, updated_at=NOW()
        WHERE tenant_id=$2 AND role='admin'
      `, [hash, req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'No admin found for this company' });
      await req.pool.query(`
        INSERT INTO audit_log (tenant_id, actor_id, actor_type, action, detail)
        VALUES ($1,$2,'superadmin','ADMIN_PASSWORD_RESET',$3)
      `, [req.params.id, req.actorId, JSON.stringify({ reset_by: 'superadmin' })]);
      res.json({ message: 'Admin password reset successfully' });
    } catch (err) {
      console.error('[companies/reset-password]', err.message);
      res.status(500).json({ error: 'Reset failed' });
    }
  }
);

module.exports = router;
