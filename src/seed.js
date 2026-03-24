require('dotenv').config();
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

async function seed() {
  const client = await pool.connect();
  try {
    console.log('[seed] Seeding default data...');
    await client.query('BEGIN');

    // ── 1. SUPER ADMIN ───────────────────────────────────────────────────────
    const saHash = await bcrypt.hash('SuperAdmin@123', 12);
    const { rows: [sa] } = await client.query(`
      INSERT INTO super_admins (name, email, password_hash, role)
      VALUES ('Platform Admin', 'superadmin@attendease.com', $1, 'superadmin')
      ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `, [saHash]);
    const saId = sa.id;
    console.log('  [seed] ✓ Super admin created  →  superadmin@attendease.com / SuperAdmin@123');

    // ── 2. DEFAULT SUBSCRIPTION PLANS ────────────────────────────────────────
    const plans = [
      {
        name: 'Trial', code: 'trial', duration_days: 14,
        price_inr: 0, max_employees: 10, max_departments: 3,
        description: 'Free 14-day trial. No credit card required.',
        sort_order: 1,
        features: { qr_attendance: true, gps: false, reports: false, api_access: false },
      },
      {
        name: 'Monthly', code: 'monthly', duration_days: 30,
        price_inr: 999, max_employees: 100, max_departments: 10,
        description: 'Billed every month. Cancel anytime.',
        sort_order: 2,
        features: { qr_attendance: true, gps: true, reports: true, api_access: false },
      },
      {
        name: 'Quarterly', code: 'quarterly', duration_days: 90,
        price_inr: 2699, max_employees: 200, max_departments: 20,
        description: '10% savings vs monthly. Billed every 3 months.',
        sort_order: 3,
        features: { qr_attendance: true, gps: true, reports: true, api_access: false },
      },
      {
        name: 'Half Yearly', code: 'halfyearly', duration_days: 180,
        price_inr: 4999, max_employees: 500, max_departments: 50,
        description: '17% savings vs monthly. Billed every 6 months.',
        sort_order: 4,
        features: { qr_attendance: true, gps: true, reports: true, api_access: true },
      },
      {
        name: 'Yearly', code: 'yearly', duration_days: 365,
        price_inr: 8999, max_employees: 1000, max_departments: 100,
        description: '25% savings vs monthly. Best value. Priority support.',
        sort_order: 5,
        features: { qr_attendance: true, gps: true, reports: true, api_access: true, priority_support: true },
      },
    ];

    const planIds = {};
    for (const p of plans) {
      const { rows: [plan] } = await client.query(`
        INSERT INTO subscription_plans
          (name, code, duration_days, price_inr, max_employees, max_departments,
           features, description, sort_order, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (code) DO UPDATE SET
          name=$1, duration_days=$3, price_inr=$4,
          max_employees=$5, max_departments=$6,
          features=$7, description=$8, sort_order=$9
        RETURNING id, code
      `, [p.name, p.code, p.duration_days, p.price_inr,
          p.max_employees, p.max_departments,
          JSON.stringify(p.features), p.description, p.sort_order, saId]);
      planIds[plan.code] = plan.id;
      console.log(`  [seed] ✓ Plan: ${p.name} (₹${p.price_inr}/${p.duration_days}d)`);
    }

    // ── 3. SAMPLE COMPANIES ───────────────────────────────────────────────────
    const companies = [
      { name: 'Acme Corp',      slug: 'acme-corp',   email: 'admin@acme.com',   plan: 'yearly',    pay: 8999 },
      { name: 'Globex Inc',     slug: 'globex-inc',  email: 'admin@globex.com', plan: 'monthly',   pay: 999  },
      { name: 'Initech Systems',slug: 'initech',     email: 'admin@initech.com',plan: 'trial',     pay: 0    },
    ];

    const adminHash = await bcrypt.hash('Admin@1234', 12);
    const empHash   = await bcrypt.hash('Emp@1234',   12);

    for (const co of companies) {
      // Create tenant
      const { rows: [tenant] } = await client.query(`
        INSERT INTO tenants (name, slug, email, active, created_by)
        VALUES ($1,$2,$3,TRUE,$4)
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `, [co.name, co.slug, co.email, saId]);
      const tid = tenant.id;

      // Create subscription
      const expiresAt = new Date();
      const plan = plans.find(p => p.code === co.plan);
      expiresAt.setDate(expiresAt.getDate() + plan.duration_days);

      await client.query(`
        INSERT INTO tenant_subscriptions
          (tenant_id, plan_id, status, starts_at, expires_at, price_paid, activated_by)
        VALUES ($1,$2,'active',NOW(),$3,$4,$5)
        ON CONFLICT DO NOTHING
      `, [tid, planIds[co.plan], expiresAt, co.pay, saId]);

      // Log subscription history
      await client.query(`
        INSERT INTO subscription_history
          (tenant_id, plan_id, action, new_status, new_expires_at, price_paid, performed_by)
        VALUES ($1,$2,'created','active',$3,$4,$5)
      `, [tid, planIds[co.plan], expiresAt, co.pay, saId]);

      // Create tenant_config
      await client.query(`
        INSERT INTO tenant_config (tenant_id) VALUES ($1)
        ON CONFLICT (tenant_id) DO NOTHING
      `, [tid]);

      // Create departments
      const depts = ['Engineering','Design','Marketing','HR','Finance'];
      const deptIds = [];
      for (const dname of depts) {
        const { rows: [d] } = await client.query(`
          INSERT INTO departments (tenant_id, name) VALUES ($1,$2)
          ON CONFLICT DO NOTHING RETURNING id
        `, [tid, dname]);
        if (d) deptIds.push(d.id);
      }

      // Create admin user
      await client.query(`
        INSERT INTO employees
          (tenant_id, emp_code, name, email, designation, salary_monthly,
           hourly_rate, role, password_hash, dept_id)
        VALUES ($1,'EMP000',$2,$3,'Company Admin',60000,600,'admin',$4,$5)
        ON CONFLICT (tenant_id, emp_code) DO NOTHING
      `, [tid, `Admin - ${co.name}`, co.email, adminHash, deptIds[0]]);

      // Create 5 sample employees
      const names = ['Rahul Sharma','Priya Patel','Amit Kumar','Sneha Reddy','Vikram Singh'];
      for (let i = 0; i < 5; i++) {
        const code = `EMP${String(i+1).padStart(3,'0')}`;
        const email = `${code.toLowerCase()}@${co.slug}.com`;
        await client.query(`
          INSERT INTO employees
            (tenant_id, emp_code, name, email, dept_id, salary_monthly,
             hourly_rate, role, password_hash)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'employee',$8)
          ON CONFLICT (tenant_id, emp_code) DO NOTHING
        `, [tid, code, names[i], email, deptIds[i % deptIds.length],
            30000 + i*3000, (30000 + i*3000)/160, empHash]);
      }

      console.log(`  [seed] ✓ ${co.name}  →  plan: ${co.plan}  expires: ${expiresAt.toDateString()}`);
    }

    await client.query('COMMIT');
    console.log('\n[seed] Complete!\n');
    console.log('  Super Admin  →  superadmin@attendease.com  /  SuperAdmin@123');
    console.log('  Company Admin →  admin@acme.com             /  Admin@1234');
    console.log('  Employee      →  EMP001@acme-corp.com       /  Emp@1234\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[seed] FAILED:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(() => process.exit(1));
