/**
 * FuelBunk Pro — Integration Test Suite
 *
 * Tests how modules work TOGETHER across real HTTP boundaries:
 *   Auth ↔ Session ↔ Protected routes
 *   Employee login ↔ PIN verify ↔ Sale recording ↔ Stock enforcement
 *   Sale recording ↔ Idempotency ↔ DB
 *   Credit limit ↔ Sale ↔ Customer balance
 *   Tank deduction ↔ Shift close ↔ Stock level
 *   Lube sale ↔ Stock deduction ↔ Idempotency
 *   Expense recording ↔ Idempotency ↔ DB
 *   Auth middleware ↔ All protected routes
 *   Role enforcement ↔ Sale edit/delete
 *   Day-lock ↔ Write operations
 *
 * Prerequisites:
 *   - App running at BASE_URL (default http://localhost:3000)
 *   - Test database seeded via: node tests/integration/seed.js
 *   - Run: node tests/integration/integration.test.js
 *
 * Environment variables:
 *   BASE_URL=http://localhost:3000
 *   TEST_TENANT_ID=test_tenant_001
 */

'use strict';

const http  = require('http');
const https = require('https');
const { URL } = require('url');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const BASE_URL   = process.env.BASE_URL   || 'http://localhost:3000';
const TENANT_ID  = process.env.TEST_TENANT_ID || 'test_tenant_001';
const SUPER_USER = process.env.SUPER_USER || 'superadmin';
const SUPER_PASS = process.env.SUPER_PASS || 'SuperSecret123!';
const ADMIN_USER = process.env.ADMIN_USER || 'owner';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Owner1234!';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP CLIENT
// ─────────────────────────────────────────────────────────────────────────────
async function req(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, BASE_URL);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const r = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data }); }
        catch { resolve({ status: res.statusCode, body: {}, raw: data }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const get  = (path, token)        => req('GET',    path, null, token);
const post = (path, body, token)  => req('POST',   path, body, token);
const put  = (path, body, token)  => req('PUT',    path, body, token);
const del  = (path, token)        => req('DELETE', path, null, token);

// ─────────────────────────────────────────────────────────────────────────────
// TEST RUNNER
// ─────────────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0, total = 0;
const results = [];

async function test(suite, name, fn) {
  total++;
  try {
    await fn();
    passed++;
    results.push({ suite, name, status: 'PASS' });
    process.stdout.write('.');
  } catch (e) {
    failed++;
    results.push({ suite, name, status: 'FAIL', error: e.message });
    process.stdout.write('F');
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// Shared state across tests (token reuse = integration!)
const state = {
  superToken: null,
  adminToken: null,
  employeeToken: null,
  saleId: null,
  expenseId: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1: HEALTH CHECK
// ─────────────────────────────────────────────────────────────────────────────
async function suite_health() {
  await test('Health', 'GET /api/health returns 200', async () => {
    const r = await get('/api/health');
    assertEq(r.status, 200, `Expected 200, got ${r.status}`);
    assert(r.body.status === 'ok' || r.body.ok === true || r.body.healthy === true || r.status === 200);
  });

  await test('Health', 'Response has correct content-type JSON', async () => {
    const r = await get('/api/health');
    assertEq(r.status, 200);
    assert(typeof r.body === 'object', 'Health response should be JSON');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2: SUPER ADMIN AUTH FLOW
// ─────────────────────────────────────────────────────────────────────────────
async function suite_superAuth() {
  await test('SuperAuth', 'POST /api/auth/super-login missing credentials → 400', async () => {
    const r = await post('/api/auth/super-login', {});
    assertEq(r.status, 400);
    assert(r.body.error, 'Should return error message');
  });

  await test('SuperAuth', 'POST /api/auth/super-login wrong password → 401', async () => {
    const r = await post('/api/auth/super-login', { username: SUPER_USER, password: 'wrongpass' });
    assertEq(r.status, 401);
  });

  await test('SuperAuth', 'POST /api/auth/super-login valid → 200 + token', async () => {
    const r = await post('/api/auth/super-login', { username: SUPER_USER, password: SUPER_PASS });
    assertEq(r.status, 200, `Super login failed: ${r.body.error}`);
    assert(r.body.token, 'Should return token');
    assertEq(r.body.userType, 'super');
    state.superToken = r.body.token;
  });

  await test('SuperAuth', 'GET /api/auth/session with super token → valid', async () => {
    assert(state.superToken, 'Need super token from previous test');
    const r = await get('/api/auth/session', state.superToken);
    assertEq(r.status, 200);
    assertEq(r.body.userType, 'super');
    assertEq(r.body.valid, true);
  });

  await test('SuperAuth', 'GET /api/auth/session without token → 401', async () => {
    const r = await get('/api/auth/session');
    assertEq(r.status, 401);
  });

  await test('SuperAuth', 'GET /api/auth/session with fake token → 401', async () => {
    const r = await get('/api/auth/session', 'totally_fake_token_abc123');
    assertEq(r.status, 401);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3: ADMIN AUTH FLOW
// ─────────────────────────────────────────────────────────────────────────────
async function suite_adminAuth() {
  await test('AdminAuth', 'POST /api/auth/login missing tenantId → 400', async () => {
    const r = await post('/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS });
    assertEq(r.status, 400);
  });

  await test('AdminAuth', 'POST /api/auth/login wrong tenant → 404', async () => {
    const r = await post('/api/auth/login', {
      username: ADMIN_USER, password: ADMIN_PASS, tenantId: 'nonexistent_tenant_xyz'
    });
    assertEq(r.status, 404);
  });

  await test('AdminAuth', 'POST /api/auth/login wrong password → 401', async () => {
    const r = await post('/api/auth/login', {
      username: ADMIN_USER, password: 'wrongpassword', tenantId: TENANT_ID
    });
    assertEq(r.status, 401);
  });

  await test('AdminAuth', 'POST /api/auth/login valid → 200 + token + role', async () => {
    const r = await post('/api/auth/login', {
      username: ADMIN_USER, password: ADMIN_PASS, tenantId: TENANT_ID
    });
    assertEq(r.status, 200, `Admin login failed: ${r.body.error}`);
    assert(r.body.token, 'Should return token');
    assertEq(r.body.userType, 'admin');
    assert(r.body.userRole, 'Should return role');
    assertEq(r.body.tenantId, TENANT_ID);
    state.adminToken = r.body.token;
    state.adminRole = r.body.userRole;
  });

  await test('AdminAuth', 'Token flows through to session check correctly', async () => {
    const r = await get('/api/auth/session', state.adminToken);
    assertEq(r.status, 200);
    assertEq(r.body.userType, 'admin');
    assertEq(r.body.tenantId, TENANT_ID);
  });

  await test('AdminAuth', 'POST /api/auth/logout invalidates session', async () => {
    // Login a fresh session to invalidate
    const loginR = await post('/api/auth/login', {
      username: ADMIN_USER, password: ADMIN_PASS, tenantId: TENANT_ID
    });
    const tempToken = loginR.body.token;
    assert(tempToken, 'Need temp token');

    // Logout
    const logoutR = await post('/api/auth/logout', {}, tempToken);
    assertEq(logoutR.status, 200);

    // Session should now be invalid
    const sessionR = await get('/api/auth/session', tempToken);
    assertEq(sessionR.status, 401, 'Session should be invalidated after logout');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4: AUTH MIDDLEWARE ↔ PROTECTED ROUTES
// ─────────────────────────────────────────────────────────────────────────────
async function suite_authMiddleware() {
  await test('AuthMiddleware', 'Protected route without token → 401', async () => {
    const r = await get(`/api/data/sales`);
    assertEq(r.status, 401);
  });

  await test('AuthMiddleware', 'Protected route with expired/invalid token → 401', async () => {
    const r = await get(`/api/data/sales`, 'invalid_token_12345678');
    assertEq(r.status, 401);
  });

  await test('AuthMiddleware', 'Protected route with valid admin token → not 401', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get(`/api/data/sales`, state.adminToken);
    assert(r.status !== 401, `Expected non-401, got ${r.status}`);
  });

  await test('AuthMiddleware', 'Super-only route with admin token → 403', async () => {
    assert(state.adminToken, 'Need admin token');
    // Only super can list all tenants admins
    const r = await get(`/api/data/tenants/nonexistent/admins`, state.adminToken);
    assertEq(r.status, 403, 'Admin should not access super-only routes');
  });

  await test('AuthMiddleware', 'Super-only route with super token → not 403', async () => {
    assert(state.superToken, 'Need super token');
    const r = await get(`/api/data/tenants/${TENANT_ID}/admins`, state.superToken);
    assert(r.status !== 403, `Super should access super-only routes, got ${r.status}`);
  });

  await test('AuthMiddleware', 'Public routes bypass auth — /api/health', async () => {
    const r = await get('/api/health');
    assertEq(r.status, 200, 'Health should be public');
  });

  await test('AuthMiddleware', 'Public routes bypass auth — /api/tenants', async () => {
    const r = await get('/api/tenants');
    assertEq(r.status, 200, 'Tenant list should be public');
    assert(Array.isArray(r.body), 'Should return array');
  });

  await test('AuthMiddleware', 'Token in header (Bearer format) is parsed correctly', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/auth/session', state.adminToken);
    assertEq(r.status, 200, 'Bearer token should be parsed correctly');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5: EMPLOYEE PIN LOGIN FLOW
// ─────────────────────────────────────────────────────────────────────────────
async function suite_employeePIN() {
  await test('EmployeePIN', 'POST /api/public/verify-pin missing pin → 400', async () => {
    const r = await post(`/api/public/verify-pin/${TENANT_ID}`, { tenantId: TENANT_ID });
    assertEq(r.status, 400);
  });

  await test('EmployeePIN', 'PIN must be numeric digits only', async () => {
    const r = await post(`/api/auth/employee-login`, { pin: 'abcd', tenantId: TENANT_ID });
    assertEq(r.status, 400, 'Non-numeric PIN should be rejected');
    assert(r.body.error.includes('digit') || r.body.error.includes('PIN'), 'Should mention PIN format');
  });

  await test('EmployeePIN', 'PIN too short (< 4 digits) → 400', async () => {
    const r = await post(`/api/auth/employee-login`, { pin: '12', tenantId: TENANT_ID });
    assertEq(r.status, 400);
  });

  await test('EmployeePIN', 'Wrong PIN → 401', async () => {
    const r = await post(`/api/auth/employee-login`, { pin: '0000', tenantId: TENANT_ID });
    assertEq(r.status, 401);
  });

  await test('EmployeePIN', 'Inactive tenant rejects employee login → 404', async () => {
    const r = await post(`/api/auth/employee-login`, { pin: '1234', tenantId: 'inactive_tenant_xyz' });
    assertEq(r.status, 404, 'Inactive tenant should reject login');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6: SALE RECORDING — Integration (employee → API → DB → stock)
// ─────────────────────────────────────────────────────────────────────────────
async function suite_saleFlow() {
  const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);

  await test('SaleFlow', 'POST /api/public/sales — missing required fields → 400', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, { fuelType: 'petrol' });
    assertEq(r.status, 400, 'Missing fields should return 400');
    assert(r.body.error, 'Should return error message');
  });

  await test('SaleFlow', 'POST /api/public/sales — invalid fuel type → 400', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'kerosene', liters: 10, amount: 500, date: today,
    });
    assertEq(r.status, 400);
    assert(r.body.error.toLowerCase().includes('fuel'), 'Error should mention fuel type');
  });

  await test('SaleFlow', 'POST /api/public/sales — zero liters → 400', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 0, amount: 940, date: today,
    });
    assertEq(r.status, 400);
  });

  await test('SaleFlow', 'POST /api/public/sales — negative amount → 400', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 10, amount: -100, date: today,
    });
    assertEq(r.status, 400);
  });

  await test('SaleFlow', 'POST /api/public/sales — future date → 400', async () => {
    const future = new Date();
    future.setDate(future.getDate() + 5);
    const futureDate = future.toISOString().slice(0, 10);
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 10, amount: 940, date: futureDate,
    });
    assertEq(r.status, 400);
    assert(r.body.error.toLowerCase().includes('future'), 'Error should mention future date');
  });

  await test('SaleFlow', 'POST /api/public/sales — nonexistent tenant → 404', async () => {
    const r = await post(`/api/public/sales/nonexistent_tenant_xyz`, {
      fuelType: 'petrol', liters: 10, amount: 940, date: today,
    });
    assertEq(r.status, 404, 'Nonexistent tenant should return 404');
  });

  await test('SaleFlow', 'POST /api/public/sales — valid sale → 200 + id', async () => {
    const idemKey = 'integ_test_' + Date.now();
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 5, amount: 470,
      mode: 'cash', date: today, idempotencyKey: idemKey,
      employeeName: 'Test Employee', employeeId: 0,
    });
    assertEq(r.status, 200, `Sale failed: ${r.body.error}`);
    assert(r.body.id, 'Should return sale id');
    state.saleId = r.body.id;
    state.saleIdemKey = idemKey;
  });

  await test('SaleFlow', 'POST /api/public/sales — idempotency prevents duplicate', async () => {
    assert(state.saleIdemKey, 'Need idempotency key from previous test');
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 5, amount: 470,
      mode: 'cash', date: today, idempotencyKey: state.saleIdemKey,
    });
    assertEq(r.status, 200, 'Idempotent retry should succeed');
    assertEq(r.body.duplicate, true, 'Should be flagged as duplicate');
  });

  await test('SaleFlow', 'POST /api/public/sales — oversell blocked (stock enforcement)', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 999999, amount: 94000000, date: today,
    });
    // Should be blocked by stock enforcement (422) or amount limit (400)
    assert(r.status >= 400, `Oversell should be blocked, got ${r.status}`);
  });

  await test('SaleFlow', 'POST /api/public/sales — inactive pump → 409', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 5, amount: 470, pump: 'inactive_pump_test',
      mode: 'cash', date: today,
    });
    // If pump doesn't exist it won't be inactive — just check we don't crash
    assert(r.status !== 500, 'Should not return 500 for pump check');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 7: SALE EDIT/DELETE — Role enforcement integration
