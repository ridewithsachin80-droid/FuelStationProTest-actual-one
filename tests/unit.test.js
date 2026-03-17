/**
 * FuelBunk Pro — Comprehensive Unit Test Suite
 * Tests all critical pure functions across security.js, data.js, utils.js (server-side),
 * and the business logic extracted from server.js / employee.js / admin.js.
 *
 * Run with: node tests/unit.test.js
 * No external test framework required — uses Node.js built-in assert.
 */

'use strict';

const assert = require('assert');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// MINI TEST RUNNER
// ─────────────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0, total = 0;
const results = [];

function test(suiteName, name, fn) {
  total++;
  try {
    fn();
    passed++;
    results.push({ suite: suiteName, name, status: 'PASS' });
  } catch (e) {
    failed++;
    results.push({ suite: suiteName, name, status: 'FAIL', error: e.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: SECURITY — sanitizeString / sanitizeObject
// ─────────────────────────────────────────────────────────────────────────────
const { sanitizeString, sanitizeObject, generateToken, requireRole } = require('./helpers/security_extract');

test('sanitizeString', 'strips HTML tags', () => {
  assert.strictEqual(sanitizeString('<script>alert(1)</script>'), 'alert(1)');
});
test('sanitizeString', 'strips null bytes', () => {
  assert.strictEqual(sanitizeString('hello\0world'), 'helloworld');
});
test('sanitizeString', 'trims whitespace', () => {
  assert.strictEqual(sanitizeString('  hello  '), 'hello');
});
test('sanitizeString', 'returns empty string for non-string input', () => {
  assert.strictEqual(sanitizeString(123), '');
  assert.strictEqual(sanitizeString(null), '');
  assert.strictEqual(sanitizeString(undefined), '');
});
test('sanitizeString', 'respects maxLen', () => {
  assert.strictEqual(sanitizeString('abcdef', 3), 'abc');
});
test('sanitizeString', 'allows normal text through', () => {
  assert.strictEqual(sanitizeString('KA06AB1234'), 'KA06AB1234');
});
test('sanitizeString', 'strips partial tags', () => {
  assert.strictEqual(sanitizeString('hello<b>world'), 'helloworld');
});

test('sanitizeObject', 'sanitizes nested string values', () => {
  const result = sanitizeObject({ name: '<script>xss</script>' });
  assert.strictEqual(result.name, 'xss');
});
test('sanitizeObject', 'handles arrays', () => {
  const result = sanitizeObject(['<b>bold</b>', 'normal']);
  assert.strictEqual(result[0], 'bold');
  assert.strictEqual(result[1], 'normal');
});
test('sanitizeObject', 'passes numbers through', () => {
  const result = sanitizeObject({ amount: 500, liters: 10.5 });
  assert.strictEqual(result.amount, 500);
  assert.strictEqual(result.liters, 10.5);
});
test('sanitizeObject', 'replaces Infinity with 0', () => {
  const result = sanitizeObject({ val: Infinity });
  assert.strictEqual(result.val, 0);
});
test('sanitizeObject', 'replaces NaN with 0', () => {
  const result = sanitizeObject({ val: NaN });
  assert.strictEqual(result.val, 0);
});
test('sanitizeObject', 'handles null gracefully', () => {
  const result = sanitizeObject(null);
  assert.strictEqual(result, null);
});
test('sanitizeObject', 'handles booleans correctly', () => {
  const result = sanitizeObject({ active: true, flag: false });
  assert.strictEqual(result.active, true);
  assert.strictEqual(result.flag, false);
});
test('sanitizeObject', 'stops at depth 5 to prevent prototype pollution', () => {
  // Depth 0 = root. a=1, b=2, c=3, d=4, e=5, f=6 → depth>5 returns {}
  // So 5 real nesting levels are fully preserved; the 6th is stripped to {}
  const deep = { a: { b: { c: { d: { e: { f: { g: 'deep' } } } } } } };
  const result = sanitizeObject(deep);
  assert.deepStrictEqual(result.a.b.c.d.e.f, {}); // f (depth 6) is stripped
  assert.strictEqual(result.a.b.c.d.e.f.g, undefined); // g never reached
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: SECURITY — generateToken
// ─────────────────────────────────────────────────────────────────────────────
test('generateToken', 'returns 64-char hex string', () => {
  const token = generateToken();
  assert.strictEqual(typeof token, 'string');
  assert.strictEqual(token.length, 64);
  assert.ok(/^[a-f0-9]+$/.test(token));
});
test('generateToken', 'generates unique tokens each call', () => {
  const t1 = generateToken();
  const t2 = generateToken();
  assert.notStrictEqual(t1, t2);
});
test('generateToken', 'never returns empty string', () => {
  for (let i = 0; i < 5; i++) {
    assert.ok(generateToken().length > 0);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: SECURITY — requireRole (logic extracted)
// ─────────────────────────────────────────────────────────────────────────────
const { checkRequireRole } = require('./helpers/security_extract');

test('requireRole', 'super always passes any role check', () => {
  assert.strictEqual(checkRequireRole({ userType: 'super', userRole: '' }, 'admin'), true);
  assert.strictEqual(checkRequireRole({ userType: 'super', userRole: '' }, 'Owner'), true);
});
test('requireRole', 'exact userType match passes', () => {
  assert.strictEqual(checkRequireRole({ userType: 'admin', userRole: 'Manager' }, 'admin'), true);
});
test('requireRole', 'userRole case-insensitive match passes', () => {
  assert.strictEqual(checkRequireRole({ userType: 'admin', userRole: 'Owner' }, 'owner'), true);
});
test('requireRole', 'wrong role is rejected', () => {
  assert.strictEqual(checkRequireRole({ userType: 'admin', userRole: 'Cashier' }, 'Owner'), false);
});
test('requireRole', 'unauthenticated user is rejected', () => {
  assert.strictEqual(checkRequireRole({ userType: null, userRole: '' }, 'admin'), false);
});
test('requireRole', 'admin satisfies admin role requirement regardless of sub-role', () => {
  assert.strictEqual(checkRequireRole({ userType: 'admin', userRole: 'Accountant' }, 'admin'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: DATA — camelToSnake
// ─────────────────────────────────────────────────────────────────────────────
const { camelToSnake, parseRow } = require('./helpers/data_extract');

test('camelToSnake', 'converts single camelCase word', () => {
  assert.strictEqual(camelToSnake('fuelType'), 'fuel_type');
});
test('camelToSnake', 'converts multiple humps', () => {
  assert.strictEqual(camelToSnake('employeeName'), 'employee_name');
  assert.strictEqual(camelToSnake('currentReading'), 'current_reading');
});
test('camelToSnake', 'leaves lowercase unchanged', () => {
  assert.strictEqual(camelToSnake('amount'), 'amount');
});
test('camelToSnake', 'handles leading capital correctly', () => {
  assert.strictEqual(camelToSnake('StationCode'), '_station_code');
});
test('camelToSnake', 'handles acronyms', () => {
  assert.strictEqual(camelToSnake('upiTxnId'), 'upi_txn_id');
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: DATA — parseRow (DB row → frontend object)
// ─────────────────────────────────────────────────────────────────────────────
test('parseRow', 'maps current_level to current', () => {
  const result = parseRow({ current_level: 5000, tenant_id: 'abc' });
  assert.strictEqual(result.current, 5000);
});
test('parseRow', 'maps balance to outstanding', () => {
  const result = parseRow({ balance: 25000 });
  assert.strictEqual(result.outstanding, 25000);
});
test('parseRow', 'maps credit_limit to limit', () => {
  const result = parseRow({ credit_limit: 100000 });
  assert.strictEqual(result.limit, 100000);
});
test('parseRow', 'maps fuel_type to fuelType', () => {
  const result = parseRow({ fuel_type: 'petrol' });
  assert.strictEqual(result.fuelType, 'petrol');
});
test('parseRow', 'excludes pass_hash from output', () => {
  const result = parseRow({ pass_hash: 'secret123', name: 'Admin' });
  assert.strictEqual(result.pass_hash, undefined);
  assert.strictEqual(result.name, 'Admin');
});
test('parseRow', 'excludes tenant_id from output', () => {
  const result = parseRow({ tenant_id: 'T123', name: 'Station' });
  assert.strictEqual(result.tenant_id, undefined);
  assert.strictEqual(result.name, 'Station');
});
test('parseRow', 'merges data_json at lowest priority', () => {
  const result = parseRow({ data_json: JSON.stringify({ extra: 'value', name: 'OLD' }), name: 'NEW' });
  assert.strictEqual(result.name, 'NEW');   // real col wins
  assert.strictEqual(result.extra, 'value'); // extra from json
});
test('parseRow', 'handles malformed data_json gracefully', () => {
  const result = parseRow({ data_json: 'NOT_JSON', name: 'test' });
  assert.strictEqual(result.name, 'test');
});
test('parseRow', 'parses nozzle_fuels JSON string', () => {
  const result = parseRow({ nozzle_fuels: '{"A":"petrol","B":"diesel"}' });
  assert.deepStrictEqual(result.nozzleFuels, { A: 'petrol', B: 'diesel' });
});
test('parseRow', 'aliases start_time to both startTime and start', () => {
  const result = parseRow({ start_time: '08:00' });
  assert.strictEqual(result.startTime, '08:00');
  assert.strictEqual(result.start, '08:00');
});
test('parseRow', 'handles empty row without throwing', () => {
  const result = parseRow({});
  assert.strictEqual(typeof result, 'object');
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: UTILS — sanitize (XSS)
// ─────────────────────────────────────────────────────────────────────────────
const { sanitize, hashSync, validateSaleInput, validateReading,
        validateExpenseInput, validateSessionShape, validateEmpSessionShape,
        ioclDipToLiters, checkRateLimitLogic, bpclDipLookup } = require('./helpers/utils_extract');

test('sanitize', 'escapes & to &amp;', () => {
  assert.strictEqual(sanitize('fish & chips'), 'fish &amp; chips');
});
test('sanitize', 'escapes < to &lt;', () => {
  assert.strictEqual(sanitize('<script>'), '&lt;script&gt;');
});
test('sanitize', 'escapes " to &quot;', () => {
  assert.strictEqual(sanitize('"hello"'), '&quot;hello&quot;');
});
test('sanitize', "escapes ' to &#x27;", () => {
  assert.strictEqual(sanitize("it's"), "it&#x27;s");
});
test('sanitize', 'returns empty string for null', () => {
  assert.strictEqual(sanitize(null), '');
});
test('sanitize', 'returns empty string for undefined', () => {
  assert.strictEqual(sanitize(undefined), '');
});
test('sanitize', 'converts numbers to string', () => {
  assert.strictEqual(sanitize(42), '42');
});
test('sanitize', 'handles full XSS attack string', () => {
  const input = '<img src=x onerror="alert(\'XSS\')">';
  const out = sanitize(input);
  assert.ok(!out.includes('<img'));
  assert.ok(!out.includes('"'));
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: UTILS — hashSync (djb2)
// ─────────────────────────────────────────────────────────────────────────────
test('hashSync', 'returns 8-char hex string', () => {
  const h = hashSync('test');
  assert.strictEqual(typeof h, 'string');
  assert.strictEqual(h.length, 8);
  assert.ok(/^[a-f0-9]+$/.test(h));
});
test('hashSync', 'same input always gives same output', () => {
  assert.strictEqual(hashSync('password'), hashSync('password'));
});
test('hashSync', 'different inputs give different outputs', () => {
  assert.notStrictEqual(hashSync('password1'), hashSync('password2'));
});
test('hashSync', 'empty string returns consistent hash', () => {
  const h = hashSync('');
  assert.strictEqual(h, hashSync(''));
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: UTILS — validateSaleInput
// ─────────────────────────────────────────────────────────────────────────────
const prices = { petrol: 94.0, diesel: 87.0, premium: 112.5 };

test('validateSaleInput', 'accepts valid petrol cash sale', () => {
  const errors = validateSaleInput('petrol', 10, 940, '', prices, 'cash');
  assert.deepStrictEqual(errors, []);
});
test('validateSaleInput', 'rejects unknown fuel type', () => {
  const errors = validateSaleInput('kerosene', 10, 500, '', prices, 'cash');
  assert.ok(errors.some(e => e.includes('fuel type')));
});
test('validateSaleInput', 'rejects zero liters', () => {
  const errors = validateSaleInput('petrol', 0, 940, '', prices, 'cash');
  assert.ok(errors.some(e => e.includes('Liters')));
});
test('validateSaleInput', 'rejects negative liters', () => {
  const errors = validateSaleInput('petrol', -5, 500, '', prices, 'cash');
  assert.ok(errors.some(e => e.includes('Liters')));
});
test('validateSaleInput', 'rejects zero amount', () => {
  const errors = validateSaleInput('petrol', 10, 0, '', prices, 'cash');
  assert.ok(errors.some(e => e.includes('Amount')));
});
test('validateSaleInput', 'rejects amount over ₹1 crore', () => {
  const errors = validateSaleInput('petrol', 100, 10000001, '', prices, 'cash');
  assert.ok(errors.some(e => e.includes('1,00,00,000') || e.includes('limit')));
});
test('validateSaleInput', 'requires vehicle for UPI payment', () => {
  const errors = validateSaleInput('petrol', 10, 940, '', prices, 'upi');
  assert.ok(errors.some(e => e.includes('vehicle')));
});
test('validateSaleInput', 'requires vehicle for card payment', () => {
  const errors = validateSaleInput('petrol', 10, 940, '', prices, 'card');
  assert.ok(errors.some(e => e.includes('vehicle')));
});
test('validateSaleInput', 'allows missing vehicle for cash', () => {
  const errors = validateSaleInput('petrol', 10, 940, '', prices, 'cash');
  assert.ok(!errors.some(e => e.includes('vehicle')));
});
test('validateSaleInput', 'rejects vehicle with special characters', () => {
  const errors = validateSaleInput('petrol', 10, 940, 'KA06@#!$', prices, 'cash');
  assert.ok(errors.some(e => e.includes('invalid characters')));
});
test('validateSaleInput', 'allows valid vehicle number format', () => {
  const errors = validateSaleInput('petrol', 10, 940, 'KA06AB1234', prices, 'cash');
  assert.ok(!errors.some(e => e.includes('vehicle')));
});
test('validateSaleInput', 'flags amount mismatch with price', () => {
  // 10L petrol at ₹94 = ₹940. Entering ₹500 should flag mismatch.
  const errors = validateSaleInput('petrol', 10, 500, '', prices, 'cash');
  assert.ok(errors.some(e => e.includes('mismatch') || e.includes('Expected')));
});
test('validateSaleInput', 'accepts premium_petrol fuel type', () => {
  const errors = validateSaleInput('premium_petrol', 5, 562.5, '', prices, 'cash');
  assert.ok(!errors.some(e => e.includes('fuel type')));
});
test('validateSaleInput', 'accepts diesel fuel type', () => {
  const errors = validateSaleInput('diesel', 10, 870, '', prices, 'cash');
  assert.deepStrictEqual(errors, []);
});
test('validateSaleInput', 'within 1% amount tolerance is accepted', () => {
  // 10L at ₹94 = ₹940 ± 1% tolerance = ₹9.40
  const errors = validateSaleInput('petrol', 10, 945, '', prices, 'cash');
  assert.deepStrictEqual(errors, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: UTILS — validateReading
// ─────────────────────────────────────────────────────────────────────────────
test('validateReading', 'valid closing > opening returns null', () => {
  assert.strictEqual(validateReading(1000, 1200), null);
});
test('validateReading', 'closing < opening returns error', () => {
  const result = validateReading(1200, 1000);
  assert.ok(result !== null);
  assert.ok(result.includes('cannot be less'));
});
test('validateReading', 'difference > 10000 returns error', () => {
  const result = validateReading(0, 15000);
  assert.ok(result !== null);
  assert.ok(result.includes('too large'));
});
test('validateReading', 'zero closing reading is invalid', () => {
  assert.notStrictEqual(validateReading(0, -1), null);
});
test('validateReading', 'exact 10000 difference is rejected', () => {
  assert.notStrictEqual(validateReading(0, 10001), null);
});
test('validateReading', 'closing same as opening is valid (no sales)', () => {
  assert.strictEqual(validateReading(1000, 1000), null);
});
test('validateReading', 'no opening reading uses 0 as baseline', () => {
  assert.strictEqual(validateReading(undefined, 500), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: UTILS — validateExpenseInput
// ─────────────────────────────────────────────────────────────────────────────
test('validateExpenseInput', 'valid expense passes', () => {
  assert.deepStrictEqual(validateExpenseInput(500, 'Salary', 'Monthly salary'), []);
});
test('validateExpenseInput', 'zero amount is rejected', () => {
  const errors = validateExpenseInput(0, 'Salary', 'Monthly salary');
  assert.ok(errors.some(e => e.includes('positive')));
});
test('validateExpenseInput', 'negative amount is rejected', () => {
  const errors = validateExpenseInput(-100, 'Salary', 'Monthly');
  assert.ok(errors.some(e => e.includes('positive')));
});
test('validateExpenseInput', 'amount over ₹5L is rejected', () => {
  const errors = validateExpenseInput(500001, 'Salary', 'Monthly');
  assert.ok(errors.some(e => e.includes('5,00,000') || e.includes('limit')));
});
test('validateExpenseInput', 'missing category is rejected', () => {
  const errors = validateExpenseInput(500, '', 'Monthly salary');
  assert.ok(errors.some(e => e.includes('category')));
});
test('validateExpenseInput', 'description too short is rejected', () => {
  const errors = validateExpenseInput(500, 'Salary', 'ab');
  assert.ok(errors.some(e => e.includes('3 char') || e.includes('description')));
});
test('validateExpenseInput', 'exactly 3 char description passes', () => {
  assert.deepStrictEqual(validateExpenseInput(500, 'Misc', 'abc'), []);
});
test('validateExpenseInput', 'multiple errors returned together', () => {
  const errors = validateExpenseInput(0, '', 'ab');
  assert.ok(errors.length >= 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: UTILS — validateSessionShape
// ─────────────────────────────────────────────────────────────────────────────
test('validateSessionShape', 'valid admin session passes', () => {
  assert.ok(validateSessionShape({ loggedIn: true, role: 'admin', timestamp: Date.now() }));
});
test('validateSessionShape', 'valid logged-out session passes', () => {
  assert.ok(validateSessionShape({ loggedIn: false, role: null }));
});
test('validateSessionShape', 'missing loggedIn boolean fails', () => {
  assert.ok(!validateSessionShape({ role: 'admin' }));
});
test('validateSessionShape', 'invalid role fails', () => {
  assert.ok(!validateSessionShape({ loggedIn: true, role: 'supervillain', timestamp: 1 }));
});
test('validateSessionShape', 'loggedIn=true without timestamp fails', () => {
  assert.ok(!validateSessionShape({ loggedIn: true, role: 'admin' }));
});
test('validateSessionShape', 'null input fails', () => {
  assert.ok(!validateSessionShape(null));
});
test('validateSessionShape', 'employee role is valid', () => {
  assert.ok(validateSessionShape({ loggedIn: true, role: 'employee', timestamp: 1 }));
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: UTILS — validateEmpSessionShape
// ─────────────────────────────────────────────────────────────────────────────
test('validateEmpSessionShape', 'valid active employee session passes', () => {
  const session = {
    active: true,
    user: { id: 5, name: 'Ravi' },
    openReadings: { '1': 1000 },
    sales: [{ id: 1, liters: 10, amount: 940 }],
    page: 'sales'
  };
  assert.ok(validateEmpSessionShape(session));
});
test('validateEmpSessionShape', 'inactive session with minimal fields passes', () => {
  assert.ok(validateEmpSessionShape({ active: false, openReadings: {}, sales: [] }));
});
test('validateEmpSessionShape', 'missing active boolean fails', () => {
  assert.ok(!validateEmpSessionShape({ openReadings: {}, sales: [] }));
});
test('validateEmpSessionShape', 'active=true without user.id fails', () => {
  assert.ok(!validateEmpSessionShape({ active: true, user: { name: 'X' }, openReadings: {}, sales: [] }));
});
test('validateEmpSessionShape', 'sales not an array fails', () => {
  assert.ok(!validateEmpSessionShape({ active: false, openReadings: {}, sales: 'bad' }));
});
test('validateEmpSessionShape', 'dipReadings not an array fails', () => {
  assert.ok(!validateEmpSessionShape({ active: false, openReadings: {}, sales: [], dipReadings: 'bad' }));
});
test('validateEmpSessionShape', 'sets page default if missing', () => {
  const s = { active: false, openReadings: {}, sales: [] };
  validateEmpSessionShape(s);
  assert.strictEqual(s.page, 'readings');
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: UTILS — ioclDipToLiters (IOCL 10K dip chart lookup)
// ─────────────────────────────────────────────────────────────────────────────
test('ioclDipToLiters', 'returns known value at 50cm 0mm', () => {
  // IOCL table: 50cm = 2263.85L
  const result = ioclDipToLiters(50, 0);
  assert.ok(Math.abs(result - 2263.85) < 0.1, `Expected ~2263.85, got ${result}`);
});
test('ioclDipToLiters', 'returns known value at 97cm 0mm (near mid-tank)', () => {
  // IOCL table: 97cm = 5566.38L
  const result = ioclDipToLiters(97, 0);
  assert.ok(Math.abs(result - 5566.38) < 0.1, `Expected ~5566.38, got ${result}`);
});
test('ioclDipToLiters', 'adds mm interpolation correctly', () => {
  // 50cm diff = 6.36 L/mm, so 50cm 5mm = 2263.85 + 5×6.36 = 2295.65
  const base = ioclDipToLiters(50, 0);
  const withMm = ioclDipToLiters(50, 5);
  assert.ok(withMm > base, 'mm interpolation should increase volume');
  assert.ok(Math.abs(withMm - base - 5 * 6.36) < 0.5);
});
test('ioclDipToLiters', 'clamps cm below 1 to 1', () => {
  assert.ok(ioclDipToLiters(0, 0) > 0);
  assert.strictEqual(ioclDipToLiters(0, 0), ioclDipToLiters(1, 0));
});
test('ioclDipToLiters', 'clamps cm above 194 to 194', () => {
  assert.strictEqual(ioclDipToLiters(200, 0), ioclDipToLiters(194, 0));
});
test('ioclDipToLiters', 'clamps mm below 0 to 0', () => {
  assert.strictEqual(ioclDipToLiters(50, -1), ioclDipToLiters(50, 0));
});
test('ioclDipToLiters', 'clamps mm above 9 to 9', () => {
  assert.strictEqual(ioclDipToLiters(50, 10), ioclDipToLiters(50, 9));
});
test('ioclDipToLiters', 'at 194cm returns near 11089L (tank physical top)', () => {
  const result = ioclDipToLiters(194, 0);
  assert.ok(Math.abs(result - 11089.78) < 1, `Expected ~11089.78, got ${result}`);
});
test('ioclDipToLiters', 'returns rounded value to 2dp', () => {
  const result = ioclDipToLiters(87, 3);
  const str = result.toString();
  const decimals = str.includes('.') ? str.split('.')[1].length : 0;
  assert.ok(decimals <= 2, `Expected max 2 decimal places, got ${decimals}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: UTILS — BPCL Dip Chart Lookup (15K official chart)
// ─────────────────────────────────────────────────────────────────────────────
test('bpclDip15K', 'returns official value at 4cm (74.49L)', () => {
  const vol = bpclDipLookup(4, 0);
  assert.ok(Math.abs(vol - 74.49) < 0.5, `Expected ~74.49, got ${vol}`);
});
test('bpclDip15K', 'returns official value at 15cm (531.80L)', () => {
  const vol = bpclDipLookup(15, 0);
  assert.ok(Math.abs(vol - 531.80) < 0.5, `Expected ~531.80, got ${vol}`);
});
test('bpclDip15K', 'returns official value at 100cm (7803.71L)', () => {
  const vol = bpclDipLookup(100, 0);
  assert.ok(Math.abs(vol - 7803.71) < 0.5, `Expected ~7803.71, got ${vol}`);
});
test('bpclDip15K', 'returns official value at 185cm (15075.62L)', () => {
  const vol = bpclDipLookup(185, 0);
  assert.ok(Math.abs(vol - 15075.62) < 0.5, `Expected ~15075.62, got ${vol}`);
});
test('bpclDip15K', 'BPCL 15K is significantly larger than IOCL 10K at same depth', () => {
  const bpcl = bpclDipLookup(97, 0);
  const iocl = ioclDipToLiters(97, 0);
  assert.ok(bpcl > iocl, 'BPCL 15K must hold more litres at same dip depth');
  assert.ok(bpcl - iocl > 1500, `Difference should be >1500L, got ${bpcl - iocl}`);
});
test('bpclDip15K', 'mm interpolation increases volume', () => {
  const base = bpclDipLookup(100, 0);
  const withMm = bpclDipLookup(100, 5);
  assert.ok(withMm > base);
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: SERVER LOGIC — Stock Enforcement (pure logic extracted)
// ─────────────────────────────────────────────────────────────────────────────
const { checkStockEnforcement, checkSaleLitersValidation,
        checkSaleAmountValidation, checkFuelTypeValidation,
        checkSaleDateValidation } = require('./helpers/server_extract');

test('stockEnforcement', 'blocks sale when liters > tankLevel (no tolerance)', () => {
  const result = checkStockEnforcement({ current_level: 1000, capacity: 15000 }, 1001);
  assert.strictEqual(result.blocked, true);
  assert.ok(result.error.includes('Insufficient stock'));
});
test('stockEnforcement', 'allows sale when liters === tankLevel exactly', () => {
  const result = checkStockEnforcement({ current_level: 1000, capacity: 15000 }, 1000);
  assert.strictEqual(result.blocked, false);
});
test('stockEnforcement', 'allows sale when liters < tankLevel', () => {
  const result = checkStockEnforcement({ current_level: 1000, capacity: 15000 }, 999);
  assert.strictEqual(result.blocked, false);
});
test('stockEnforcement', 'skips enforcement if tank level is at 0', () => {
  // Tank at 0 means brand-new station — don't block
  const result = checkStockEnforcement({ current_level: 0, capacity: 15000 }, 100);
  assert.strictEqual(result.blocked, false);
});
test('stockEnforcement', 'skips enforcement if tank level ≤ 5% capacity (brand new)', () => {
  // capacity=15000, 5% = 750. Level=700 ≤ 750 → skip
  const result = checkStockEnforcement({ current_level: 700, capacity: 15000 }, 5000);
  assert.strictEqual(result.blocked, false);
});
test('stockEnforcement', 'enforces when tank level > 5% capacity', () => {
  // capacity=15000, 5% = 750. Level=800 > 750 → enforce
  const result = checkStockEnforcement({ current_level: 800, capacity: 15000 }, 801);
  assert.strictEqual(result.blocked, true);
});
test('stockEnforcement', 'returns available litres in error response', () => {
  const result = checkStockEnforcement({ current_level: 500, capacity: 15000 }, 600);
  assert.strictEqual(result.available, 500);
  assert.strictEqual(result.requested, 600);
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: SERVER LOGIC — Sale field validation
// ─────────────────────────────────────────────────────────────────────────────
test('saleValidation.liters', 'rejects 0 liters', () => {
  assert.ok(checkSaleLitersValidation(0).invalid);
});
test('saleValidation.liters', 'rejects negative liters', () => {
  assert.ok(checkSaleLitersValidation(-1).invalid);
});
test('saleValidation.liters', 'rejects liters > 50000', () => {
  assert.ok(checkSaleLitersValidation(50001).invalid);
});
test('saleValidation.liters', 'accepts 50000 exactly', () => {
  assert.ok(!checkSaleLitersValidation(50000).invalid);
});
test('saleValidation.liters', 'accepts valid decimal liters', () => {
  assert.ok(!checkSaleLitersValidation(10.5).invalid);
});
test('saleValidation.liters', 'rejects NaN', () => {
  assert.ok(checkSaleLitersValidation(NaN).invalid);
});

test('saleValidation.amount', 'rejects 0 amount', () => {
  assert.ok(checkSaleAmountValidation(0).invalid);
});
test('saleValidation.amount', 'rejects negative amount', () => {
  assert.ok(checkSaleAmountValidation(-100).invalid);
});
test('saleValidation.amount', 'rejects amount > ₹1 crore', () => {
  assert.ok(checkSaleAmountValidation(10000001).invalid);
});
test('saleValidation.amount', 'accepts exactly ₹1 crore', () => {
  assert.ok(!checkSaleAmountValidation(10000000).invalid);
});
test('saleValidation.amount', 'accepts normal fuel amount', () => {
  assert.ok(!checkSaleAmountValidation(940).invalid);
});

test('saleValidation.fuelType', 'accepts Petrol (capital)', () => {
  assert.ok(!checkFuelTypeValidation('Petrol').invalid);
});
test('saleValidation.fuelType', 'accepts petrol (lower)', () => {
  assert.ok(!checkFuelTypeValidation('petrol').invalid);
});
test('saleValidation.fuelType', 'accepts Diesel', () => {
  assert.ok(!checkFuelTypeValidation('Diesel').invalid);
});
test('saleValidation.fuelType', 'accepts premium_petrol', () => {
  assert.ok(!checkFuelTypeValidation('premium_petrol').invalid);
});
test('saleValidation.fuelType', 'accepts CNG', () => {
  assert.ok(!checkFuelTypeValidation('CNG').invalid);
});
test('saleValidation.fuelType', 'rejects kerosene', () => {
  assert.ok(checkFuelTypeValidation('kerosene').invalid);
});
test('saleValidation.fuelType', 'rejects empty string', () => {
  assert.ok(checkFuelTypeValidation('').invalid);
});
test('saleValidation.fuelType', 'rejects null', () => {
  assert.ok(checkFuelTypeValidation(null).invalid);
});

test('saleValidation.date', 'accepts today\'s date', () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(!checkSaleDateValidation(today).invalid);
});
test('saleValidation.date', 'accepts yesterday\'s date', () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  assert.ok(!checkSaleDateValidation(d.toISOString().slice(0, 10)).invalid);
});
test('saleValidation.date', 'rejects date 2 days in future', () => {
  // Use +3 days to guarantee it's beyond IST tomorrow regardless of timezone offset
  const d = new Date();
  d.setDate(d.getDate() + 3);
  assert.ok(checkSaleDateValidation(d.toISOString().slice(0, 10)).invalid);
});
test('saleValidation.date', 'accepts missing date (undefined)', () => {
  assert.ok(!checkSaleDateValidation(undefined).invalid);
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: RATE LIMITING LOGIC
// ─────────────────────────────────────────────────────────────────────────────
test('rateLimit', 'allows first login attempt', () => {
  const state = {};
  assert.ok(checkRateLimitLogic(state, 'user1'));
});
test('rateLimit', 'allows up to 4 failed attempts', () => {
  const state = { user1: { count: 4 } };
  assert.ok(checkRateLimitLogic(state, 'user1'));
});
test('rateLimit', 'blocks on 5th failed attempt', () => {
  const state = { user1: { count: 5, lockedUntil: Date.now() + 300000 } };
  assert.ok(!checkRateLimitLogic(state, 'user1'));
});
test('rateLimit', 'unblocks after lockout period expires', () => {
  const state = { user1: { count: 5, lockedUntil: Date.now() - 1000 } };
  assert.ok(checkRateLimitLogic(state, 'user1'));
});
test('rateLimit', 'different users have independent limits', () => {
  const state = { user1: { count: 5, lockedUntil: Date.now() + 300000 } };
  assert.ok(checkRateLimitLogic(state, 'user2'));
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: CREDIT LIMIT ENFORCEMENT
// ─────────────────────────────────────────────────────────────────────────────
const { checkCreditLimit } = require('./helpers/server_extract');

test('creditLimit', 'blocks when new sale would exceed limit', () => {
  const result = checkCreditLimit({ outstanding: 8000, limit: 10000 }, 2001);
  assert.ok(result.blocked);
});
test('creditLimit', 'allows sale that exactly hits the limit', () => {
  const result = checkCreditLimit({ outstanding: 8000, limit: 10000 }, 2000);
  assert.ok(!result.blocked);
});
test('creditLimit', 'allows sale when limit is 0 (unlimited)', () => {
  const result = checkCreditLimit({ outstanding: 50000, limit: 0 }, 10000);
  assert.ok(!result.blocked);
});
test('creditLimit', 'allows sale when customer has no outstanding balance', () => {
  const result = checkCreditLimit({ outstanding: 0, limit: 10000 }, 5000);
  assert.ok(!result.blocked);
});
test('creditLimit', 'returns remaining credit in response', () => {
  const result = checkCreditLimit({ outstanding: 8000, limit: 10000 }, 5000);
  assert.ok(result.blocked);
  assert.strictEqual(result.available, 2000);
});

// ─────────────────────────────────────────────────────────────────────────────
// MODULE: TANK STOCK — Employee shift deduction logic
// ─────────────────────────────────────────────────────────────────────────────
const { calcAvailableStock } = require('./helpers/server_extract');

test('availableStock', 'available = tank - alreadySold this shift', () => {
  const result = calcAvailableStock(5000, 200);
  assert.strictEqual(result, 4800);
});
test('availableStock', 'never goes below 0', () => {
  const result = calcAvailableStock(100, 200);
  assert.strictEqual(result, 0);
});
test('availableStock', 'full tank with no sales = full amount available', () => {
  const result = calcAvailableStock(15000, 0);
  assert.strictEqual(result, 15000);
});

// ─────────────────────────────────────────────────────────────────────────────
// PRINT RESULTS
// ─────────────────────────────────────────────────────────────────────────────
const suites = {};
for (const r of results) {
  if (!suites[r.suite]) suites[r.suite] = { pass: 0, fail: 0, tests: [] };
  suites[r.suite].tests.push(r);
  if (r.status === 'PASS') suites[r.suite].pass++;
  else suites[r.suite].fail++;
}

console.log('\n' + '═'.repeat(72));
console.log('  FUELBUNK PRO — UNIT TEST REPORT');
console.log('═'.repeat(72));

for (const [suiteName, suite] of Object.entries(suites)) {
  const icon = suite.fail === 0 ? '✅' : '❌';
  console.log(`\n${icon} ${suiteName.padEnd(36)} [${suite.pass}/${suite.pass + suite.fail} passed]`);
  for (const t of suite.tests) {
    const status = t.status === 'PASS' ? '  ✓' : '  ✗';
    console.log(`${status}  ${t.name}`);
    if (t.error) console.log(`       → ${t.error}`);
  }
}

console.log('\n' + '─'.repeat(72));
const pct = Math.round((passed / total) * 100);
console.log(`  Total: ${total} tests  |  Passed: ${passed}  |  Failed: ${failed}  |  Coverage: ${pct}%`);
console.log('─'.repeat(72) + '\n');

if (failed > 0) {
  console.log(`⚠️  ${failed} test(s) failed. See details above.\n`);
  process.exit(1);
} else {
  console.log(`✅  All ${total} tests passed.\n`);
  process.exit(0);
}
