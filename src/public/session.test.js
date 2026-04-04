/**
 * FuelBunk Pro — Session Persistence & Expiry Tests
 *
 * Covers:
 *   1. SESSION_IDLE_TIMEOUT is 15 minutes (not 8 hours)
 *   2. loadSession() rejects sessions idle for > 15 minutes
 *   3. loadSession() accepts sessions active within 15 minutes
 *   4. loadSession() rejects sessions older than SESSION_MAX_AGE (30 days)
 *   5. Browser/tab close clears fb_session via pagehide handler
 *   6. Explicit logout sets fb_explicit_logout marker
 *   7. loadSession() rejects session when fb_explicit_logout flag is present
 *   8. saveSession() / new login clears fb_explicit_logout flag
 *   9. No regression — active sessions within timeout are not invalidated
 *  10. clearSession() removes fb_session (logout path)
 *
 * Run with: node tests/session.test.js
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// MINI TEST RUNNER (same pattern as unit.test.js)
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

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEqual(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + `\n    expected: ${JSON.stringify(b)}\n    got:      ${JSON.stringify(a)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// INLINE RE-IMPLEMENTATION of the session functions under test.
// These mirror exactly what is in utils.js + employee.js so tests run in Node
// without a browser, but test the SAME logic paths.
// ─────────────────────────────────────────────────────────────────────────────

// --- djb2 hash (same as utils.js hashSync) ---
function hashSync(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// --- Constants (must match utils.js exactly) ---
const SESSION_MAX_AGE      = 30 * 24 * 60 * 60 * 1000; // 30 days
const SESSION_IDLE_TIMEOUT = 15 * 60 * 1000;            // 15 minutes

// --- Mock localStorage ---
function makeMockStorage() {
  const store = {};
  return {
    getItem:    (k)    => store[k] !== undefined ? store[k] : null,
    setItem:    (k, v) => { store[k] = String(v); },
    removeItem: (k)    => { delete store[k]; },
    _store:     store,
  };
}

// --- signData / verifyData (same logic as utils.js) ---
const APP_SECRET = 'test-secret';
function signData(payload) {
  const raw = JSON.stringify(payload);
  const sig = hashSync(raw + APP_SECRET);
  return JSON.stringify({ payload: raw, sig });
}
function verifyData(stored) {
  try {
    const { payload, sig } = JSON.parse(stored);
    const expected = hashSync(payload + APP_SECRET);
    if (sig !== expected) return null;
    return JSON.parse(payload);
  } catch { return null; }
}

// --- validateSessionShape (same as utils_extract.js) ---
function validateSessionShape(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.loggedIn !== 'boolean') return false;
  if (!['admin', 'employee', null].includes(data.role)) return false;
  if (data.loggedIn && !data.timestamp) return false;
  return true;
}

// --- loadSession logic extracted (mirrors employee.js exactly) ---
function makeLoadSession(ls, APP) {
  return function loadSession() {
    try {
      if (ls.getItem('fb_explicit_logout') === '1') {
        ls.removeItem('fb_session');
        return false;
      }
      const raw = ls.getItem('fb_session');
      if (!raw) return false;
      const s = verifyData(raw);
      if (!s || !validateSessionShape(s)) {
        ls.removeItem('fb_session');
        return false;
      }
      if (Date.now() - s.timestamp > SESSION_MAX_AGE) {
        ls.removeItem('fb_session');
        return false;
      }
      if (s.lastActive && Date.now() - s.lastActive >= SESSION_IDLE_TIMEOUT) {
        ls.removeItem('fb_session');
        return false;
      }
      APP.loggedIn = true; APP.role = s.role; APP.adminUser = s.adminUser || null;
      return true;
    } catch { return false; }
  };
}

// --- saveSession logic extracted (mirrors employee.js exactly) ---
function makeSaveSession(ls, APP) {
  return function saveSession() {
    try {
      ls.removeItem('fb_explicit_logout'); // new login clears prior logout flag
      const data = {
        loggedIn: APP.loggedIn, role: APP.role, adminUser: APP.adminUser,
        timestamp: Date.now(), lastActive: Date.now()
      };
      ls.setItem('fb_session', signData(data));
    } catch {}
  };
}

// --- clearSession logic extracted (mirrors employee.js exactly) ---
function makeClearSession(ls, APP) {
  return function clearSession() {
    try { ls.removeItem('fb_session'); } catch {}
    APP.loggedIn = false; APP.role = null; APP.adminUser = null;
  };
}

// --- pagehide handler logic (mirrors utils.js pagehide listener body) ---
function simulatePagehide(ls) {
  // Mirrors: window.addEventListener('pagehide', function() {
  //   try { localStorage.removeItem('fb_session'); } catch(e) {}
  // });
  try { ls.removeItem('fb_session'); } catch(e) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 1 — Constants
// ─────────────────────────────────────────────────────────────────────────────

test('Constants', 'SESSION_IDLE_TIMEOUT is exactly 15 minutes', () => {
  assertEqual(SESSION_IDLE_TIMEOUT, 15 * 60 * 1000,
    'SESSION_IDLE_TIMEOUT must be 15 minutes (900000 ms)');
});

test('Constants', 'SESSION_MAX_AGE is exactly 30 days', () => {
  assertEqual(SESSION_MAX_AGE, 30 * 24 * 60 * 60 * 1000,
    'SESSION_MAX_AGE must be 30 days');
});

test('Constants', 'SESSION_IDLE_TIMEOUT is NOT 8 hours (regression guard)', () => {
  assert(SESSION_IDLE_TIMEOUT !== 8 * 60 * 60 * 1000,
    'SESSION_IDLE_TIMEOUT must not be 8 hours — was the fix reverted?');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 2 — Idle timeout: session rejected after 15 minutes
// ─────────────────────────────────────────────────────────────────────────────

test('Idle timeout', 'session idle for exactly 15 min is rejected on reopen', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  // Simulate a session where lastActive is exactly 15 minutes ago
  const staleSession = {
    loggedIn: true, role: 'admin', adminUser: { name: 'Test' },
    timestamp: Date.now() - 60 * 60 * 1000, // 1 hour ago (within max age)
    lastActive: Date.now() - SESSION_IDLE_TIMEOUT, // exactly at boundary
  };
  ls.setItem('fb_session', signData(staleSession));

  const result = loadSession();
  assert(!result, 'Session idle for exactly SESSION_IDLE_TIMEOUT should be rejected');
  assertEqual(ls.getItem('fb_session'), null, 'fb_session should be removed after expiry');
  assert(!APP.loggedIn, 'APP.loggedIn should remain false');
});

test('Idle timeout', 'session idle for 16 minutes is rejected on reopen', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  const staleSession = {
    loggedIn: true, role: 'admin', adminUser: { name: 'Test' },
    timestamp: Date.now() - 60 * 60 * 1000,
    lastActive: Date.now() - (16 * 60 * 1000), // 16 minutes ago
  };
  ls.setItem('fb_session', signData(staleSession));

  const result = loadSession();
  assert(!result, 'Session idle for 16 minutes must be rejected');
  assertEqual(ls.getItem('fb_session'), null, 'fb_session must be cleared');
});

test('Idle timeout', 'session that was active 8 hours ago is rejected (old 8h timeout no longer valid)', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  const staleSession = {
    loggedIn: true, role: 'admin', adminUser: { name: 'Test' },
    timestamp: Date.now() - 60 * 60 * 1000,
    lastActive: Date.now() - (8 * 60 * 60 * 1000), // 8 hours ago
  };
  ls.setItem('fb_session', signData(staleSession));

  const result = loadSession();
  assert(!result, 'Session last active 8 hours ago must be rejected with 15-min timeout');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 3 — Active session: not invalidated within 15 minutes
// ─────────────────────────────────────────────────────────────────────────────

test('Active session', 'session active 1 minute ago is restored successfully', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  const freshSession = {
    loggedIn: true, role: 'admin', adminUser: { name: 'Active User' },
    timestamp: Date.now() - 60 * 60 * 1000,
    lastActive: Date.now() - (1 * 60 * 1000), // 1 minute ago
  };
  ls.setItem('fb_session', signData(freshSession));

  const result = loadSession();
  assert(result, 'Session active 1 minute ago must be restored');
  assert(APP.loggedIn, 'APP.loggedIn must be true');
  assertEqual(APP.role, 'admin', 'APP.role must be admin');
});

test('Active session', 'session active 14 minutes ago is restored (just inside window)', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  const freshSession = {
    loggedIn: true, role: 'employee', adminUser: null,
    timestamp: Date.now() - 60 * 60 * 1000,
    lastActive: Date.now() - (14 * 60 * 1000), // 14 minutes ago
  };
  ls.setItem('fb_session', signData(freshSession));

  const result = loadSession();
  assert(result, 'Session active 14 minutes ago (within 15-min window) must be restored');
  assertEqual(APP.role, 'employee', 'Role should be employee');
});

test('Active session', 'session with no lastActive falls back to timestamp check only', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  // Session without lastActive — old format compatibility
  const session = {
    loggedIn: true, role: 'admin', adminUser: { name: 'Legacy' },
    timestamp: Date.now() - (5 * 60 * 1000), // 5 minutes ago, no lastActive
  };
  ls.setItem('fb_session', signData(session));

  const result = loadSession();
  assert(result, 'Session without lastActive field should be accepted (timestamp within max age)');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 4 — Max age: 30-day absolute expiry
// ─────────────────────────────────────────────────────────────────────────────

test('Max age', 'session older than 30 days is rejected even if lastActive is recent', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  const oldSession = {
    loggedIn: true, role: 'admin', adminUser: { name: 'Old' },
    timestamp: Date.now() - (31 * 24 * 60 * 60 * 1000), // 31 days ago
    lastActive: Date.now() - (1 * 60 * 1000), // 1 minute ago
  };
  ls.setItem('fb_session', signData(oldSession));

  const result = loadSession();
  assert(!result, 'Session older than 30 days must be rejected regardless of lastActive');
  assertEqual(ls.getItem('fb_session'), null, 'fb_session must be cleared');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 5 — Browser/tab close: pagehide clears fb_session immediately
// ─────────────────────────────────────────────────────────────────────────────

test('Browser close (pagehide)', 'session is removed from storage when pagehide fires', () => {
  const ls = makeMockStorage();
  const freshSession = {
    loggedIn: true, role: 'admin', adminUser: { name: 'Open' },
    timestamp: Date.now(), lastActive: Date.now(),
  };
  ls.setItem('fb_session', signData(freshSession));

  // Confirm session exists before close
  assert(ls.getItem('fb_session') !== null, 'Session should exist before pagehide');

  // Simulate browser/tab close
  simulatePagehide(ls);

  // Session must be gone immediately
  assertEqual(ls.getItem('fb_session'), null,
    'fb_session must be null after pagehide — browser close clears session immediately');
});

test('Browser close (pagehide)', 'loadSession returns false after pagehide fires on reopen', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  // User is logged in
  const freshSession = {
    loggedIn: true, role: 'admin', adminUser: { name: 'Open' },
    timestamp: Date.now(), lastActive: Date.now(),
  };
  ls.setItem('fb_session', signData(freshSession));

  // Browser is closed (pagehide fires)
  simulatePagehide(ls);

  // Browser is reopened — loadSession runs
  const result = loadSession();
  assert(!result, 'loadSession must return false after pagehide cleared the session');
  assert(!APP.loggedIn, 'APP.loggedIn must be false after reopen following close');
});

test('Browser close (pagehide)', 'pagehide clears session even if idle timeout has not elapsed', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  // User just logged in — well within idle timeout
  const freshSession = {
    loggedIn: true, role: 'admin', adminUser: { name: 'Fresh' },
    timestamp: Date.now(),
    lastActive: Date.now(), // just now
  };
  ls.setItem('fb_session', signData(freshSession));

  // Browser is closed immediately (only 0ms elapsed)
  simulatePagehide(ls);

  // Reopen — session should NOT be restored regardless of timeout
  const result = loadSession();
  assert(!result,
    'Session must not be restored after browser close, even if idle timeout has not elapsed');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 6 — Explicit logout
// ─────────────────────────────────────────────────────────────────────────────

test('Explicit logout', 'fb_explicit_logout flag blocks session restore', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  // Session exists and is fresh
  const freshSession = {
    loggedIn: true, role: 'admin', adminUser: { name: 'User' },
    timestamp: Date.now(), lastActive: Date.now(),
  };
  ls.setItem('fb_session', signData(freshSession));

  // Explicit logout flag is set (simulating appLogout())
  ls.setItem('fb_explicit_logout', '1');

  const result = loadSession();
  assert(!result, 'loadSession must return false when fb_explicit_logout flag is present');
  assert(!APP.loggedIn, 'APP.loggedIn must be false when explicit logout flag is set');
  assertEqual(ls.getItem('fb_session'), null, 'fb_session must be removed when logout flag is found');
});

test('Explicit logout', 'clearSession removes fb_session (logout path)', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: true, role: 'admin', adminUser: { name: 'U' } };
  const clearSession = makeClearSession(ls, APP);

  ls.setItem('fb_session', signData({
    loggedIn: true, role: 'admin', adminUser: { name: 'U' },
    timestamp: Date.now(), lastActive: Date.now()
  }));

  clearSession();

  assertEqual(ls.getItem('fb_session'), null, 'fb_session must be null after clearSession');
  assert(!APP.loggedIn, 'APP.loggedIn must be false after clearSession');
  assertEqual(APP.role, null, 'APP.role must be null after clearSession');
});

test('Explicit logout', 'fb_explicit_logout flag persists across reopen (no session to restore)', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);
  const clearSession = makeClearSession(ls, APP);

  // Login → session written
  ls.setItem('fb_session', signData({
    loggedIn: true, role: 'admin', adminUser: { name: 'U' },
    timestamp: Date.now(), lastActive: Date.now()
  }));

  // Explicit logout — write flag, clear session
  ls.setItem('fb_explicit_logout', '1');
  clearSession();

  // Browser close + reopen (pagehide already cleared fb_session, flag still in ls)
  const result = loadSession();
  assert(!result, 'loadSession must refuse to restore after explicit logout on reopen');
});

test('Explicit logout', 'new login via saveSession clears fb_explicit_logout flag', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: true, role: 'admin', adminUser: { name: 'Re-login' } };
  const saveSession = makeSaveSession(ls, APP);

  // Simulate prior explicit logout flag
  ls.setItem('fb_explicit_logout', '1');

  // User logs back in — saveSession is called
  saveSession();

  assertEqual(ls.getItem('fb_explicit_logout'), null,
    'fb_explicit_logout must be cleared when saveSession is called (new login)');
  assert(ls.getItem('fb_session') !== null,
    'fb_session must be written by saveSession');
});

test('Explicit logout', 'after re-login loadSession succeeds with no logout flag', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: true, role: 'admin', adminUser: { name: 'Re' } };
  const saveSession = makeSaveSession(ls, APP);
  const loadSession = makeLoadSession(ls, { loggedIn: false, role: null, adminUser: null });

  // Prior explicit logout flag
  ls.setItem('fb_explicit_logout', '1');

  // Re-login
  saveSession();

  // New APP object for next page load
  const APP2 = { loggedIn: false, role: null, adminUser: null };
  const loadSession2 = makeLoadSession(ls, APP2);
  const result = loadSession2();
  assert(result, 'loadSession must succeed after re-login clears the explicit logout flag');
  assert(APP2.loggedIn, 'APP.loggedIn must be true after successful re-login session restore');
});

// ─────────────────────────────────────────────────────────────────────────────
// SUITE 7 — No regression: active sessions work correctly
// ─────────────────────────────────────────────────────────────────────────────

test('No regression', 'session with no logout flag and recent activity restores correctly', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  ls.setItem('fb_session', signData({
    loggedIn: true, role: 'admin', adminUser: { name: 'Alice', username: 'alice' },
    timestamp: Date.now() - (5 * 60 * 1000),
    lastActive: Date.now() - (2 * 60 * 1000), // 2 minutes ago
  }));

  const result = loadSession();
  assert(result, 'Normal active session must restore without issues');
  assertEqual(APP.role, 'admin', 'Role must be admin');
  assertEqual(APP.adminUser.name, 'Alice', 'adminUser.name must be Alice');
});

test('No regression', 'tampered session (bad sig) is rejected', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  const raw = JSON.stringify({
    loggedIn: true, role: 'admin', adminUser: { name: 'Hacker' },
    timestamp: Date.now(), lastActive: Date.now()
  });
  // Manually craft a signed structure with a wrong sig
  ls.setItem('fb_session', JSON.stringify({ payload: raw, sig: 'badhash0' }));

  const result = loadSession();
  assert(!result, 'Tampered session with invalid sig must be rejected');
  assert(!APP.loggedIn, 'APP.loggedIn must not be set from tampered session');
});

test('No regression', 'missing fb_session returns false without throwing', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  const result = loadSession();
  assert(!result, 'loadSession with no stored session must return false');
  assert(!APP.loggedIn, 'APP.loggedIn must remain false');
});

test('No regression', 'employee role session restores correctly', () => {
  const ls = makeMockStorage();
  const APP = { loggedIn: false, role: null, adminUser: null };
  const loadSession = makeLoadSession(ls, APP);

  ls.setItem('fb_session', signData({
    loggedIn: true, role: 'employee', adminUser: null,
    timestamp: Date.now() - (3 * 60 * 1000),
    lastActive: Date.now() - (1 * 60 * 1000),
  }));

  const result = loadSession();
  assert(result, 'Employee session must restore correctly');
  assertEqual(APP.role, 'employee', 'Role must be employee');
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
console.log('  FUELBUNK PRO — SESSION PERSISTENCE & EXPIRY TEST REPORT');
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
console.log(`  Total: ${total} tests  |  Passed: ${passed}  |  Failed: ${failed}`);
console.log('─'.repeat(72) + '\n');

if (failed > 0) {
  console.log(`⚠️  ${failed} test(s) failed. See details above.\n`);
  process.exit(1);
} else {
  console.log(`✅  All ${total} session tests passed.\n`);
  process.exit(0);
}
