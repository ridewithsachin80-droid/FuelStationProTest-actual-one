require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const morgan      = require('morgan');
const compression = require('compression');
const path        = require('path');
const { Pool }    = require('pg');
const rateLimit   = require('express-rate-limit');

// ── DB Pool ───────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});
pool.on('error', err => console.error('[pg] Idle error:', err.message));

const app = express();

// ── SECURITY HEADERS ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'", "'unsafe-inline'", "cdnjs.cloudflare.com", "unpkg.com"],
      scriptSrcAttr:  ["'unsafe-inline'"],
      styleSrc:       ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
      fontSrc:        ["'self'", "fonts.gstatic.com"],
      imgSrc:         ["'self'", "data:", "blob:"],
      connectSrc:     ["'self'"],
      frameSrc:       ["'none'"],
      objectSrc:      ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
app.use('/api/auth',        rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: 'Too many login attempts.' } }));
app.use('/api/super/auth',  rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: 'Too many login attempts.' } }));
app.use('/api',             rateLimit({ windowMs: 15*60*1000, max: 500, message: { error: 'Rate limit exceeded.' } }));

// ── BODY PARSING ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(compression());

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// ── INJECT POOL ───────────────────────────────────────────────────────────────
app.use((req, _res, next) => { req.pool = pool; next(); });

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── PUBLIC PLANS (no auth needed — for pricing page) ─────────────────────────
app.get('/api/plans/public', async (req, res) => {
  const { rows } = await pool.query(`
    SELECT id,name,code,duration_days,price_inr,max_employees,
           max_departments,features,description,sort_order
    FROM subscription_plans WHERE is_active=TRUE ORDER BY sort_order
  `);
  res.json(rows);
});

// ── SUPER ADMIN ROUTES ────────────────────────────────────────────────────────
app.use('/api/super/auth',      require('./routes/superauth'));
app.use('/api/super/dashboard', require('./routes/superdashboard'));
app.use('/api/super/companies', require('./routes/companies'));
app.use('/api/super/plans',     require('./routes/plans'));

// ── COMPANY / EMPLOYEE ROUTES ─────────────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/attendance',  require('./routes/attendance'));
app.use('/api/employees',   require('./routes/employees'));
app.use('/api/departments', require('./routes/departments'));
app.use('/api/leaves',      require('./routes/leaves'));
app.use('/api/salary',      require('./routes/salary'));
app.use('/api/reports',     require('./routes/reports'));
app.use('/api/config',      require('./routes/config'));

// ── STATIC FRONTEND ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../public'), {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));

// SPA catch-all (serves index.html for all non-API routes)
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, '../public/index.html'))
);

// ── GLOBAL ERROR HANDLER ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`[server] AttendEase v2 running on :${PORT} [${process.env.NODE_ENV || 'development'}]`)
);

module.exports = app;
