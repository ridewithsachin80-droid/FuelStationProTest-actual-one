const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

const validate = (req, res, next) => {
  const e = validationResult(req);
  if (!e.isEmpty()) return res.status(400).json({ errors: e.array() });
  next();
};

// Public — any logged-in user can view active plans
router.get('/public', async (req, res) => {
  const { rows } = await req.pool.query(`
    SELECT id, name, code, duration_days, price_inr, max_employees,
           max_departments, features, description, sort_order
    FROM   subscription_plans
    WHERE  is_active = TRUE
    ORDER  BY sort_order
  `);
  res.json(rows);
});

// Super admin only below
router.use(requireAuth, requireSuperAdmin);

// ── GET /api/super/plans — all plans including inactive ─────────────────────
router.get('/', async (req, res) => {
  const { rows } = await req.pool.query(`
    SELECT sp.*, sa.name as created_by_name,
      (SELECT COUNT(*) FROM tenant_subscriptions sub
       WHERE sub.plan_id = sp.id AND sub.status='active') as active_companies
    FROM   subscription_plans sp
    LEFT JOIN super_admins sa ON sa.id = sp.created_by
    ORDER  BY sp.sort_order, sp.created_at
  `);
  res.json(rows);
});

// ── POST /api/super/plans — create new plan (including custom) ──────────────
router.post('/',
  body('name').trim().isLength({ min: 2, max: 100 }),
  body('code').trim().isLength({ min: 2, max: 50 }).matches(/^[a-z0-9_-]+$/),
  body('duration_days').isInt({ min: 1 }),
  body('price_inr').isFloat({ min: 0 }),
  body('max_employees').isInt({ min: 1 }),
  body('max_departments').optional().isInt({ min: 1 }),
  validate,
  async (req, res) => {
    const {
      name, code, duration_days, price_inr, max_employees,
      max_departments = 10, features = {}, description,
      sort_order = 99, is_custom = false,
    } = req.body;
    try {
      const { rows: [plan] } = await req.pool.query(`
        INSERT INTO subscription_plans
          (name, code, duration_days, price_inr, max_employees,
           max_departments, features, description, sort_order,
           is_custom, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
      `, [name, code, duration_days, price_inr, max_employees,
          max_departments, JSON.stringify(features), description,
          sort_order, is_custom, req.actorId]);
      res.status(201).json(plan);
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'Plan code already exists' });
      res.status(500).json({ error: 'Failed to create plan' });
    }
  }
);

// ── PUT /api/super/plans/:id — update plan ───────────────────────────────────
router.put('/:id',
  param('id').isUUID(),
  body('name').optional().trim().isLength({ min: 2 }),
  body('duration_days').optional().isInt({ min: 1 }),
  body('price_inr').optional().isFloat({ min: 0 }),
  body('max_employees').optional().isInt({ min: 1 }),
  validate,
  async (req, res) => {
    const {
      name, duration_days, price_inr, max_employees,
      max_departments, features, description, sort_order, is_active,
    } = req.body;
    try {
      const { rows: [plan] } = await req.pool.query(`
        UPDATE subscription_plans SET
          name            = COALESCE($2, name),
          duration_days   = COALESCE($3, duration_days),
          price_inr       = COALESCE($4, price_inr),
          max_employees   = COALESCE($5, max_employees),
          max_departments = COALESCE($6, max_departments),
          features        = COALESCE($7, features),
          description     = COALESCE($8, description),
          sort_order      = COALESCE($9, sort_order),
          is_active       = COALESCE($10, is_active),
          updated_at      = NOW()
        WHERE id = $1
        RETURNING *
      `, [req.params.id, name, duration_days, price_inr, max_employees,
          max_departments, features ? JSON.stringify(features) : null,
          description, sort_order, is_active]);
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      res.json(plan);
    } catch (err) {
      res.status(500).json({ error: 'Update failed' });
    }
  }
);

