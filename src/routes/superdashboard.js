const router = require('express').Router();
const { requireAuth, requireSuperAdmin } = require('../middleware/auth');

router.use(requireAuth, requireSuperAdmin);

// GET /api/super/dashboard
router.get('/', async (req, res) => {
  try {
    const [companies, subs, revenue, expiring, planDist] = await Promise.all([
      // Company stats
      req.pool.query(`
        SELECT
          COUNT(*)                                        as total,
          COUNT(*) FILTER (WHERE active=TRUE)            as active,
          COUNT(*) FILTER (WHERE active=FALSE)           as disabled,
          COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as new_this_month
        FROM tenants
      `),
      // Subscription stats
      req.pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status='active')    as active,
          COUNT(*) FILTER (WHERE status='expired')   as expired,
          COUNT(*) FILTER (WHERE status='suspended') as suspended,
          COUNT(*) FILTER (
            WHERE status='active' AND expires_at < NOW() + INTERVAL '7 days'
          ) as expiring_soon
        FROM tenant_subscriptions
      `),
      // Revenue this month
      req.pool.query(`
        SELECT
          COALESCE(SUM(price_paid),0) as total_revenue,
          COALESCE(SUM(price_paid) FILTER (
            WHERE created_at > NOW() - INTERVAL '30 days'
          ),0) as revenue_this_month,
          COALESCE(SUM(price_paid) FILTER (
            WHERE created_at > NOW() - INTERVAL '7 days'
          ),0) as revenue_this_week
        FROM tenant_subscriptions
        WHERE status IN ('active','expired')
      `),
      // Expiring soon (next 7 days)
      req.pool.query(`
        SELECT t.name, t.email, sub.expires_at, sp.name as plan_name
        FROM   tenant_subscriptions sub
        JOIN   tenants t ON t.id = sub.tenant_id
        JOIN   subscription_plans sp ON sp.id = sub.plan_id
        WHERE  sub.status='active'
          AND  sub.expires_at BETWEEN NOW() AND NOW() + INTERVAL '7 days'
        ORDER  BY sub.expires_at
        LIMIT  10
      `),
      // Plan distribution
      req.pool.query(`
        SELECT sp.name, sp.code, COUNT(sub.id) as companies
        FROM   subscription_plans sp
        LEFT JOIN tenant_subscriptions sub
          ON sub.plan_id = sp.id AND sub.status = 'active'
        GROUP BY sp.id, sp.name, sp.code
        ORDER BY sp.sort_order
      `),
    ]);

    res.json({
      companies:    companies.rows[0],
      subscriptions: subs.rows[0],
      revenue:       revenue.rows[0],
      expiring_soon: expiring.rows,
      plan_distribution: planDist.rows,
      generated_at:  new Date().toISOString(),
    });
  } catch (err) {
    console.error('[super/dashboard]', err.message);
    res.status(500).json({ error: 'Dashboard failed' });
  }
});

// GET /api/super/dashboard/activity — recent audit log
router.get('/activity', async (req, res) => {
  const { rows } = await req.pool.query(`
    SELECT al.*, t.name as tenant_name,
      CASE
        WHEN al.actor_type='superadmin' THEN sa.name
        ELSE e.name
      END as actor_name
    FROM   audit_log al
    LEFT JOIN tenants      t  ON t.id  = al.tenant_id
    LEFT JOIN super_admins sa ON sa.id = al.actor_id AND al.actor_type='superadmin'
    LEFT JOIN employees    e  ON e.id  = al.actor_id AND al.actor_type='employee'
    ORDER  BY al.created_at DESC
    LIMIT  50
  `);
  res.json(rows);
});

module.exports = router;
