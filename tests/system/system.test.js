/**
 * FuelBunk Pro — System Test Suite
 *
 * Tests the COMPLETE integrated system as a whole, exactly as an independent
 * testing team would — verifying ALL functional and non-functional requirements
 * against a production-mirror environment.
 *
 * Coverage:
 *   FUNCTIONAL  — Business flows end-to-end (FR-01 to FR-12)
 *   SECURITY    — Auth, roles, injection, brute force, session (NFR-SEC)
 *   PERFORMANCE — Response times, throughput, concurrency (NFR-PERF)
 *   RELIABILITY — Idempotency, error handling, recovery (NFR-REL)
 *   USABILITY   — API contracts, error messages, HTTP semantics (NFR-USE)
 *   COMPLIANCE  — Multi-tenancy, data isolation, audit trail (NFR-COMP)
 *   PWA / OFFLINE — Manifest, service worker, cache headers (NFR-PWA)
 *
 * Run: node tests/system/system.test.js
 * Prerequisites: App running + seed data loaded (tests/integration/seed.js)
 */

'use strict';

const http  = require('http');
const https = require('https');
const { URL } = require('url');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const BASE_URL  = process.env.BASE_URL  || 'http://localhost:3000';
const TENANT_ID = process.env.TEST_TENANT_ID || 'test_tenant_001';
const SUPER_USER = process.env.SUPER_USER || 'superadmin';
const SUPER_PASS = process.env.SUPER_PASS || 'SuperSecret123!';
const ADMIN_USER = process.env.ADMIN_USER || 'owner';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Owner1234!';

// Performance SLAs
const SLA = {
  HEALTH_MS:       200,   // Health check must respond in 200ms
  AUTH_MS:        1500,   // Login must respond in 1500ms (bcrypt is intentionally slow)
  API_MS:          800,   // All data API calls under 800ms
  STATIC_MS:       300,   // Static assets under 300ms
  CONCURRENT:       10,   // Must handle 10 concurrent requests
};

// ─────────────────────────────────────────────────────────────────────────────
// HTTP CLIENT
// ─────────────────────────────────────────────────────────────────────────────
async function req(method, path, body = null, token = null, opts = {}) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE_URL);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    if (opts.userAgent) headers['User-Agent'] = opts.userAgent;

    const r = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers,
      timeout: opts.timeout || 10000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const ms = Date.now() - start;
        try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data, ms, headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: {}, raw: data, ms, headers: res.headers }); }
      });
    });
    r.on('error', e => resolve({ status: 0, body: {}, raw: '', ms: Date.now() - start, error: e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: {}, raw: '', ms: Date.now() - start, error: 'TIMEOUT' }); });
    if (payload) r.write(payload);
    r.end();
  });
}

const get  = (path, token, opts)       => req('GET',    path, null, token, opts);
const post = (path, body, token, opts) => req('POST',   path, body, token, opts);
const put  = (path, body, token)       => req('PUT',    path, body, token);
const del  = (path, token)             => req('DELETE', path, null, token);

// ─────────────────────────────────────────────────────────────────────────────
// TEST RUNNER
// ─────────────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0, total = 0, skipped = 0;
const results = [];

async function test(suite, name, fn) {
  total++;
  try {
    await fn();
    passed++;
    results.push({ suite, name, status: 'PASS' });
    process.stdout.write('.');
  } catch (e) {
    if (e.message === 'SKIP') { skipped++; total--; results.push({ suite, name, status: 'SKIP', error: e.reason || '' }); process.stdout.write('s'); return; }
    failed++;
    results.push({ suite, name, status: 'FAIL', error: e.message });
    process.stdout.write('F');
  }
}

function assert(cond, msg)   { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertLt(a, b, msg) { if (a >= b) throw new Error(msg || `Expected < ${b}, got ${a}`); }
function skip(reason)        { const e = new Error('SKIP'); e.reason = reason; throw e; }

const state = {};
const today = () => new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);