// ── POST /api/super/plans/assign — assign/renew a plan for a company ────────
router.post('/assign',
  body('tenant_id').isUUID(),
  body('plan_id').isUUID(),
  body('price_paid').optional().isFloat({ min: 0 }),
  body('custom_max_emp').optional().isInt({ min: 1 }),
  body('custom_features').optional().isObject(),
  body('action').isIn(['new','renew','upgrade','downgrade']),
  body('notes').optional().isString().trim().isLength({ max: 500 }),
  validate,
  async (req, res) => {
    const {
      tenant_id, plan_id, action, notes,
      price_paid, custom_max_emp, custom_features,
    } = req.body;
    const client = await req.pool.connect();
    try {
      await client.query('BEGIN');

      // Get plan
      const { rows: [plan] } = await client.query(
        `SELECT * FROM subscription_plans WHERE id=$1`, [plan_id]
      );
      if (!plan) return res.status(404).json({ error: 'Plan not found' });

      // Get current active subscription
      const { rows: [current] } = await client.query(
        `SELECT * FROM tenant_subscriptions
         WHERE tenant_id=$1 AND status='active' LIMIT 1`,
        [tenant_id]
      );

      // Calculate new expiry
      let startsAt = new Date();
      if (action === 'renew' && current && new Date(current.expires_at) > new Date()) {
        // Renew extends from current expiry
        startsAt = new Date(current.expires_at);
      }
      const expiresAt = new Date(startsAt);
      expiresAt.setDate(expiresAt.getDate() + plan.duration_days);

      // Expire old subscription if exists
      if (current) {
        await client.query(
          `UPDATE tenant_subscriptions SET status='cancelled', updated_at=NOW()
           WHERE id=$1`, [current.id]
        );
      }

      // Create new subscription
      const { rows: [sub] } = await client.query(`
        INSERT INTO tenant_subscriptions
          (tenant_id, plan_id, status, starts_at, expires_at,
           price_paid, custom_max_emp, custom_features, notes, activated_by)
        VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
      `, [tenant_id, plan_id, startsAt, expiresAt,
          price_paid ?? plan.price_inr,
          custom_max_emp || null,
          custom_features ? JSON.stringify(custom_features) : null,
          notes || null, req.actorId]);

      // Log history
      await client.query(`
        INSERT INTO subscription_history
          (tenant_id, plan_id, action, old_status, new_status,
           old_expires_at, new_expires_at, price_paid, performed_by, notes)
        VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9)
      `, [tenant_id, plan_id, action,
          current ? current.status : null,
          current ? current.expires_at : null,
          expiresAt, price_paid ?? plan.price_inr,
          req.actorId, notes || null]);

      await client.query('COMMIT');
      res.json({
        message: `Plan ${action} successful`,
        subscription: sub,
        expires_at: expiresAt,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[plans/assign]', err.message);
      res.status(500).json({ error: 'Plan assignment failed' });
    } finally {
      client.release();
    }
  }
);

// ── POST /api/super/plans/suspend/:subId — suspend a subscription ────────────
router.post('/suspend/:subId',
  param('subId').isUUID(),
  body('notes').optional().isString(),
  validate,
  async (req, res) => {
    try {
      const { rows: [sub] } = await req.pool.query(`
        UPDATE tenant_subscriptions
        SET status='suspended', notes=$2, updated_at=NOW()
        WHERE id=$1 RETURNING tenant_id, plan_id
      `, [req.params.subId, req.body.notes || null]);
      if (!sub) return res.status(404).json({ error: 'Subscription not found' });

      await req.pool.query(`
        INSERT INTO subscription_history
          (tenant_id, plan_id, action, old_status, new_status, performed_by, notes)
        VALUES ($1,$2,'suspended','active','suspended',$3,$4)
      `, [sub.tenant_id, sub.plan_id, req.actorId, req.body.notes || null]);

      res.json({ message: 'Subscription suspended' });
    } catch (err) {
      res.status(500).json({ error: 'Suspend failed' });
    }
  }
);

// ── GET /api/super/plans/expiring — companies expiring in next N days ────────
router.get('/expiring', async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const { rows } = await req.pool.query(`
    SELECT t.id, t.name, t.email, t.active,
           sub.expires_at, sp.name as plan_name, sp.code as plan_code,
           sub.status as sub_status
    FROM   tenant_subscriptions sub
    JOIN   tenants t ON t.id = sub.tenant_id
    JOIN   subscription_plans sp ON sp.id = sub.plan_id
    WHERE  sub.status = 'active'
      AND  sub.expires_at BETWEEN NOW() AND NOW() + ($1 || ' days')::INTERVAL
    ORDER  BY sub.expires_at
  `, [days]);
  res.json(rows);
});

module.exports = router;