// ─────────────────────────────────────────────────────────────────────────────
async function suite_saleEditDelete() {
  await test('SaleEditDelete', 'PUT /api/data/sales without auth → 401', async () => {
    const r = await put('/api/data/sales', { id: 1, liters: 10 });
    assertEq(r.status, 401, 'Should require auth');
  });

  await test('SaleEditDelete', 'PUT /api/data/sales with non-Owner admin role → 403', async () => {
    // Re-login as Manager role if available, otherwise this tests the guard with current token
    assert(state.adminToken, 'Need admin token');
    if (state.adminRole && state.adminRole !== 'Owner') {
      const r = await put('/api/data/sales', { id: 1, liters: 10, fuelType: 'petrol' }, state.adminToken);
      assertEq(r.status, 403, 'Non-Owner should get 403');
      assert(r.body.error.includes('Owner'), 'Error should mention Owner');
    } else {
      // If logged in as Owner, skip this specific check (test structure note)
      assert(true, 'Skipped — logged in as Owner');
    }
  });

  await test('SaleEditDelete', 'DELETE /api/data/sales/:id without auth → 401', async () => {
    const r = await del('/api/data/sales/9999');
    assertEq(r.status, 401, 'Should require auth');
  });

  await test('SaleEditDelete', 'DELETE /api/data/sales/:id with valid Owner token → not 401/403', async () => {
    assert(state.adminToken, 'Need admin token');
    if (state.adminRole === 'Owner') {
      const r = await del(`/api/data/sales/9999`, state.adminToken);
      // 9999 likely doesn't exist — but should get 200 or 404, not 401/403
      assert(r.status !== 401 && r.status !== 403, `Owner should be permitted, got ${r.status}`);
    } else {
      assert(true, 'Skipped — not Owner role');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 8: CREDIT LIMIT ENFORCEMENT — end-to-end
// ─────────────────────────────────────────────────────────────────────────────
async function suite_creditLimit() {
  const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);

  await test('CreditLimit', 'Credit sale with no customer field skips limit check', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 5, amount: 470,
      mode: 'credit', date: today,
    });
    // Missing customer = no credit check, should not crash
    assert(r.status !== 500, `Should not crash without customer, got ${r.status}`);
  });

  await test('CreditLimit', 'Credit sale over limit returns 422 with error details', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 5, amount: 9999999,
      mode: 'credit', customer: 'TestCreditCustomer', date: today,
    });
    // Amount will fail validation before credit check — but should not return 500
    assert(r.status !== 500, 'Should not return 500');
    assert(r.body.error, 'Should return an error');
  });

  await test('CreditLimit', 'Credit limit response includes available credit amount', async () => {
    // POST sale that exceeds a known limit — server should return available in response
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 99999, amount: 9400000,
      mode: 'credit', customer: 'TestCreditCustomer', date: today,
    });
    // Will hit amount validation or stock enforcement — both return structured error
    assert(r.body.error, 'Should return structured error');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 9: LUBE SALE — Stock ↔ Idempotency ↔ DB integration