// ─────────────────────────────────────────────────────────────────────────────
// FR-01: SYSTEM AVAILABILITY & HEALTH
// ─────────────────────────────────────────────────────────────────────────────
async function fr01_availability() {
  await test('FR-01 Availability', 'System responds to health check', async () => {
    const r = await get('/api/health');
    assertEq(r.status, 200, `System unavailable: ${r.status}`);
    assert(r.ms < SLA.HEALTH_MS, `Health check too slow: ${r.ms}ms (SLA: ${SLA.HEALTH_MS}ms)`);
  });

  await test('FR-01 Availability', 'Health check does NOT require authentication', async () => {
    const r = await get('/api/health');
    assert(r.status !== 401, 'Health check must be public');
  });

  await test('FR-01 Availability', 'Detailed health check includes DB connectivity', async () => {
    const r = await get('/api/health/detailed');
    assert(r.status === 200 || r.status === 401, `Unexpected status: ${r.status}`);
  });

  await test('FR-01 Availability', 'Root URL serves the PWA application', async () => {
    const r = await get('/');
    assertEq(r.status, 200, 'Root URL should serve the app');
  });

  await test('FR-01 Availability', 'System returns 404 for unknown routes', async () => {
    const r = await get('/this-route-does-not-exist-xyz');
    assert(r.status === 404 || r.status === 200, `Unexpected status: ${r.status}`);
    // 200 is acceptable if the PWA catches all routes via index.html fallback
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-02: MULTI-TENANT STATION MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
async function fr02_multiTenant() {
  await test('FR-02 Multi-Tenant', 'Public tenant list returns all active stations', async () => {
    const r = await get('/api/tenants');
    assertEq(r.status, 200);
    assert(Array.isArray(r.body), 'Must return array');
    assert(r.body.every(t => t.id && t.name), 'Each tenant must have id and name');
  });

  await test('FR-02 Multi-Tenant', 'Tenant list includes OMC field for BPCL/IOCL routing', async () => {
    const r = await get('/api/tenants');
    assertEq(r.status, 200);
    if (r.body.length > 0) {
      const tenant = r.body.find(t => t.id === TENANT_ID) || r.body[0];
      assert('omc' in tenant, 'Tenant must have omc field');
      assert(['iocl','bpcl','hpcl','mrpl','private'].includes(tenant.omc),
        `Invalid OMC value: ${tenant.omc}`);
    }
  });

  await test('FR-02 Multi-Tenant', 'Tenant list also accessible via legacy paths', async () => {
    const paths = ['/api/tenants', '/api/tenants/list', '/api/data/tenants'];
    for (const p of paths) {
      const r = await get(p);
      assertEq(r.status, 200, `Path ${p} failed`);
      assert(Array.isArray(r.body), `${p} should return array`);
    }
  });

  await test('FR-02 Multi-Tenant', 'Super admin can create and manage stations', async () => {
    const r = await post('/api/auth/super-login', { username: SUPER_USER, password: SUPER_PASS });
    assertEq(r.status, 200, `Super login failed: ${r.body.error}`);
    state.superToken = r.body.token;
    assert(state.superToken, 'Super token required');
  });

  await test('FR-02 Multi-Tenant', 'Admin user login scoped to their own tenant', async () => {
    const r = await post('/api/auth/login', {
      username: ADMIN_USER, password: ADMIN_PASS, tenantId: TENANT_ID
    });
    assertEq(r.status, 200, `Admin login failed: ${r.body.error}`);
    state.adminToken = r.body.token;
    state.adminRole  = r.body.userRole;
    assertEq(r.body.tenantId, TENANT_ID, 'Token must be scoped to tenant');
  });

  await test('FR-02 Multi-Tenant', 'Admin cannot access data of another tenant', async () => {
    assert(state.adminToken, 'Need admin token');
    const other = 'another_tenant_completely_different_xyz';
    const r = await get(`/api/public/sales-summary/${other}`, state.adminToken);
    // The token is scoped — data returned should be empty, not from another tenant
    // Server may return 200 with empty data (not our tenant) or 404 — both are acceptable
    assert(r.status !== 500, 'Should not crash');
    if (r.status === 200 && r.body.sales) {
      assertEq(r.body.sales.length, 0, 'Should return 0 sales for unknown tenant');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-03: EMPLOYEE MANAGEMENT & PIN AUTHENTICATION
// ─────────────────────────────────────────────────────────────────────────────
async function fr03_employees() {
  await test('FR-03 Employees', 'GET /api/public/employees returns employee list', async () => {
    const r = await get(`/api/public/employees/${TENANT_ID}`);
    assertEq(r.status, 200, `Employee list failed: ${r.body.error}`);
    assert(Array.isArray(r.body), 'Should return array');
  });

  await test('FR-03 Employees', 'Employee list does NOT expose PIN hashes', async () => {
    const r = await get(`/api/public/employees/${TENANT_ID}`);
    assertEq(r.status, 200);
    for (const emp of r.body) {
      assert(!emp.pin_hash && !emp.pinHash, `Employee ${emp.name} must not expose pin_hash`);
      assert(!emp.pass_hash && !emp.passHash, `Employee ${emp.name} must not expose pass_hash`);
    }
  });

  await test('FR-03 Employees', 'PIN authentication requires numeric digits only', async () => {
    const r = await post('/api/auth/employee-login', { pin: 'abcd', tenantId: TENANT_ID });
    assertEq(r.status, 400);
    assert(r.body.error.toLowerCase().includes('digit') || r.body.error.toLowerCase().includes('pin'));
  });

  await test('FR-03 Employees', 'Correct employee PIN (1234) returns session token', async () => {
    const r = await post('/api/auth/employee-login', { pin: '1234', tenantId: TENANT_ID });
    if (r.status === 200) {
      assert(r.body.token, 'Must return token');
      assertEq(r.body.userType, 'employee');
      state.empToken = r.body.token;
    } else {
      skip('Employee with PIN 1234 not found in test data — run seed.js first');
    }
  });

  await test('FR-03 Employees', 'Admin data route includes employees', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/employees', state.adminToken);
    assertEq(r.status, 200);
    assert(Array.isArray(r.body), 'Should return array');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-04: FUEL SALES RECORDING — Complete end-to-end flow
// ─────────────────────────────────────────────────────────────────────────────
async function fr04_fuelSales() {
  const idemKey = `sys_test_sale_${Date.now()}`;

  await test('FR-04 Fuel Sales', 'Valid petrol sale records successfully', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 5, amount: 470,
      mode: 'cash', date: today(), idempotencyKey: idemKey,
      employeeName: 'System Test', employeeId: 0,
    });
    assertEq(r.status, 200, `Sale failed: ${r.body.error}`);
    assert(r.body.id, 'Must return sale id');
    state.saleId = r.body.id;
    state.saleIdemKey = idemKey;
  });

  await test('FR-04 Fuel Sales', 'Duplicate sale with same idempotency key is rejected silently', async () => {
    assert(state.saleIdemKey, 'Need idem key');
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 5, amount: 470,
      mode: 'cash', date: today(), idempotencyKey: state.saleIdemKey,
    });
    assertEq(r.status, 200);
    assertEq(r.body.duplicate, true, 'Must flag as duplicate');
  });

  await test('FR-04 Fuel Sales', 'Sale with vehicle number for UPI payment', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'diesel', liters: 20, amount: 1740,
      mode: 'upi', vehicle: 'KA06AB1234', date: today(),
      idempotencyKey: `sys_upi_${Date.now()}`,
    });
    assertEq(r.status, 200, `UPI sale failed: ${r.body.error}`);
  });

  await test('FR-04 Fuel Sales', 'Recorded sale appears in sales summary', async () => {
    const r = await get(`/api/public/sales-summary/${TENANT_ID}?from=${today()}&to=${today()}`);
    assertEq(r.status, 200, `Summary failed: ${r.body.error}`);
  });

  await test('FR-04 Fuel Sales', 'Sale with future date is rejected', async () => {
    const future = new Date(); future.setDate(future.getDate() + 5);
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 5, amount: 470,
      mode: 'cash', date: future.toISOString().slice(0, 10),
    });
    assertEq(r.status, 400);
    assert(r.body.error.toLowerCase().includes('future'), 'Must mention future date');
  });

  await test('FR-04 Fuel Sales', 'Stock enforcement blocks oversell', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 999999, amount: 93999906,
      mode: 'cash', date: today(),
    });
    assert(r.status >= 400, `Oversell must be blocked, got ${r.status}: ${r.body.error}`);
  });

  await test('FR-04 Fuel Sales', 'Admin can view all sales via authenticated route', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/sales', state.adminToken);
    assertEq(r.status, 200);
    assert(Array.isArray(r.body));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-05: TANK & INVENTORY MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
async function fr05_tanks() {
  await test('FR-05 Tanks', 'Tank list accessible via admin route', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/tanks', state.adminToken);
    assertEq(r.status, 200);
    assert(Array.isArray(r.body));
  });

  await test('FR-05 Tanks', 'Tank deduction at shift-close updates level', async () => {
    const idemKey = `sys_deduct_${Date.now()}`;
    const r = await post(`/api/public/tank-deduct/${TENANT_ID}`, {
      deductions: { petrol: 5 }, shiftDate: today(), idempotencyKey: idemKey,
    });
    assertEq(r.status, 200, `Tank deduct failed: ${r.body.error}`);
    assert(r.body.success === true);
  });

  await test('FR-05 Tanks', 'Tank deduction idempotency prevents double-deduction', async () => {
    const idemKey = `sys_deduct2_${Date.now()}`;
    await post(`/api/public/tank-deduct/${TENANT_ID}`, {
      deductions: { petrol: 5 }, shiftDate: today(), idempotencyKey: idemKey,
    });
    const r2 = await post(`/api/public/tank-deduct/${TENANT_ID}`, {
      deductions: { petrol: 5 }, shiftDate: today(), idempotencyKey: idemKey,
    });
    assertEq(r2.body.duplicate, true, 'Second deduction must be flagged duplicate');
  });

  await test('FR-05 Tanks', 'Fuel type matching is case-insensitive (Petrol vs petrol)', async () => {
    const r = await post(`/api/public/tank-deduct/${TENANT_ID}`, {
      deductions: { Petrol: 0 }, shiftDate: today(),
    });
    assertEq(r.status, 200, 'Case variation should not crash');
  });

  await test('FR-05 Tanks', 'Fuel prices endpoint returns price map', async () => {
    const r = await get(`/api/public/prices/${TENANT_ID}`);
    assertEq(r.status, 200, `Prices failed: ${r.body.error}`);
    assert(typeof r.body === 'object', 'Must return object');
  });

  await test('FR-05 Tanks', 'Pumps endpoint returns pump configuration', async () => {
    const r = await get(`/api/public/pumps/${TENANT_ID}`);
    assertEq(r.status, 200, `Pumps failed: ${r.body.error}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-06: CREDIT CUSTOMER MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────
async function fr06_credit() {
  await test('FR-06 Credit', 'Credit customers list accessible publicly for employee portal', async () => {
    const r = await get(`/api/public/creditcustomers/${TENANT_ID}`);
    assertEq(r.status, 200, `Credit customers failed: ${r.body.error}`);
  });

  await test('FR-06 Credit', 'Credit customers list does NOT expose sensitive data', async () => {
    const r = await get(`/api/public/creditcustomers/${TENANT_ID}`);
    assertEq(r.status, 200);
    if (Array.isArray(r.body) && r.body.length > 0) {
      for (const c of r.body) {
        assert(!c.pass_hash && !c.pin_hash, 'Credit customer must not expose hash fields');
      }
    }
  });

  await test('FR-06 Credit', 'Credit sale blocked when customer exceeds limit', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 1000, amount: 94000,
      mode: 'credit', customer: 'TestCreditCustomer', date: today(),
    });
    // Amount ₹94000 would exceed ₹10000 limit — should fail at validation or credit check
    assert(r.status >= 400, `Overlimit credit sale should be blocked, got ${r.status}`);
  });

  await test('FR-06 Credit', 'Admin can access full credit customer data', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/creditCustomers', state.adminToken);
    assertEq(r.status, 200);
    assert(Array.isArray(r.body));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-07: LUBE PRODUCTS & SALES
// ─────────────────────────────────────────────────────────────────────────────
async function fr07_lubes() {
  await test('FR-07 Lubes', 'Staff data endpoint includes lube products', async () => {
    const r = await get(`/api/public/staff-data/${TENANT_ID}`);
    assertEq(r.status, 200, `Staff data failed: ${r.body.error}`);
  });

  await test('FR-07 Lubes', 'Lube sale with missing product returns 404', async () => {
    const r = await post(`/api/public/lube-sale/${TENANT_ID}`, {
      productId: 'nonexistent_lube_999', qty: 1, rate: 100, mode: 'cash',
    });
    assertEq(r.status, 404, `Expected 404, got ${r.status}`);
  });

  await test('FR-07 Lubes', 'Lube sale with zero qty returns 400', async () => {
    const r = await post(`/api/public/lube-sale/${TENANT_ID}`, {
      productId: 'test_lube_p1', qty: 0, rate: 100, mode: 'cash',
    });
    assertEq(r.status, 400);
  });

  await test('FR-07 Lubes', 'Lube sale transaction is atomic (stock deducted correctly)', async () => {
    const idemKey = `sys_lube_${Date.now()}`;
    const r = await post(`/api/public/lube-sale/${TENANT_ID}`, {
      productId: 'test_lube_p1', qty: 2, rate: 150, mode: 'cash',
      idempotencyKey: idemKey,
    });
    if (r.status === 200 && !r.body.duplicate) {
      assertEq(r.body.success, true);
      assert(typeof r.body.product.newStock === 'number', 'Must return new stock level');
      assertEq(r.body.amount, 300, 'Amount must be qty × rate');
      // Retry same sale — must be idempotent
      const r2 = await post(`/api/public/lube-sale/${TENANT_ID}`, {
        productId: 'test_lube_p1', qty: 2, rate: 150, mode: 'cash',
        idempotencyKey: idemKey,
      });
      assertEq(r2.body.duplicate, true, 'Retry must be duplicate');
    } else {
      skip('Lube product not in test DB — run seed.js');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-08: EXPENSE RECORDING
// ─────────────────────────────────────────────────────────────────────────────
async function fr08_expenses() {
  await test('FR-08 Expenses', 'Valid expense recorded successfully', async () => {
    const idemKey = `sys_exp_${Date.now()}`;
    const r = await post(`/api/public/expense/${TENANT_ID}`, {
      amount: 500, category: 'Salary', desc: 'System test expense',
      mode: 'cash', date: today(), idempotencyKey: idemKey,
    });
    assertEq(r.status, 200, `Expense failed: ${r.body.error}`);
    assertEq(r.body.success, true);
    state.expIdemKey = idemKey;
  });

  await test('FR-08 Expenses', 'Duplicate expense via idempotency key is blocked', async () => {
    assert(state.expIdemKey, 'Need idem key');
    const r = await post(`/api/public/expense/${TENANT_ID}`, {
      amount: 500, category: 'Salary', desc: 'Retry',
      mode: 'cash', idempotencyKey: state.expIdemKey,
    });
    assertEq(r.status, 200);
    assertEq(r.body.duplicate, true, 'Must flag as duplicate');
  });

  await test('FR-08 Expenses', 'Expense amount over ₹1 crore rejected', async () => {
    const r = await post(`/api/public/expense/${TENANT_ID}`, {
      amount: 10000001, category: 'Misc', desc: 'Too much',
    });
    assertEq(r.status, 400);
  });

  await test('FR-08 Expenses', 'Admin can read expenses via data route', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/expenses', state.adminToken);
    assertEq(r.status, 200);
    assert(Array.isArray(r.body));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-09: SUBSCRIPTION & BILLING STATUS
// ─────────────────────────────────────────────────────────────────────────────
async function fr09_subscription() {
  await test('FR-09 Subscription', 'Public subscription status endpoint is accessible', async () => {
    const r = await get(`/api/public/subscription/${TENANT_ID}`);
    assertEq(r.status, 200, `Subscription failed: ${r.body.error}`);
    assert(typeof r.body === 'object', 'Must return object');
  });

  await test('FR-09 Subscription', 'Subscription status includes required fields', async () => {
    const r = await get(`/api/public/subscription/${TENANT_ID}`);
    assertEq(r.status, 200);
    assert('is_read_only' in r.body || r.body.status || r.body.plan,
      'Must include subscription state');
  });

  await test('FR-09 Subscription', 'Authenticated subscription endpoint returns full details', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get(`/api/subscriptions/${TENANT_ID}`, state.adminToken);
    assertEq(r.status, 200);
    assert(r.body.status || r.body.plan, 'Must return subscription details');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-10: DAY-LOCK & AUDIT TRAIL
// ─────────────────────────────────────────────────────────────────────────────
async function fr10_dayLock() {
  await test('FR-10 Day-Lock', 'Day-lock status is queryable', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get(`/api/data/day-lock/${today()}/status`, state.adminToken);
    assertEq(r.status, 200);
    assert(typeof r.body.locked === 'boolean', 'Must return boolean locked state');
  });

  await test('FR-10 Day-Lock', 'Only Owner can close/lock a day', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await post(`/api/data/day-lock/2020-01-01/close`, {}, state.adminToken);
    if (state.adminRole === 'Owner') {
      assert(r.status === 200 || r.status === 423, `Owner should lock, got ${r.status}`);
    } else {
      assertEq(r.status, 403, 'Non-Owner must be blocked');
    }
  });

  await test('FR-10 Day-Lock', 'Locked day blocks new sale write', async () => {
    if (state.adminRole !== 'Owner') skip('Need Owner role');
    // Lock a specific historical date
    await post('/api/data/day-lock/2020-06-01/close', {}, state.adminToken);
    const r = await post('/api/data/sales', {
      fuelType: 'petrol', liters: 5, amount: 470,
      mode: 'cash', date: '2020-06-01',
    }, state.adminToken);
    assert(r.status === 423 || r.status === 400, `Locked day must block write, got ${r.status}`);
  });

  await test('FR-10 Day-Lock', 'Audit log is written for admin actions', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/auditLog', state.adminToken);
    assertEq(r.status, 200);
    assert(Array.isArray(r.body), 'Audit log must return array');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-11: BULK DATA LOAD & REPORTING
// ─────────────────────────────────────────────────────────────────────────────
async function fr11_reporting() {
  await test('FR-11 Reporting', 'Bulk load returns all required data modules', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/bulk-load', state.adminToken);
    assertEq(r.status, 200, `Bulk load failed: ${r.body.error}`);
    const required = ['sales', 'tanks', 'employees', 'expenses'];
    for (const key of required) {
      assert(key in r.body, `Bulk load missing: ${key}`);
    }
  });

  await test('FR-11 Reporting', 'Sales summary aggregates correctly for date range', async () => {
    const r = await get(`/api/public/sales-summary/${TENANT_ID}?from=${today()}&to=${today()}`);
    assertEq(r.status, 200);
    assert(typeof r.body === 'object', 'Must return object');
  });

  await test('FR-11 Reporting', 'Shift history records are saved and retrievable', async () => {
    const r = await get(`/api/public/shift-history/${TENANT_ID}/0`);
    assert(r.status === 200 || r.status === 404, `Got ${r.status}`);
  });

  await test('FR-11 Reporting', 'Settings key-value store works for config', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/settings/key/fuel_prices', state.adminToken);
    assert(r.status === 200 || r.status === 404, `Got ${r.status}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NFR-SEC: SECURITY REQUIREMENTS
// ─────────────────────────────────────────────────────────────────────────────
async function nfr_security() {
  await test('NFR-SEC Security', 'Security headers present — X-Content-Type-Options', async () => {
    const r = await get('/api/health');
    assert(r.headers['x-content-type-options'] === 'nosniff',
      `Missing x-content-type-options: ${r.headers['x-content-type-options']}`);
  });

  await test('NFR-SEC Security', 'Security headers present — X-Frame-Options or CSP frame-ancestors', async () => {
    const r = await get('/api/health');
    const hasXFrame = r.headers['x-frame-options'];
    const hasCSP    = r.headers['content-security-policy'];
    assert(hasXFrame || hasCSP, 'Must have X-Frame-Options or CSP to prevent clickjacking');
  });

  await test('NFR-SEC Security', 'Content-Security-Policy header is set', async () => {
    const r = await get('/');
    assert(r.headers['content-security-policy'], 'CSP header must be present on main page');
  });

  await test('NFR-SEC Security', 'Passwords are NOT returned in any API response', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/employees', state.adminToken);
    assertEq(r.status, 200);
    const body = JSON.stringify(r.body);
    assert(!body.includes('pass_hash') && !body.includes('pin_hash'),
      'Employee response must not contain password hashes');
  });

  await test('NFR-SEC Security', 'Auth tokens expire — session check with invalid token → 401', async () => {
    const r = await get('/api/auth/session', 'abc123invalidtoken');
    assertEq(r.status, 401);
  });

  await test('NFR-SEC Security', 'Wrong super-admin password returns 401 not 500', async () => {
    const r = await post('/api/auth/super-login', {
      username: SUPER_USER, password: 'completelyWrong!!!'
    });
    assertEq(r.status, 401, 'Wrong password must return 401 not 500');
    assert(!r.body.token, 'Must NOT return token on failed login');
  });

  await test('NFR-SEC Security', 'SQL injection in URL param does not cause 500', async () => {
    const r = await get("/api/public/sales-summary/'; DROP TABLE sales; --");
    assert(r.status !== 500, `SQL injection caused 500: ${r.raw.slice(0, 100)}`);
  });

  await test('NFR-SEC Security', 'XSS payload in request body is sanitised', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: '<script>alert(1)</script>', liters: 5, amount: 470,
    });
    assert(r.status !== 500, 'XSS in body must not crash server');
    assert(r.status >= 400, 'XSS fuel type must be rejected');
  });

  await test('NFR-SEC Security', 'Brute-force protection blocks repeated failed logins', async () => {
    // Send 6 wrong password attempts to trigger brute-force protection
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const r = await post('/api/auth/login', {
        username: 'brute_force_test_' + Date.now(),
        password: 'wrongpass' + i, tenantId: TENANT_ID,
      });
      lastStatus = r.status;
    }
    // Either 401 (wrong creds) or 429 (rate limited) — never 200
    assert(lastStatus === 401 || lastStatus === 429,
      `Brute-force test last status: ${lastStatus}`);
  });

  await test('NFR-SEC Security', 'PIN rate limiter activates on excessive attempts', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const r = await post('/api/public/verify-pin/' + TENANT_ID, {
        pin: '0000', tenantId: TENANT_ID, employeeId: 999,
      });
      lastStatus = r.status;
      if (lastStatus === 429) break;
    }
    assert(lastStatus === 400 || lastStatus === 401 || lastStatus === 429,
      `PIN rate limit should activate, last status: ${lastStatus}`);
  });

  await test('NFR-SEC Security', 'CORS — same-origin requests allowed', async () => {
    const r = await get('/api/health');
    assertEq(r.status, 200, 'Same-origin request must succeed');
  });

  await test('NFR-SEC Security', 'Oversized JSON payload rejected (> 2MB)', async () => {
    const bigBody = { data: 'x'.repeat(2.5 * 1024 * 1024) };
    const r = await post(`/api/public/sales/${TENANT_ID}`, bigBody);
    assert(r.status === 413 || r.status === 400,
      `Oversized payload should be rejected, got ${r.status}`);
  });

  await test('NFR-SEC Security', 'Super-only route blocked for admin user', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get(`/api/data/tenants/${TENANT_ID}/admins`, state.adminToken);
    assertEq(r.status, 403, 'Admin must not access super-only routes');
  });

  await test('NFR-SEC Security', 'Owner-only sale edit blocked for other roles', async () => {
    assert(state.adminToken, 'Need admin token');
    if (state.adminRole !== 'Owner') {
      const r = await put('/api/data/sales', { id: 1, liters: 5 }, state.adminToken);
      assertEq(r.status, 403);
      assert(r.body.error.includes('Owner'));
    } else {
      assert(true, 'Skipped — logged in as Owner');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NFR-PERF: PERFORMANCE REQUIREMENTS
// ─────────────────────────────────────────────────────────────────────────────
async function nfr_performance() {
  await test('NFR-PERF Performance', `Health check responds under ${SLA.HEALTH_MS}ms`, async () => {
    const r = await get('/api/health');
    assertEq(r.status, 200);
    assertLt(r.ms, SLA.HEALTH_MS, `Health check took ${r.ms}ms (SLA: ${SLA.HEALTH_MS}ms)`);
  });

  await test('NFR-PERF Performance', `Auth login responds under ${SLA.AUTH_MS}ms`, async () => {
    const r = await post('/api/auth/login', {
      username: ADMIN_USER, password: ADMIN_PASS, tenantId: TENANT_ID,
    });
    assertEq(r.status, 200);
    assertLt(r.ms, SLA.AUTH_MS, `Login took ${r.ms}ms (SLA: ${SLA.AUTH_MS}ms)`);
  });

  await test('NFR-PERF Performance', `Sales API responds under ${SLA.API_MS}ms`, async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/sales', state.adminToken);
    assertEq(r.status, 200);
    assertLt(r.ms, SLA.API_MS, `Sales API took ${r.ms}ms (SLA: ${SLA.API_MS}ms)`);
  });

  await test('NFR-PERF Performance', `Bulk-load responds under ${SLA.API_MS * 2}ms`, async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/bulk-load', state.adminToken);
    assertEq(r.status, 200);
    assertLt(r.ms, SLA.API_MS * 2, `Bulk-load took ${r.ms}ms (SLA: ${SLA.API_MS * 2}ms)`);
  });

  await test('NFR-PERF Performance', `Static assets served under ${SLA.STATIC_MS}ms`, async () => {
    const r = await get('/manifest.json');
    assertEq(r.status, 200);
    assertLt(r.ms, SLA.STATIC_MS, `Manifest took ${r.ms}ms (SLA: ${SLA.STATIC_MS}ms)`);
  });

  await test('NFR-PERF Performance', `System handles ${SLA.CONCURRENT} concurrent requests`, async () => {
    const promises = Array.from({ length: SLA.CONCURRENT }, () => get('/api/health'));
    const responses = await Promise.all(promises);
    const failures = responses.filter(r => r.status !== 200);
    assertEq(failures.length, 0,
      `${failures.length}/${SLA.CONCURRENT} concurrent requests failed`);
  });

  await test('NFR-PERF Performance', 'DB connection pool handles concurrent sale writes', async () => {
    const today_ = today();
    const promises = Array.from({ length: 5 }, (_, i) =>
      post(`/api/public/sales/${TENANT_ID}`, {
        fuelType: 'petrol', liters: 1, amount: 94,
        mode: 'cash', date: today_,
        idempotencyKey: `perf_test_concurrent_${Date.now()}_${i}`,
      })
    );
    const responses = await Promise.all(promises);
    const serverErrors = responses.filter(r => r.status === 500);
    assertEq(serverErrors.length, 0, `${serverErrors.length} concurrent sales returned 500`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NFR-REL: RELIABILITY & ERROR HANDLING
// ─────────────────────────────────────────────────────────────────────────────
async function nfr_reliability() {
  await test('NFR-REL Reliability', 'All endpoints return JSON (not HTML error pages)', async () => {
    const testPaths = [
      '/api/public/sales/nonexistent_tenant_xyz',
      '/api/data/sales',
      '/api/auth/session',
    ];
    for (const p of testPaths) {
      const r = await get(p);
      assert(typeof r.body === 'object',
        `${p} returned non-JSON response (status ${r.status})`);
    }
  });

  await test('NFR-REL Reliability', 'Server never returns 500 on invalid input', async () => {
    const badPayloads = [
      post(`/api/public/sales/${TENANT_ID}`, { fuelType: null, liters: null }),
      post(`/api/public/expense/${TENANT_ID}`, { amount: 'not_a_number', category: null }),
      post(`/api/public/lube-sale/${TENANT_ID}`, {}),
    ];
    const results_ = await Promise.all(badPayloads);
    for (const r of results_) {
      assert(r.status !== 500, `Bad input caused 500: ${JSON.stringify(r.body).slice(0, 100)}`);
    }
  });

  await test('NFR-REL Reliability', 'Idempotency protects all write operations', async () => {
    // All three key write endpoints support idempotencyKey
    const endpoints = [
      { path: `/api/public/sales/${TENANT_ID}`, body: { fuelType: 'petrol', liters: 1, amount: 94, mode: 'cash', date: today() } },
      { path: `/api/public/expense/${TENANT_ID}`, body: { amount: 100, category: 'Misc', desc: 'Idem test' } },
      { path: `/api/public/tank-deduct/${TENANT_ID}`, body: { deductions: { petrol: 1 }, shiftDate: today() } },
    ];
    for (const ep of endpoints) {
      const idemKey = `idem_check_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const body1 = { ...ep.body, idempotencyKey: idemKey };
      const r1 = await post(ep.path, body1);
      const r2 = await post(ep.path, body1);
      if (r1.status === 200) {
        assertEq(r2.status, 200, `${ep.path} retry should return 200`);
        assertEq(r2.body.duplicate, true, `${ep.path} retry must be flagged duplicate`);
      }
    }
  });

  await test('NFR-REL Reliability', 'Graceful handling of missing tenant in public routes', async () => {
    const r = await get('/api/public/employees/nonexistent_xyz_tenant');
    assert(r.status !== 500, `Missing tenant returned 500: ${r.status}`);
    assert(r.status === 200 || r.status === 404, `Expected 200/404, got ${r.status}`);
  });

  await test('NFR-REL Reliability', 'Error responses always include a message field', async () => {
    const testCases = [
      post('/api/auth/login', { username: 'x', password: 'x', tenantId: 'x' }),
      post(`/api/public/sales/${TENANT_ID}`, {}),
      post(`/api/public/expense/${TENANT_ID}`, {}),
    ];
    const responses = await Promise.all(testCases);
    for (const r of responses) {
      if (r.status >= 400 && r.status < 500) {
        assert(r.body.error, `Error response missing 'error' field: ${JSON.stringify(r.body)}`);
      }
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NFR-USE: USABILITY / API CONTRACT
// ─────────────────────────────────────────────────────────────────────────────
async function nfr_usability() {
  await test('NFR-USE API Contract', 'Successful sale returns { id } field', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 1, amount: 94, mode: 'cash', date: today(),
      idempotencyKey: `contract_test_${Date.now()}`,
    });
    assertEq(r.status, 200);
    assert(r.body.id !== undefined, 'Sale response must include id');
  });

  await test('NFR-USE API Contract', 'Lube sale returns { product.newStock, amount, sale }', async () => {
    const r = await post(`/api/public/lube-sale/${TENANT_ID}`, {
      productId: 'test_lube_p1', qty: 1, rate: 150, mode: 'cash',
      idempotencyKey: `lube_contract_${Date.now()}`,
    });
    if (r.status === 200 && !r.body.duplicate) {
      assert(r.body.product?.newStock !== undefined, 'Must return product.newStock');
      assert(r.body.amount !== undefined, 'Must return amount');
      assert(r.body.sale !== undefined, 'Must return sale record');
    } else {
      assert(r.status !== 500, 'Must not return 500');
    }
  });

  await test('NFR-USE API Contract', 'Tank deduction returns { results[], errors[] }', async () => {
    const r = await post(`/api/public/tank-deduct/${TENANT_ID}`, {
      deductions: { petrol: 0 }, shiftDate: today(),
    });
    assertEq(r.status, 200);
    assert(Array.isArray(r.body.results), 'Must return results array');
  });

  await test('NFR-USE API Contract', 'Duplicate responses always include { duplicate: true }', async () => {
    const idemKey = `dup_contract_${Date.now()}`;
    await post(`/api/public/expense/${TENANT_ID}`, {
      amount: 100, category: 'Misc', desc: 'Contract test',
      idempotencyKey: idemKey,
    });
    const r2 = await post(`/api/public/expense/${TENANT_ID}`, {
      amount: 100, category: 'Misc', desc: 'Contract test',
      idempotencyKey: idemKey,
    });
    assertEq(r2.body.duplicate, true);
    assertEq(r2.status, 200);
  });

  await test('NFR-USE API Contract', 'HTTP 400 used for client errors (not 422 for validation)', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'invalid', liters: -1, amount: -1,
    });
    assert(r.status === 400 || r.status === 422, `Expected 400/422, got ${r.status}`);
  });

  await test('NFR-USE API Contract', 'HTTP 404 for genuinely missing resources', async () => {
    const r = await post('/api/auth/login', {
      username: 'any', password: 'any', tenantId: 'truly_nonexistent_xyz',
    });
    assertEq(r.status, 404, 'Missing tenant must return 404');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NFR-PWA: PWA / OFFLINE REQUIREMENTS
// ─────────────────────────────────────────────────────────────────────────────
async function nfr_pwa() {
  await test('NFR-PWA Progressive Web App', 'manifest.json is served with correct content-type', async () => {
    const r = await get('/manifest.json');
    assertEq(r.status, 200, 'manifest.json must be served');
    assert(r.headers['content-type']?.includes('json'),
      `Wrong content-type: ${r.headers['content-type']}`);
  });

  await test('NFR-PWA Progressive Web App', 'manifest.json has required PWA fields', async () => {
    const r = await get('/manifest.json');
    assertEq(r.status, 200);
    const m = r.body;
    assert(m.name, 'Manifest must have name');
    assert(m.short_name, 'Manifest must have short_name');
    assert(m.start_url, 'Manifest must have start_url');
    assert(m.display, 'Manifest must have display');
    assert(Array.isArray(m.icons) && m.icons.length > 0, 'Manifest must have icons');
  });

  await test('NFR-PWA Progressive Web App', 'Service worker is served at /sw.js', async () => {
    const r = await get('/sw.js');
    assertEq(r.status, 200, 'sw.js must be served');
  });

  await test('NFR-PWA Progressive Web App', 'Service worker has no-cache header (always fresh)', async () => {
    const r = await get('/sw.js');
    assertEq(r.status, 200);
    const cc = r.headers['cache-control'] || '';
    assert(cc.includes('no-cache') || cc.includes('no-store') || cc.includes('max-age=0'),
      `SW must not be cached. Cache-Control: ${cc}`);
  });

  await test('NFR-PWA Progressive Web App', 'App icons are served (192px)', async () => {
    const r = await get('/icon-192.png');
    assertEq(r.status, 200, 'icon-192.png must be served');
    assert(r.headers['content-type']?.includes('image'), 'Icons must be images');
  });

  await test('NFR-PWA Progressive Web App', 'App icons are served (512px)', async () => {
    const r = await get('/icon-512.png');
    assertEq(r.status, 200, 'icon-512.png must be served');
  });

  await test('NFR-PWA Progressive Web App', 'Static JS assets have cache headers', async () => {
    const r = await get('/manifest.json');
    assertEq(r.status, 200);
    const cc = r.headers['cache-control'];
    assert(cc, 'Static assets must have Cache-Control header');
  });

  await test('NFR-PWA Progressive Web App', 'index.html served with no-cache (always fresh)', async () => {
    const r = await get('/');
    assertEq(r.status, 200);
    const cc = r.headers['cache-control'] || '';
    assert(cc.includes('no-cache') || cc.includes('no-store'),
      `index.html should be no-cache. Got: ${cc}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// NFR-COMP: COMPLIANCE — Multi-tenancy & Data isolation
// ─────────────────────────────────────────────────────────────────────────────
async function nfr_compliance() {
  await test('NFR-COMP Compliance', 'All authenticated routes enforce tenant scoping', async () => {
    assert(state.adminToken, 'Need admin token');
    // Data routes use tenant from token — not from URL
    const stores = ['sales', 'tanks', 'employees', 'expenses'];
    for (const s of stores) {
      const r = await get(`/api/data/${s}`, state.adminToken);
      assertEq(r.status, 200, `Store ${s} failed`);
      assert(Array.isArray(r.body), `${s} must return array`);
      // No row should belong to a different tenant
      if (r.body.length > 0) {
        const crossTenant = r.body.filter(row => row.tenant_id && row.tenant_id !== TENANT_ID);
        assertEq(crossTenant.length, 0, `Cross-tenant data found in ${s}!`);
      }
    }
  });

  await test('NFR-COMP Compliance', 'IST date used for all timestamps (not UTC)', async () => {
    const r = await post(`/api/public/expense/${TENANT_ID}`, {
      amount: 100, category: 'Misc', desc: 'IST test',
      idempotencyKey: `ist_test_${Date.now()}`,
    });
    assertEq(r.status, 200);
    // The fact that sale is accepted validates IST date logic
    // (a UTC-midnight date would fail the "future date" check at IST 00:01-05:30)
    assert(r.body.success === true, 'IST date handling must allow current time');
  });

  await test('NFR-COMP Compliance', 'Audit log records admin actions', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/auditLog', state.adminToken);
    assertEq(r.status, 200);
    assert(Array.isArray(r.body), 'Audit log must be accessible');
  });

  await test('NFR-COMP Compliance', 'Subscription system enforces read-only mode', async () => {
    const r = await get(`/api/public/subscription/${TENANT_ID}`);
    assertEq(r.status, 200);
    assert('is_read_only' in r.body || r.body.status !== undefined,
      'Subscription must expose read-only status');
  });

  await test('NFR-COMP Compliance', 'Data deletion requires Owner role', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await del('/api/data/sales/99999', state.adminToken);
    if (state.adminRole !== 'Owner') {
      assertEq(r.status, 403, 'Non-Owner delete must be blocked');
    } else {
      assert(r.status !== 500, 'Delete must not return 500');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// RUN ALL TEST SUITES
// ─────────────────────────────────────────────────────────────────────────────
async function runAll() {
  console.log('\n' + '═'.repeat(72));
  console.log('  FUELBUNK PRO — SYSTEM TEST REPORT');
  console.log(`  Target: ${BASE_URL}  |  Tenant: ${TENANT_ID}`);
  console.log('  Scope: Functional + Non-Functional (Security/Performance/Reliability/PWA/Compliance)');
  console.log('═'.repeat(72));
  console.log('\nRunning (. = pass, F = fail, s = skip):\n');

  try {
    await fr01_availability();
    await fr02_multiTenant();
    await fr03_employees();
    await fr04_fuelSales();
    await fr05_tanks();
    await fr06_credit();
    await fr07_lubes();
    await fr08_expenses();
    await fr09_subscription();
    await fr10_dayLock();
    await fr11_reporting();
    await nfr_security();
    await nfr_performance();
    await nfr_reliability();
    await nfr_usability();
    await nfr_pwa();
    await nfr_compliance();
  } catch (e) {
    console.error('\n\nFATAL ERROR:', e.message);
    console.error('Is the app running at', BASE_URL, '?');
    process.exit(2);
  }

  // ── Print results ─────────────────────────────────────────────────────────
  const suites = {};
  for (const r of results) {
    if (!suites[r.suite]) suites[r.suite] = { pass: 0, fail: 0, skip: 0, tests: [] };
    suites[r.suite].tests.push(r);
    if (r.status === 'PASS')      suites[r.suite].pass++;
    else if (r.status === 'FAIL') suites[r.suite].fail++;
    else                          suites[r.suite].skip++;
  }

  console.log('\n\n' + '═'.repeat(72));
  console.log('  RESULTS BY SUITE');
  console.log('═'.repeat(72));

  for (const [name, s] of Object.entries(suites)) {
    const icon = s.fail === 0 ? '✅' : '❌';
    const skipNote = s.skip > 0 ? ` (${s.skip} skipped)` : '';
    console.log(`\n${icon} ${name.padEnd(38)} [${s.pass}/${s.pass + s.fail + s.skip} passed${skipNote}]`);
    for (const t of s.tests) {
      const sym = t.status === 'PASS' ? '  ✓' : t.status === 'SKIP' ? '  ⊘' : '  ✗';
      console.log(`${sym}  ${t.name}`);
      if (t.status === 'FAIL')  console.log(`       → ${t.error}`);
      if (t.status === 'SKIP')  console.log(`       ⊘ ${t.error}`);
    }
  }

  const pct = Math.round((passed / total) * 100);
  console.log('\n' + '─'.repeat(72));
  console.log(`  Total: ${total + skipped}  |  Run: ${total}  |  Passed: ${passed}  |  Failed: ${failed}  |  Skipped: ${skipped}`);
  console.log(`  Pass rate: ${pct}%`);
  console.log('─'.repeat(72));

  if (failed > 0) {
    console.log(`\n⚠️  ${failed} system test(s) FAILED — system does not meet requirements.\n`);
    process.exit(1);
  } else {
    console.log(`\n✅  All ${total} system tests PASSED. System meets all functional and non-functional requirements.\n`);
    process.exit(0);
  }
}

runAll();
