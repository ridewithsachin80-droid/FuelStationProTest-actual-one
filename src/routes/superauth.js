const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

// POST /api/super/auth/login
router.post('/login',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6, max: 128 }),
  async (req, res) => {
    const errs = validationResult(req);
    if (!errs.isEmpty()) return res.status(400).json({ error: 'Invalid credentials' });

    const { email, password } = req.body;
    try {
      const { rows } = await req.pool.query(
        `SELECT * FROM super_admins WHERE email = $1 AND active = TRUE LIMIT 1`,
        [email]
      );
      const admin = rows[0];
      const dummy = '$2a$12$invalidhashtopreventtimingattacksxxxxxxxxxxxxxxxxxxxxxxxxxx';
      const valid = await bcrypt.compare(password, admin ? admin.password_hash : dummy);

      if (!admin || !valid) {
        if (admin) {
          const fails = admin.failed_logins + 1;
          const locked = fails >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
          await req.pool.query(
            `UPDATE super_admins SET failed_logins=$1, locked_until=$2 WHERE id=$3`,
            [fails, locked, admin.id]
          );
        }
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
        const mins = Math.ceil((new Date(admin.locked_until) - Date.now()) / 60000);
        return res.status(423).json({ error: `Account locked. Try again in ${mins} min.` });
      }

      await req.pool.query(
        `UPDATE super_admins SET failed_logins=0, locked_until=NULL, last_login=NOW() WHERE id=$1`,
        [admin.id]
      );

      // Audit
      await req.pool.query(
        `INSERT INTO audit_log (actor_id, actor_type, action, ip_address, user_agent)
         VALUES ($1,'superadmin','SUPER_LOGIN',$2::INET,$3)`,
        [admin.id, req.ip || '0.0.0.0', req.headers['user-agent'] || '']
      );

      const token = jwt.sign(
        { id: admin.id, type: 'superadmin', role: admin.role, name: admin.name },
        process.env.JWT_SECRET,
        { expiresIn: '12h', issuer: 'attendease-super' }
      );

      res.json({
        token,
        admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
        type: 'superadmin',
      });
    } catch (err) {
      console.error('[super/login]', err.message);
      res.status(500).json({ error: 'Login failed' });
    }
  }
);

// GET /api/super/auth/me
router.get('/me', requireAuth, requireSuperAdmin, async (req, res) => {
  const { rows } = await req.pool.query(
    `SELECT id, name, email, role, last_login, created_at FROM super_admins WHERE id=$1`,
    [req.actorId]
  );
  res.json(rows[0] || {});
});

// POST /api/super/auth/logout
router.post('/logout', requireAuth, requireSuperAdmin, async (req, res) => {
  await req.pool.query(
    `INSERT INTO audit_log (actor_id, actor_type, action, ip_address) VALUES ($1,'superadmin','SUPER_LOGOUT',$2::INET)`,
    [req.actorId, req.ip || '0.0.0.0']
  );
  res.json({ message: 'Logged out' });
});

module.exports = router;
