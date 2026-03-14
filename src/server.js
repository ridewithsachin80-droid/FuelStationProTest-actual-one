const express = require('express');
const path = require('path');
const { initDatabase, healthCheck, closePool } = require('./schema');
const DataService = require('./data');
const { hashPin, verifyPin } = require('./auth');
const { RateLimiter, BruteForceProtection, validateRequired } = require('./security');

// Enhanced features
const AlertsSystem = require('./alerts');
const ShiftCloseService = require('./shift-close');
const ReportsService = require('./reports');
const whatsapp = require('./whatsapp');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database and services
let db;
let dataService;
let alertsSystem;
let shiftCloseService;
let reportsService;

(async () => {
  try {
    console.log('[Server] Initializing FuelStation Pro...');
    
    // Initialize database
    db = await initDatabase();
    dataService = new DataService(db);
    
    // Initialize enhanced services
    alertsSystem = new AlertsSystem(db);
    shiftCloseService = new ShiftCloseService(db);
    reportsService = new ReportsService(db);
    
    // Make services available to routes
    app.locals.db = db;
    app.locals.dataService = dataService;
    app.locals.alertsSystem = alertsSystem;
    app.locals.shiftCloseService = shiftCloseService;
    app.locals.reportsService = reportsService;
    
    console.log('[Server] Enhanced services initialized ✓');
    
    // Start alert monitoring
    alertsSystem.start();
    console.log('[Server] Alert monitoring started ✓');
    
  } catch (error) {
    console.error('[Server] Initialization error:', error);
    process.exit(1);
  }
})();

// ============================================================================
// SECURITY
// ============================================================================

const rateLimiter = new RateLimiter(5000, 60000); // 5000 requests per minute
const bruteForce = new BruteForceProtection(5, 15 * 60 * 1000); // 5 attempts, 15 min lockout

app.use(rateLimiter.middleware());

// ============================================================================
// HEALTH CHECK (ENHANCED)
// ============================================================================

app.get('/api/health', async (req, res) => {
  const health = await healthCheck();
  res.json(health);
});

