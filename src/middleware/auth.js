const jwt = require('jsonwebtoken');

// ── requireAuth ────────────────────────────────────────────────────────────
// Verifies JWT for BOTH super admins and company employees.
// Sets req.tenantId, req.actorId, req.role, req.actorType
// For company employees: also sets PostgreSQL RLS tenant context.

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  let payload;
  try {
    payload = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({
      error: err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token',
    });
  }

  req.actorId   = payload.id;
  req.actorType = payload.type;       // 'superadmin' | 'employee'
  req.role      = payload.role;       // 'superadmin'|'support' | 'admin'|'hr'|'employee'
  req.tenantId  = payload.tenantId;   // undefined for super admins
  req.name      = payload.name;

  // Company employee — acquire DB client and set RLS tenant context
  if (payload.type === 'employee') {
    if (!payload.tenantId) return res.status(401).json({ error: 'Invalid token: missing tenant' });

    try {
      req.db = await req.pool.connect();
      await req.db.query(`SELECT set_config('app.tenant_id', $1, TRUE)`, [payload.tenantId]);
    } catch {
      return res.status(503).json({ error: 'Database unavailable' });
    }

    const release = () => { if (req.db) { req.db.release(); req.db = null; } };
    res.on('finish', release);
    res.on('close',  release);

    // Check tenant is still active and subscription valid
    try {
      const { rows } = await req.db.query(`
        SELECT t.active,
               sub.status as sub_status,
               sub.expires_at
        FROM   tenants t
        LEFT JOIN tenant_subscriptions sub
          ON sub.tenant_id = t.id AND sub.status = 'active'
        WHERE  t.id = $1
        LIMIT  1
      `, [payload.tenantId]);

      const tenant = rows[0];
      if (!tenant || !tenant.active) {
        return res.status(403).json({ error: 'Your company account has been disabled. Contact support.' });
      }
      if (!tenant.sub_status || new Date(tenant.expires_at) < new Date()) {
        return res.status(402).json({ error: 'Subscription expired. Please ask your admin to renew.' });
      }
    } catch (err) {
      console.error('[auth] Tenant check failed:', err.message);
    }
  }

  // Super admin — use pool directly (no RLS context needed)
  if (payload.type === 'superadmin') {
    req.db = req.pool; // super admin queries use pool directly
  }

  next();
}

// ── requireSuperAdmin ──────────────────────────────────────────────────────
function requireSuperAdmin(req, res, next) {
  if (req.actorType !== 'superadmin') {
    return res.status(403).json({ error: 'Super admin access required' });
  }
  next();
}

// ── requireRole ────────────────────────────────────────────────────────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ── requireActiveSubscription ──────────────────────────────────────────────
// Middleware to block actions if subscription feature is not included in plan
function requireFeature(featureKey) {
  return async (req, res, next) => {
    if (req.actorType === 'superadmin') return next();
    try {
      const { rows } = await req.db.query(`
        SELECT sp.features, sp.max_employees,
               COALESCE(sub.custom_features, sp.features) as eff_features,
               COALESCE(sub.custom_max_emp, sp.max_employees) as eff_max_emp
        FROM   tenant_subscriptions sub
        JOIN   subscription_plans   sp ON sp.id = sub.plan_id
        WHERE  sub.tenant_id = $1 AND sub.status = 'active'
        LIMIT  1
      `, [req.tenantId]);
      if (!rows.length) return res.status(402).json({ error: 'No active subscription' });
      const features = rows[0].eff_features || {};
      if (!features[featureKey]) {
        return res.status(402).json({ error: `Feature '${featureKey}' not included in your plan. Upgrade to access.` });
      }
      req.planLimits = { max_employees: rows[0].eff_max_emp };
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireAuth, requireSuperAdmin, requireRole, requireFeature };