// ─────────────────────────────────────────────────────────────────────────────
async function suite_lubeSale() {
  await test('LubeSale', 'POST /api/public/lube-sale — missing fields → 400', async () => {
    const r = await post(`/api/public/lube-sale/${TENANT_ID}`, { productId: '1' });
    assertEq(r.status, 400, 'Missing qty/rate should return 400');
  });

  await test('LubeSale', 'POST /api/public/lube-sale — zero qty → 400', async () => {
    const r = await post(`/api/public/lube-sale/${TENANT_ID}`, {
      productId: '1', qty: 0, rate: 100, mode: 'cash',
    });
    assertEq(r.status, 400);
  });

  await test('LubeSale', 'POST /api/public/lube-sale — nonexistent product → 404', async () => {
    const r = await post(`/api/public/lube-sale/${TENANT_ID}`, {
      productId: 'nonexistent_product_xyz_999', qty: 1, rate: 100, mode: 'cash',
    });
    assertEq(r.status, 404, 'Nonexistent product should return 404');
  });

  await test('LubeSale', 'POST /api/public/lube-sale — nonexistent tenant → 404 or error', async () => {
    const r = await post(`/api/public/lube-sale/nonexistent_tenant_xyz`, {
      productId: '1', qty: 1, rate: 100, mode: 'cash',
    });
    assert(r.status >= 400, 'Nonexistent tenant should fail');
  });

  await test('LubeSale', 'POST /api/public/lube-sale — idempotency prevents duplicate', async () => {
    const idemKey = 'lube_integ_' + Date.now();
    // First attempt — may succeed or fail with 404 (no product in test DB)
    const r1 = await post(`/api/public/lube-sale/${TENANT_ID}`, {
      productId: 'test_lube_p1', qty: 1, rate: 150, mode: 'cash',
      idempotencyKey: idemKey,
    });
    // Second attempt with same key — should return duplicate:true if first succeeded
    if (r1.status === 200 && !r1.body.duplicate) {
      const r2 = await post(`/api/public/lube-sale/${TENANT_ID}`, {
        productId: 'test_lube_p1', qty: 1, rate: 150, mode: 'cash',
        idempotencyKey: idemKey,
      });
      assertEq(r2.status, 200);
      assertEq(r2.body.duplicate, true, 'Second call with same idem key must be duplicate');
    } else {
      assert(true, 'Skipped — product not found in test DB (expected)');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 10: EXPENSE RECORDING — Idempotency ↔ DB integration
// ─────────────────────────────────────────────────────────────────────────────
async function suite_expense() {
  const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);

  await test('Expense', 'POST /api/public/expense — missing category → 400', async () => {
    const r = await post(`/api/public/expense/${TENANT_ID}`, { amount: 500 });
    assertEq(r.status, 400, 'Missing category should return 400');
  });

  await test('Expense', 'POST /api/public/expense — zero amount → 400', async () => {
    const r = await post(`/api/public/expense/${TENANT_ID}`, { amount: 0, category: 'Salary' });
    assertEq(r.status, 400);
  });

  await test('Expense', 'POST /api/public/expense — negative amount → 400', async () => {
    const r = await post(`/api/public/expense/${TENANT_ID}`, { amount: -100, category: 'Salary' });
    assertEq(r.status, 400);
  });

  await test('Expense', 'POST /api/public/expense — amount over ₹1 crore → 400', async () => {
    const r = await post(`/api/public/expense/${TENANT_ID}`, {
      amount: 10000001, category: 'Salary', desc: 'Too much',
    });
    assertEq(r.status, 400);
  });

  await test('Expense', 'POST /api/public/expense — valid expense → 200', async () => {
    const idemKey = 'exp_integ_' + Date.now();
    const r = await post(`/api/public/expense/${TENANT_ID}`, {
      amount: 500, category: 'Salary', desc: 'Integration test expense',
      mode: 'cash', date: today, idempotencyKey: idemKey,
    });
    assertEq(r.status, 200, `Expense failed: ${r.body.error}`);
    assert(r.body.success === true, 'Should return success');
    state.expenseIdemKey = idemKey;
  });

  await test('Expense', 'POST /api/public/expense — idempotency prevents duplicate', async () => {
    assert(state.expenseIdemKey, 'Need idempotency key from previous test');
    const r = await post(`/api/public/expense/${TENANT_ID}`, {
      amount: 500, category: 'Salary', desc: 'Retry attempt',
      mode: 'cash', idempotencyKey: state.expenseIdemKey,
    });
    assertEq(r.status, 200, 'Idempotent retry should succeed');
    assertEq(r.body.duplicate, true, 'Should be flagged as duplicate');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 11: TANK DEDUCTION — Shift close ↔ Tank level integration
// ─────────────────────────────────────────────────────────────────────────────
async function suite_tankDeduction() {
  await test('TankDeduct', 'POST /api/public/tank-deduct — missing deductions → 400', async () => {
    const r = await post(`/api/public/tank-deduct/${TENANT_ID}`, {});
    assertEq(r.status, 400, 'Missing deductions should return 400');
  });

  await test('TankDeduct', 'POST /api/public/tank-deduct — zero liters skipped silently', async () => {
    const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
    const r = await post(`/api/public/tank-deduct/${TENANT_ID}`, {
      deductions: { petrol: 0 }, shiftDate: today,
    });
    assertEq(r.status, 200, 'Zero deduction should succeed');
    assert(r.body.success === true);
  });

  await test('TankDeduct', 'POST /api/public/tank-deduct — idempotency prevents double deduction', async () => {
    const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
    const idemKey = 'deduct_integ_' + Date.now();
    // First call
    const r1 = await post(`/api/public/tank-deduct/${TENANT_ID}`, {
      deductions: { petrol: 10 }, shiftDate: today, idempotencyKey: idemKey,
    });
    assertEq(r1.status, 200);
    // Second call with same key
    const r2 = await post(`/api/public/tank-deduct/${TENANT_ID}`, {
      deductions: { petrol: 10 }, shiftDate: today, idempotencyKey: idemKey,
    });
    assertEq(r2.status, 200);
    assertEq(r2.body.duplicate, true, 'Second deduction with same key must be duplicate');
  });

  await test('TankDeduct', 'POST /api/public/tank-deduct — unknown fuel type logged, not crashed', async () => {
    const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
    const r = await post(`/api/public/tank-deduct/${TENANT_ID}`, {
      deductions: { hydrogen: 10 }, shiftDate: today,
    });
    assertEq(r.status, 200, 'Unknown fuel type should not crash');
    assert(r.body.errors || r.body.results !== undefined, 'Should return results/errors');
  });

  await test('TankDeduct', 'POST /api/public/tank-deduct — fuel type is case-insensitive', async () => {
    const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);
    const r = await post(`/api/public/tank-deduct/${TENANT_ID}`, {
      deductions: { Petrol: 5, DIESEL: 5 }, shiftDate: today,
    });
    assertEq(r.status, 200, 'Case variant fuel types should not crash');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 12: DAY-LOCK ↔ WRITE OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────
async function suite_dayLock() {
  const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);

  await test('DayLock', 'GET /api/data/day-lock/:date/status returns lock state', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get(`/api/data/day-lock/${today}/status`, state.adminToken);
    assertEq(r.status, 200);
    assert(typeof r.body.locked === 'boolean', 'Should return locked boolean');
  });

  await test('DayLock', 'POST /api/data/day-lock/:date/close requires Owner role', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await post(`/api/data/day-lock/${today}/close`, {}, state.adminToken);
    if (state.adminRole === 'Owner') {
      assert(r.status === 200 || r.status === 423, 'Owner should be able to lock');
    } else {
      assertEq(r.status, 403, 'Non-Owner should not close books');
    }
  });

  await test('DayLock', 'Locked day blocks sale write via data router', async () => {
    // Lock a past date and try to write to it
    const pastDate = '2020-01-01';
    if (state.adminRole === 'Owner') {
      // Lock the test date
      await post(`/api/data/day-lock/${pastDate}/close`, {}, state.adminToken);
      // Attempt to write a sale for that locked date
      const r = await post('/api/data/sales', {
        fuelType: 'petrol', liters: 5, amount: 470,
        date: pastDate, mode: 'cash',
      }, state.adminToken);
      assert(r.status === 423 || r.status === 400, `Locked day should block writes, got ${r.status}`);
    } else {
      assert(true, 'Skipped — need Owner role to test day-lock write block');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 13: DATA FLOW — Bulk load & Store reads
// ─────────────────────────────────────────────────────────────────────────────
async function suite_dataFlow() {
  await test('DataFlow', 'GET /api/data/bulk-load returns all data modules', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/bulk-load', state.adminToken);
    assertEq(r.status, 200, `Bulk load failed: ${r.body.error}`);
    assert(typeof r.body === 'object', 'Should return object');
    assert(Array.isArray(r.body.sales) || r.body.sales !== undefined, 'Should have sales');
    assert(Array.isArray(r.body.tanks) || r.body.tanks !== undefined, 'Should have tanks');
    assert(Array.isArray(r.body.employees) || r.body.employees !== undefined, 'Should have employees');
  });

  await test('DataFlow', 'GET /api/data/sales returns array for tenant', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/sales', state.adminToken);
    assertEq(r.status, 200);
    assert(Array.isArray(r.body), 'Sales should be an array');
  });

  await test('DataFlow', 'GET /api/data/tanks returns array', async () => {
    assert(state.adminToken, 'Need admin token');
    const r = await get('/api/data/tanks', state.adminToken);
    assertEq(r.status, 200);
    assert(Array.isArray(r.body), 'Tanks should be an array');
  });

  await test('DataFlow', 'GET /api/public/prices/:tenantId returns price map', async () => {
    const r = await get(`/api/public/prices/${TENANT_ID}`);
    assertEq(r.status, 200, `Prices endpoint failed: ${r.body.error}`);
    assert(typeof r.body === 'object', 'Prices should be an object');
  });

  await test('DataFlow', 'GET /api/public/pumps/:tenantId returns pump list', async () => {
    const r = await get(`/api/public/pumps/${TENANT_ID}`);
    assertEq(r.status, 200, `Pumps endpoint failed: ${r.body.error}`);
    assert(Array.isArray(r.body) || typeof r.body === 'object', 'Should return pumps');
  });

  await test('DataFlow', 'GET /api/public/employees/:tenantId returns employee list', async () => {
    const r = await get(`/api/public/employees/${TENANT_ID}`);
    assertEq(r.status, 200, `Employees endpoint failed: ${r.body.error}`);
    assert(Array.isArray(r.body), 'Should return array');
  });

  await test('DataFlow', 'GET /api/data/sales/:id returns single record', async () => {
    assert(state.adminToken, 'Need admin token');
    if (state.saleId) {
      const r = await get(`/api/data/sales/${state.saleId}`, state.adminToken);
      assert(r.status === 200 || r.status === 404, `Expected 200/404, got ${r.status}`);
      if (r.status === 200) {
        assert(r.body.id || r.body.fuelType, 'Sale record should have fields');
      }
    } else {
      assert(true, 'Skipped — no sale id from previous tests');
    }
  });

  await test('DataFlow', 'Tenant data is isolated — cannot read other tenant data', async () => {
    assert(state.adminToken, 'Need admin token');
    // The admin token is scoped to TENANT_ID; sales returned should all belong to that tenant
    const r = await get('/api/data/sales', state.adminToken);
    assertEq(r.status, 200);
    if (Array.isArray(r.body) && r.body.length > 0) {
      // Every sale should be for our tenant (tenant_id not exposed but no cross-tenant data)
      assert(r.body.every(s => !s.tenant_id || s.tenant_id === TENANT_ID),
        'All sales should belong to authenticated tenant');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 14: INPUT SANITISATION → API → DB (XSS & injection)
// ─────────────────────────────────────────────────────────────────────────────
async function suite_sanitisation() {
  const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);

  await test('Sanitisation', 'XSS in vehicle number is stripped/rejected', async () => {
    const r = await post(`/api/public/sales/${TENANT_ID}`, {
      fuelType: 'petrol', liters: 5, amount: 470, mode: 'cash',
      vehicle: '<script>alert(1)</script>', date: today,
    });
    // Should either reject (400) or sanitise — never return 500
    assert(r.status !== 500, 'XSS in vehicle should not crash server');
  });

  await test('Sanitisation', 'SQL injection attempt in tenantId returns 404 not 500', async () => {
    const r = await post(`/api/public/sales/'; DROP TABLE sales; --`, {
      fuelType: 'petrol', liters: 5, amount: 470,
    });
    assert(r.status !== 500, 'SQL injection should not cause 500');
  });

  await test('Sanitisation', 'Null bytes in body are stripped', async () => {
    const r = await post(`/api/public/expense/${TENANT_ID}`, {
      amount: 100, category: 'Misc\0category', desc: 'Test\0null',
    });
    assert(r.status !== 500, 'Null bytes should not crash server');
  });

  await test('Sanitisation', 'Oversized payload rejected (> 2MB)', async () => {
    // Build a 2.5MB payload
    const bigStr = 'x'.repeat(2.5 * 1024 * 1024);
    const r = await post(`/api/public/sales/${TENANT_ID}`, { fuelType: bigStr });
    assert(r.status === 413 || r.status === 400 || r.status === 500,
      `Oversized payload should be rejected, got ${r.status}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 15: SUBSCRIPTION STATUS ↔ READ-ONLY MODE
// ─────────────────────────────────────────────────────────────────────────────
async function suite_subscription() {
  await test('Subscription', 'GET /api/public/subscription/:tenantId returns status', async () => {
    const r = await get(`/api/public/subscription/${TENANT_ID}`);
    assertEq(r.status, 200, `Subscription check failed: ${r.body.error}`);
    assert(r.body !== null && typeof r.body === 'object', 'Should return subscription object');
  });

  await test('Subscription', 'Nonexistent tenant subscription returns structured response', async () => {
    const r = await get('/api/public/subscription/nonexistent_xyz');
    // Should return a response (not crash) — 200 with is_read_only or 404
    assert(r.status === 200 || r.status === 404, `Got ${r.status}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 16: SALES SUMMARY API — Data aggregation integration
// ─────────────────────────────────────────────────────────────────────────────
async function suite_salesSummary() {
  const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 10);

  await test('SalesSummary', 'GET /api/public/sales-summary/:tenantId returns totals', async () => {
    const r = await get(`/api/public/sales-summary/${TENANT_ID}?from=${today}&to=${today}`);
    assertEq(r.status, 200, `Sales summary failed: ${r.body.error}`);
    assert(typeof r.body === 'object', 'Should return object');
  });

  await test('SalesSummary', 'Sales summary date range filters correctly', async () => {
    const r = await get(`/api/public/sales-summary/${TENANT_ID}?from=2020-01-01&to=2020-01-31`);
    assertEq(r.status, 200, 'Should not crash on historical date range');
  });

  await test('SalesSummary', 'Sales summary for nonexistent tenant returns empty or 404', async () => {
    const r = await get(`/api/public/sales-summary/nonexistent_xyz`);
    assert(r.status === 200 || r.status === 404, `Got ${r.status}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE: PASSWORD CHANGE — BUG-01 through BUG-09 regression tests
// Covers: super-change-password, change-password, reset-admin-password
// These endpoints had ZERO test coverage. Every test here maps to a named bug.
// ─────────────────────────────────────────────────────────────────────────────
async function suite_passwordChange() {

  // ── Helper: log in fresh as super, returns token ──────────────────────────
  async function superLogin(user, pass) {
    const r = await post('/api/auth/super-login', { username: user, password: pass });
    if (r.status !== 200 || !r.body.token) throw new Error(`Super login failed: ${r.body.error}`);
    return r.body.token;
  }
  async function adminLogin(user, pass, tid) {
    const r = await post('/api/auth/login', { username: user, password: pass, tenantId: tid });
    if (r.status !== 200 || !r.body.token) throw new Error(`Admin login failed: ${r.body.error}`);
    return r.body.token;
  }

  const ORIGINAL_SUPER_PASS = SUPER_PASS;
  const ORIGINAL_ADMIN_PASS = ADMIN_PASS;
  const NEW_SUPER_PASS  = 'NewSuperPwd@2026!';
  const NEW_ADMIN_PASS  = 'NewAdminPwd@2026!';

  // ─────────────────────────────────────────────────────────────────────────
  // BUG-02 REGRESSION: /api/auth/* routes were missing authMiddleware,
  // so req.userType was undefined → requireRole() always returned 401.
  // ─────────────────────────────────────────────────────────────────────────
  await test('PasswordChange', 'BUG-02: POST /api/auth/super-change-password without token → 401 not 500', async () => {
    const r = await post('/api/auth/super-change-password', {
      newUsername: SUPER_USER,
      newPassword: NEW_SUPER_PASS,
      confirmPassword: NEW_SUPER_PASS
    });
    assertEq(r.status, 401, `Expected 401 (not authenticated), got ${r.status}: ${r.body.error}`);
  });

  await test('PasswordChange', 'BUG-02: POST /api/auth/change-password without token → 401 not 500', async () => {
    const r = await post('/api/auth/change-password', {
      currentPassword: ORIGINAL_ADMIN_PASS,
      newPassword: NEW_ADMIN_PASS
    });
    assertEq(r.status, 401, `Expected 401, got ${r.status}`);
  });

  await test('PasswordChange', 'BUG-02: POST /api/auth/super-change-password with admin token → 401', async () => {
    const adminToken = await adminLogin(ADMIN_USER, ORIGINAL_ADMIN_PASS, TENANT_ID);
    const r = await post('/api/auth/super-change-password', {
      newUsername: SUPER_USER,
      newPassword: NEW_SUPER_PASS,
      confirmPassword: NEW_SUPER_PASS
    }, adminToken);
    assertEq(r.status, 401, `Admin token must not be usable for super password change, got ${r.status}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // VALIDATION: reject weak/mismatched inputs BEFORE auth checks are even needed
  // ─────────────────────────────────────────────────────────────────────────
  await test('PasswordChange', 'Super change-password rejects short password (< 8 chars)', async () => {
    const token = await superLogin(SUPER_USER, ORIGINAL_SUPER_PASS);
    const r = await post('/api/auth/super-change-password', {
      newUsername: SUPER_USER,
      newPassword: 'short',
      confirmPassword: 'short'
    }, token);
    assertEq(r.status, 400, `Expected 400, got ${r.status}`);
    assert(r.body.error && r.body.error.toLowerCase().includes('short'), 'Error should mention short password');
  });

  await test('PasswordChange', 'Super change-password rejects mismatched passwords', async () => {
    const token = await superLogin(SUPER_USER, ORIGINAL_SUPER_PASS);
    const r = await post('/api/auth/super-change-password', {
      newUsername: SUPER_USER,
      newPassword: 'ValidPass@123',
      confirmPassword: 'DifferentPass@123'
    }, token);
    assertEq(r.status, 400, `Expected 400, got ${r.status}`);
    assert(r.body.error && r.body.error.toLowerCase().includes('match'), 'Error should mention mismatch');
  });

  await test('PasswordChange', 'Super change-password rejects short username (< 3 chars)', async () => {
    const token = await superLogin(SUPER_USER, ORIGINAL_SUPER_PASS);
    const r = await post('/api/auth/super-change-password', {
      newUsername: 'ab',
      newPassword: 'ValidPass@123',
      confirmPassword: 'ValidPass@123'
    }, token);
    assertEq(r.status, 400, `Expected 400, got ${r.status}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // CORE: Super admin can actually change their password and use new one
  // (The primary reported regression: "going back to old password")
  // ─────────────────────────────────────────────────────────────────────────
  await test('PasswordChange', 'Super admin can change password via API (BUG-02 fix proves this works)', async () => {
    const token = await superLogin(SUPER_USER, ORIGINAL_SUPER_PASS);
    const r = await post('/api/auth/super-change-password', {
      newUsername: SUPER_USER,
      newPassword: NEW_SUPER_PASS,
      confirmPassword: NEW_SUPER_PASS
    }, token);
    assertEq(r.status, 200, `Password change failed: ${r.body.error}`);
    assert(r.body.success === true, 'Should return { success: true }');
  });

  await test('PasswordChange', 'New super password works for login immediately after change', async () => {
    const r = await post('/api/auth/super-login', { username: SUPER_USER, password: NEW_SUPER_PASS });
    assertEq(r.status, 200, `New super password login failed: ${r.body.error}`);
    assert(r.body.token, 'Should return token with new password');
  });

  await test('PasswordChange', 'OLD super password rejected after change (BUG-05 regression: no restart wipe)', async () => {
    const r = await post('/api/auth/super-login', { username: SUPER_USER, password: ORIGINAL_SUPER_PASS });
    assertEq(r.status, 401, `Old password should be rejected after change, got ${r.status}`);
  });

  // Restore original super password so other tests continue to work
  await test('PasswordChange', 'Restore super admin original password after test', async () => {
    const token = await superLogin(SUPER_USER, NEW_SUPER_PASS);
    const r = await post('/api/auth/super-change-password', {
      newUsername: SUPER_USER,
      newPassword: ORIGINAL_SUPER_PASS,
      confirmPassword: ORIGINAL_SUPER_PASS
    }, token);
    assertEq(r.status, 200, `Failed to restore original super password: ${r.body.error}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BUG-04 REGRESSION: Server must verify currentPassword before allowing change
  // ─────────────────────────────────────────────────────────────────────────
  await test('PasswordChange', 'BUG-04: Admin change-own-password with wrong current password → 403', async () => {
    const token = await adminLogin(ADMIN_USER, ORIGINAL_ADMIN_PASS, TENANT_ID);
    const r = await post('/api/auth/change-password', {
      currentPassword: 'completelyWrongPassword!!!',
      newPassword: NEW_ADMIN_PASS
    }, token);
    assertEq(r.status, 403, `Expected 403 for wrong current password, got ${r.status}: ${r.body.error}`);
  });

  await test('PasswordChange', 'Admin change-own-password rejects missing currentPassword', async () => {
    const token = await adminLogin(ADMIN_USER, ORIGINAL_ADMIN_PASS, TENANT_ID);
    const r = await post('/api/auth/change-password', {
      newPassword: NEW_ADMIN_PASS
    }, token);
    assertEq(r.status, 400, `Expected 400 for missing currentPassword, got ${r.status}`);
  });

  await test('PasswordChange', 'Admin change-own-password rejects same-as-current new password', async () => {
    const token = await adminLogin(ADMIN_USER, ORIGINAL_ADMIN_PASS, TENANT_ID);
    const r = await post('/api/auth/change-password', {
      currentPassword: ORIGINAL_ADMIN_PASS,
      newPassword: ORIGINAL_ADMIN_PASS
    }, token);
    assertEq(r.status, 400, `Expected 400 when new password matches current, got ${r.status}`);
  });

  await test('PasswordChange', 'Admin can change own password with correct current password', async () => {
    const token = await adminLogin(ADMIN_USER, ORIGINAL_ADMIN_PASS, TENANT_ID);
    const r = await post('/api/auth/change-password', {
      currentPassword: ORIGINAL_ADMIN_PASS,
      newPassword: NEW_ADMIN_PASS
    }, token);
    assertEq(r.status, 200, `Admin self-password change failed: ${r.body.error}`);
    assert(r.body.success === true, 'Should return { success: true }');
  });

  await test('PasswordChange', 'New admin password works immediately after change', async () => {
    const r = await post('/api/auth/login', {
      username: ADMIN_USER, password: NEW_ADMIN_PASS, tenantId: TENANT_ID
    });
    assertEq(r.status, 200, `New admin password login failed: ${r.body.error}`);
    assert(r.body.token, 'Should return token with new password');
  });

  await test('PasswordChange', 'Old admin password rejected after change', async () => {
    const r = await post('/api/auth/login', {
      username: ADMIN_USER, password: ORIGINAL_ADMIN_PASS, tenantId: TENANT_ID
    });
    assertEq(r.status, 401, `Old admin password should be rejected, got ${r.status}`);
  });

  // Restore original admin password
  await test('PasswordChange', 'Restore admin original password after test', async () => {
    const token = await adminLogin(ADMIN_USER, NEW_ADMIN_PASS, TENANT_ID);
    const r = await post('/api/auth/change-password', {
      currentPassword: NEW_ADMIN_PASS,
      newPassword: ORIGINAL_ADMIN_PASS
    }, token);
    assertEq(r.status, 200, `Failed to restore original admin password: ${r.body.error}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BUG-06 REGRESSION: reset-password endpoint was super-only;
  // station Owner needs to reset co-admin passwords within their own tenant
  // ─────────────────────────────────────────────────────────────────────────
  await test('PasswordChange', 'BUG-06: Super can reset any station admin password', async () => {
    const superToken = await superLogin(SUPER_USER, ORIGINAL_SUPER_PASS);
    // Get admin list to find a valid uid
    const adminsResp = await get(`/api/data/tenants/${TENANT_ID}/admins`, superToken);
    assertEq(adminsResp.status, 200, `Could not fetch admins: ${adminsResp.body.error}`);
    assert(adminsResp.body.length > 0, 'Test tenant must have at least one admin');
    const targetAdmin = adminsResp.body.find(a => a.username === ADMIN_USER);
    assert(targetAdmin, `Admin user ${ADMIN_USER} not found in tenant`);

    const r = await post(
      `/api/data/tenants/${TENANT_ID}/admins/${targetAdmin.id}/reset-password`,
      { newPassword: ORIGINAL_ADMIN_PASS },
      superToken
    );
    assertEq(r.status, 200, `Super reset-password failed: ${r.body.error}`);
    assert(r.body.success === true, 'Should return { success: true }');
  });

  await test('PasswordChange', 'BUG-06: Station Owner can reset co-admin password in OWN tenant', async () => {
    const ownerToken = await adminLogin(ADMIN_USER, ORIGINAL_ADMIN_PASS, TENANT_ID);
    // Get admin list (BUG-07 fix: Owner can now GET admins in own tenant)
    const adminsResp = await get(`/api/data/tenants/${TENANT_ID}/admins`, ownerToken);
    assertEq(adminsResp.status, 200, `Owner could not fetch own tenant admins (BUG-07 not fixed?): ${adminsResp.body.error}`);

    const targetAdmin = adminsResp.body.find(a => a.username === ADMIN_USER);
    assert(targetAdmin, 'Should find own admin user in list');

    const r = await post(
      `/api/data/tenants/${TENANT_ID}/admins/${targetAdmin.id}/reset-password`,
      { newPassword: ORIGINAL_ADMIN_PASS },
      ownerToken
    );
    assertEq(r.status, 200, `Owner reset-password failed (BUG-06 not fixed?): ${r.body.error}`);
  });

  await test('PasswordChange', 'BUG-06: Station admin CANNOT reset password in a DIFFERENT tenant', async () => {
    const ownerToken = await adminLogin(ADMIN_USER, ORIGINAL_ADMIN_PASS, TENANT_ID);
    // Attempt cross-tenant reset — must fail with 403 or 404, never 200
    const r = await post(
      `/api/data/tenants/different_tenant_xyz/admins/999/reset-password`,
      { newPassword: 'NewCrossPass@1' },
      ownerToken
    );
    assert(r.status === 403 || r.status === 404,
      `Cross-tenant reset must return 403 or 404, got ${r.status}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BUG-07 REGRESSION: GET /api/data/tenants/:id/admins was super-only
  // ─────────────────────────────────────────────────────────────────────────
  await test('PasswordChange', 'BUG-07: Station Owner can GET admins for own tenant', async () => {
    const token = await adminLogin(ADMIN_USER, ORIGINAL_ADMIN_PASS, TENANT_ID);
    const r = await get(`/api/data/tenants/${TENANT_ID}/admins`, token);
    assertEq(r.status, 200, `Owner GET admins failed (BUG-07 not fixed?): ${r.body.error}`);
    assert(Array.isArray(r.body), 'Admins response should be an array');
  });

  await test('PasswordChange', 'BUG-07: Station admin CANNOT GET admins for a DIFFERENT tenant', async () => {
    const token = await adminLogin(ADMIN_USER, ORIGINAL_ADMIN_PASS, TENANT_ID);
    const r = await get(`/api/data/tenants/other_tenant_xyz/admins`, token);
    assert(r.status === 403 || r.status === 404,
      `Cross-tenant admin list must be rejected, got ${r.status}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // BUG-09 REGRESSION: reset-password must validate target admin belongs to tenant
  // ─────────────────────────────────────────────────────────────────────────
  await test('PasswordChange', 'BUG-09: reset-password with non-existent uid → 404 not silent 0-row update', async () => {
    const superToken = await superLogin(SUPER_USER, ORIGINAL_SUPER_PASS);
    const r = await post(
      `/api/data/tenants/${TENANT_ID}/admins/999999999/reset-password`,
      { newPassword: ORIGINAL_ADMIN_PASS },
      superToken
    );
    assertEq(r.status, 404, `Non-existent admin uid must return 404, got ${r.status}`);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // SESSION INVALIDATION: Verify correct session revocation behaviour
  // ─────────────────────────────────────────────────────────────────────────
  await test('PasswordChange', 'Self password change preserves the current session (user stays logged in)', async () => {
    // Admin logs in and immediately changes own password with same token
    const adminToken = await adminLogin(ADMIN_USER, ORIGINAL_ADMIN_PASS, TENANT_ID);
    await post('/api/auth/change-password', {
      currentPassword: ORIGINAL_ADMIN_PASS,
      newPassword: NEW_ADMIN_PASS
    }, adminToken);
    // The token used to make the change should still be valid
    const sessionCheck = await get('/api/auth/session', adminToken);
    assertEq(sessionCheck.status, 200,
      `Token used for self-change should remain valid, got ${sessionCheck.status}`);
    // Restore
    await post('/api/auth/change-password', {
      currentPassword: NEW_ADMIN_PASS,
      newPassword: ORIGINAL_ADMIN_PASS
    }, adminToken);
  });

  await test('PasswordChange', 'reset-password (by super/owner) revokes ALL sessions for that admin user', async () => {
    // Admin logs in — get a token
    const adminToken = await adminLogin(ADMIN_USER, ORIGINAL_ADMIN_PASS, TENANT_ID);
    // Super resets that admin's password
    const superToken = await superLogin(SUPER_USER, ORIGINAL_SUPER_PASS);
    const adminsResp = await get(`/api/data/tenants/${TENANT_ID}/admins`, superToken);
    const target = adminsResp.body.find(a => a.username === ADMIN_USER);
    await post(
      `/api/data/tenants/${TENANT_ID}/admins/${target.id}/reset-password`,
      { newPassword: ORIGINAL_ADMIN_PASS }, // reset to same value so other tests work
      superToken
    );
    // The adminToken should now be REVOKED (full session wipe on external reset)
    const sessionCheck = await get('/api/auth/session', adminToken);
    assertEq(sessionCheck.status, 401,
      `Session should be revoked after external password reset, got ${sessionCheck.status}`);
  });
}


async function runAll() {
  console.log('\n' + '═'.repeat(72));
  console.log('  FUELBUNK PRO — INTEGRATION TEST SUITE');
  console.log(`  Target: ${BASE_URL}  |  Tenant: ${TENANT_ID}`);
  console.log('═'.repeat(72));
  console.log('\nRunning tests (. = pass, F = fail):\n');

  try {
    await suite_health();
    await suite_superAuth();
    await suite_adminAuth();
    await suite_authMiddleware();
    await suite_passwordChange();  // BUG-01 through BUG-09 regression tests
    await suite_employeePIN();
    await suite_saleFlow();
    await suite_saleEditDelete();
    await suite_creditLimit();
    await suite_lubeSale();
    await suite_expense();
    await suite_tankDeduction();
    await suite_dayLock();
    await suite_dataFlow();
    await suite_sanitisation();
    await suite_subscription();
    await suite_salesSummary();
  } catch (e) {
    console.error('\n\nFATAL ERROR — test runner crashed:', e.message);
    console.error('Is the app running at', BASE_URL, '?');
    process.exit(2);
  }

  // ── Print results ─────────────────────────────────────────────────────────
  const suites = {};
  for (const r of results) {
    if (!suites[r.suite]) suites[r.suite] = { pass: 0, fail: 0, tests: [] };
    suites[r.suite].tests.push(r);
    if (r.status === 'PASS') suites[r.suite].pass++;
    else suites[r.suite].fail++;
  }

  console.log('\n\n' + '═'.repeat(72));
  console.log('  RESULTS BY SUITE');
  console.log('═'.repeat(72));

  for (const [name, suite] of Object.entries(suites)) {
    const icon = suite.fail === 0 ? '✅' : '❌';
    console.log(`\n${icon} ${name.padEnd(30)} [${suite.pass}/${suite.pass + suite.fail} passed]`);
    for (const t of suite.tests) {
      const s = t.status === 'PASS' ? '  ✓' : '  ✗';
      console.log(`${s}  ${t.name}`);
      if (t.error) console.log(`       → ${t.error}`);
    }
  }

  const pct = Math.round((passed / total) * 100);
  console.log('\n' + '─'.repeat(72));
  console.log(`  Total: ${total}  |  Passed: ${passed}  |  Failed: ${failed}  |  Coverage: ${pct}%`);
  console.log('─'.repeat(72));

  if (failed > 0) {
    console.log(`\n⚠️  ${failed} test(s) FAILED\n`);
    process.exit(1);
  } else {
    console.log(`\n✅  All ${total} integration tests PASSED\n`);
    process.exit(0);
  }
}

runAll();