app.get('/api/health/detailed', async (req, res) => {
  try {
    const dbHealth = await healthCheck();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      },
      database: dbHealth,
      features: {
        smartAlerts: true,
        shiftClose: true,
        reports: true,
        whatsapp: whatsapp.isConfigured(),
        autosave: true
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

// ============================================================================
// TENANT ROUTES
// ============================================================================

app.get('/api/public/tenants/:tenantId', async (req, res) => {
  try {
    const tenant = await dataService.getTenant(req.params.tenantId);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    res.json(tenant);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// EMPLOYEE ROUTES
// ============================================================================

app.get('/api/public/employees/:tenantId', async (req, res) => {
  try {
    const employees = await dataService.getEmployees(req.params.tenantId);
    res.json(employees);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/public/employees/:tenantId', async (req, res) => {
  try {
    const { name, role, shift, phone, pin } = req.body;
    
    const missing = validateRequired(req.body, ['name', 'phone', 'pin']);
    if (missing.length > 0) {
      return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
    }
    
    const pin_hash = await hashPin(pin);
    const employee = await dataService.createEmployee(req.params.tenantId, {
      name, role, shift, phone, pin_hash
    });
    
    res.json(employee);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/public/employees/:tenantId/verify', async (req, res) => {
  try {
    const { employeeId, pin } = req.body;
    
    const employee = await dataService.getEmployee(req.params.tenantId, employeeId);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    
    const bruteCheck = bruteForce.recordAttempt(`emp-${employeeId}`, false);
    if (!bruteCheck.allowed) {
      return res.status(429).json({
        error: 'Too many failed attempts',
        lockedUntil: bruteCheck.lockedUntil,
        remainingMs: bruteCheck.remainingMs
      });
    }
    
    const valid = await verifyPin(pin, employee.pin_hash);
    if (valid) {
      bruteForce.recordAttempt(`emp-${employeeId}`, true);
      res.json({ success: true, employee });
    } else {
      res.status(401).json({ error: 'Invalid PIN' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// SALES ROUTES
// ============================================================================

app.post('/api/public/sales/:tenantId', async (req, res) => {
  try {
    const sale = await dataService.createSale(req.params.tenantId, req.body);
    
    // Log to audit
    await dataService.logAction(
      req.params.tenantId,
      'sale',
      'create',
      { saleId: sale.id, amount: sale.amount },
      req.body.employee_id,
      req.ip
    );
    
    res.json(sale);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/public/sales/:tenantId', async (req, res) => {
  try {
    const sales = await dataService.getSales(req.params.tenantId, req.query);
    res.json(sales);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// TANK & PUMP ROUTES
// ============================================================================

app.get('/api/public/tanks/:tenantId', async (req, res) => {
  try {
    const tanks = await dataService.getTanks(req.params.tenantId);
    res.json(tanks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/public/pumps/:tenantId', async (req, res) => {
  try {
    const pumps = await dataService.getPumps(req.params.tenantId);
    res.json(pumps);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// SHIFT CLOSE (ENHANCED - ONE-TAP)
// ============================================================================

app.post('/api/public/auto-close-shift/:tenantId', async (req, res) => {
  try {
    const { employeeId, shift, date } = req.body;
    
    const result = await shiftCloseService.autoCloseShift(
      req.params.tenantId,
      employeeId,
      shift,
      date
    );
    
    // Send WhatsApp notification
    if (whatsapp.isConfigured() && result.report) {
      try {
        await whatsapp.sendShiftSummary(result.report, req.params.tenantId);
      } catch (error) {
        console.error('[WhatsApp] Failed to send shift summary:', error);
      }
    }
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/public/unclosed-shifts/:tenantId', async (req, res) => {
  try {
    const shifts = await shiftCloseService.getUnclosedShifts(req.params.tenantId);
    res.json(shifts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/public/close-shift/:tenantId/:shiftId', async (req, res) => {
  try {
    const shift = await dataService.closeShift(
      req.params.tenantId,
      req.params.shiftId,
      req.body
    );
    res.json(shift);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// SMART REPORTS
// ============================================================================

app.get('/api/public/daily-report/:tenantId', async (req, res) => {
  try {
    const date = req.query.date || null;
    const report = await reportsService.generateDailyReport(req.params.tenantId, date);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/public/shift-report/:tenantId/:shiftId', async (req, res) => {
  try {
    const report = await reportsService.generateShiftReport(
      req.params.tenantId,
      req.params.shiftId
    );
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/public/employee-performance/:tenantId', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const report = await reportsService.generateEmployeePerformanceReport(
      req.params.tenantId,
      startDate,
      endDate
    );
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/public/fuel-analysis/:tenantId', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const report = await reportsService.generateFuelAnalysisReport(
      req.params.tenantId,
      startDate,
      endDate
    );
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// WHATSAPP INTEGRATION
// ============================================================================

app.post('/api/public/send-daily-report/:tenantId', async (req, res) => {
  try {
    const { phone } = req.body;
    const report = await reportsService.generateDailyReport(req.params.tenantId);
    const message = reportsService.formatReportText(report);
    
    await whatsapp.send(phone, message);
    res.json({ success: true, message: 'Report sent via WhatsApp' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/public/test-alert/:tenantId', async (req, res) => {
  try {
    const { phone, message } = req.body;
    await whatsapp.send(phone, message || 'Test alert from FuelStation Pro');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// ALERT HISTORY
// ============================================================================

app.get('/api/public/alert-history/:tenantId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const history = await dataService.getAuditLog(req.params.tenantId, limit);
    const alerts = history.filter(log => log.entity === 'alert');
    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// FALLBACK ROUTE
// ============================================================================

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

process.on('SIGTERM', async () => {
  console.log('[Server] SIGTERM received, shutting down gracefully...');
  
  if (alertsSystem) {
    alertsSystem.stop();
  }
  
  await closePool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Server] SIGINT received, shutting down gracefully...');
  
  if (alertsSystem) {
    alertsSystem.stop();
  }
  
  await closePool();
  process.exit(0);
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[FuelBunk Pro] Running on port ${PORT}`);
  console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[Server] Features: One-Tap Shift Close, Smart Alerts, Auto-Save, WhatsApp, Smart Reports ✓`);
});
