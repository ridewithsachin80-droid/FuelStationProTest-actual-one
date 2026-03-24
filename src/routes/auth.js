// ── routes/auth.js ────────────────────────────────────────────────────────────
const authRouter = require('express').Router();
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');

authRouter.post('/login',
  body('email').notEmpty().trim(),
  body('password').isLength({ min: 6, max: 128 }),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ error: 'Invalid credentials' });
    const { email: identifier, password } = req.body;
    try {
      // Support login by email OR employee code (e.g. EMP001)
      const { rows } = await req.pool.query(`
        SELECT e.*, t.id as tid, t.name as tname, t.slug, t.active as tactive
        FROM   employees e
        JOIN   tenants t ON t.id = e.tenant_id
        WHERE  (LOWER(e.email)=LOWER($1) OR UPPER(e.emp_code)=UPPER($1))
          AND  e.status='active' AND t.active=TRUE
        LIMIT  1
      `, [identifier]);
      const emp = rows[0];
      const dummy = '$2a$12$invalidhashtopreventtimingattacksxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const valid = await bcrypt.compare(password, emp ? emp.password_hash : dummy);
      if (!emp || !valid) {
        if (emp) {
          const fails = emp.failed_logins + 1;
          const locked = fails >= 5 ? new Date(Date.now() + 15*60*1000) : null;
          await req.pool.query(`UPDATE employees SET failed_logins=$1,locked_until=$2 WHERE id=$3`,[fails,locked,emp.id]);
        }
        return res.status(401).json({ error: 'Invalid email or password' });
      }
      if (emp.locked_until && new Date(emp.locked_until) > new Date()) {
        const mins = Math.ceil((new Date(emp.locked_until)-Date.now())/60000);
        return res.status(423).json({ error: `Account locked. Try again in ${mins} minute(s).` });
      }

      // Check subscription
      const { rows: [sub] } = await req.pool.query(`
        SELECT sub.status, sub.expires_at, sp.name as plan_name
        FROM   tenant_subscriptions sub
        JOIN   subscription_plans sp ON sp.id = sub.plan_id
        WHERE  sub.tenant_id=$1 AND sub.status='active' LIMIT 1
      `, [emp.tid]);
      if (!sub) return res.status(402).json({ error: 'Company subscription expired. Contact your administrator.' });
      if (new Date(sub.expires_at) < new Date()) return res.status(402).json({ error: 'Subscription expired. Please renew.' });

      await req.pool.query(`UPDATE employees SET failed_logins=0,locked_until=NULL WHERE id=$1`,[emp.id]);
      await req.pool.query(`INSERT INTO audit_log (tenant_id,actor_id,actor_type,action,ip_address,user_agent) VALUES ($1,$2,'employee','LOGIN',$3::INET,$4)`,
        [emp.tid,emp.id,req.ip||'0.0.0.0',req.headers['user-agent']||'']);

      const token = jwt.sign(
        { id: emp.id, type:'employee', tenantId:emp.tid, role:emp.role, name:emp.name },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES||'8h', issuer:'attendease' }
      );
      res.json({
        token, type:'employee',
        user: { id:emp.id, name:emp.name, email:emp.email, role:emp.role, empCode:emp.emp_code },
        tenant: { id:emp.tid, name:emp.tname, slug:emp.slug },
        subscription: { plan: sub.plan_name, expires_at: sub.expires_at },
      });
    } catch(err) { console.error('[auth/login]',err.message); res.status(500).json({ error:'Login failed' }); }
  }
);

authRouter.get('/me', requireAuth, async (req, res) => {
  if (req.actorType === 'superadmin') {
    const { rows } = await req.pool.query(`SELECT id,name,email,role FROM super_admins WHERE id=$1`,[req.actorId]);
    return res.json({ ...rows[0], type:'superadmin' });
  }
  const { rows } = await req.db.query(`
    SELECT e.id,e.emp_code,e.name,e.email,e.role,e.designation,e.dept_id,
           e.salary_monthly,e.hourly_rate,e.leave_quota,e.joined_date,e.phone,
           d.name as dept_name
    FROM   employees e LEFT JOIN departments d ON d.id=e.dept_id
    WHERE  e.id=$1
  `,[req.actorId]);
  res.json({ ...rows[0], type:'employee' });
});

authRouter.post('/logout', requireAuth, async (req, res) => {
  const pool = req.actorType === 'superadmin' ? req.pool : req.db;
  await pool.query(`INSERT INTO audit_log (tenant_id,actor_id,actor_type,action,ip_address) VALUES ($1,$2,$3,'LOGOUT',$4::INET)`,
    [req.tenantId||null,req.actorId,req.actorType,req.ip||'0.0.0.0']);
  res.json({ message:'Logged out' });
});

module.exports = authRouter;
