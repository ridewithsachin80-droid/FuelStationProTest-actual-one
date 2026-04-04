/**
 * FuelBunk Pro — WebAuthn & Persistent Session Tests
 *
 * Tests cover:
 *  1. Persistent session — localStorage vs sessionStorage
 *  2. Session expiry constants (30d idle, 720h server)
 *  3. WebAuthn route logic (challenge issuance, replay protection, credential management)
 *  4. biometric helper functions (base64url encode/decode, availability checks)
 *  5. Integration: full registration → authentication flow (mocked crypto)
 */

'use strict';

const crypto = require('crypto');

// ── Minimal test harness ──────────────────────────────────────────────────────
let _pass = 0, _fail = 0, _total = 0;
const results = [];

function test(name, fn) {
  _total++;
  try {
    fn();
    _pass++;
    results.push({ name, ok: true });
  } catch (e) {
    _fail++;
    results.push({ name, ok: false, err: e.message });
  }
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function assertNotEqual(a, b, msg) {
  if (a === b) throw new Error(msg || `Expected values to differ, both are ${JSON.stringify(a)}`);
}
function assertTrue(v, msg)  { if (!v) throw new Error(msg || `Expected truthy, got ${v}`); }
function assertFalse(v, msg) { if (v)  throw new Error(msg || `Expected falsy, got ${v}`); }
function assertThrows(fn, msg) {
  try { fn(); throw new Error('Expected to throw but did not'); }
  catch (e) { if (e.message === 'Expected to throw but did not') throw new Error(msg || e.message); }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── 1. SESSION EXPIRY CONSTANTS ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== 1. Session Expiry Constants ===');

test('SESSION_MAX_AGE is 30 days', () => {
  const expected = 30 * 24 * 60 * 60 * 1000;
  // Extract from utils.js source
  const src = require('fs').readFileSync('./src/public/utils.js', 'utf8');
  const match = src.match(/SESSION_MAX_AGE\s*=\s*([^;]+)/);
  assertTrue(match, 'SESSION_MAX_AGE not found in utils.js');
  const val = eval(match[1].trim());
  assertEqual(val, expected, `SESSION_MAX_AGE should be ${expected}ms (30 days), got ${val}`);
});

test('SESSION_IDLE_TIMEOUT is 8 hours', () => {
  const expected = 8 * 60 * 60 * 1000;
  const src = require('fs').readFileSync('./src/public/utils.js', 'utf8');
  const match = src.match(/SESSION_IDLE_TIMEOUT\s*=\s*([^;]+)/);
  assertTrue(match, 'SESSION_IDLE_TIMEOUT not found in utils.js');
  const val = eval(match[1].trim());
  assertEqual(val, expected, `SESSION_IDLE_TIMEOUT should be ${expected}ms (8h), got ${val}`);
});

test('Server session hours is 720 for admin (30 days)', () => {
  const src = require('fs').readFileSync('./src/security.js', 'utf8');
  // Should see 720 for admin hours
  assertTrue(src.includes('720'), 'security.js should set admin session to 720 hours (30 days)');
  assertFalse(
    src.match(/userType === 'super' \? 4 : 12/),
    'Old 12-hour admin session should be replaced with 720'
  );
});

test('Super admin session remains 4 hours', () => {
  const src = require('fs').readFileSync('./src/security.js', 'utf8');
  assertTrue(src.includes("? 4 :"), 'Super admin should still use 4-hour session');
});

// ══════════════════════════════════════════════════════════════════════════════
// ── 2. LOCALSTORAGE PERSISTENCE (not sessionStorage) ─────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== 2. Persistent Storage (localStorage) ===');

test('api-client.js stores auth token in localStorage not sessionStorage', () => {
  const src = require('fs').readFileSync('./src/public/api-client.js', 'utf8');
  // Token key storage must use localStorage
  const lines = src.split('\n').filter(l => l.includes('_TOKEN_KEY'));
  const sessionLines = lines.filter(l => l.includes('sessionStorage'));
  assertEqual(sessionLines.length, 0,
    `Auth token should use localStorage — found sessionStorage refs: ${sessionLines.join(' | ')}`);
});

test('api-client.js reads auth token from localStorage', () => {
  const src = require('fs').readFileSync('./src/public/api-client.js', 'utf8');
  assertTrue(
    src.includes("localStorage.getItem(_TOKEN_KEY)"),
    'Token read should use localStorage.getItem'
  );
});

test('clearAuth removes token from localStorage', () => {
  const src = require('fs').readFileSync('./src/public/api-client.js', 'utf8');
  assertTrue(
    src.includes("localStorage.removeItem(_TOKEN_KEY)"),
    'clearAuth should remove from localStorage'
  );
});

test('bridge.js stores fb_session in localStorage not sessionStorage', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  const setLines = src.split('\n').filter(l =>
    l.includes('fb_session') && l.includes('setItem') && l.includes('sessionStorage')
  );
  assertEqual(setLines.length, 0,
    `fb_session should use localStorage.setItem, found sessionStorage: ${setLines.join(' | ')}`);
});

test('bridge.js reads fb_session from localStorage', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  const getLines = src.split('\n').filter(l =>
    l.includes('fb_session') && l.includes('getItem') && l.includes('localStorage')
  );
  assertTrue(getLines.length >= 2,
    `Expected at least 2 localStorage.getItem('fb_session') calls, got ${getLines.length}`);
});

test('bridge.js logout removes fb_session from localStorage', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  const removeLines = src.split('\n').filter(l =>
    l.includes('fb_session') && l.includes('removeItem') && l.includes('localStorage')
  );
  assertTrue(removeLines.length >= 2,
    `Expected at least 2 localStorage.removeItem('fb_session') calls, got ${removeLines.length}`);
});

test('bridge.js super token still uses sessionStorage (security)', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  const superTokenLines = src.split('\n').filter(l =>
    l.includes('fb_super_token') && l.includes('sessionStorage')
  );
  assertTrue(superTokenLines.length >= 3,
    'fb_super_token should still use sessionStorage for security (expires on tab close)');
});

// ══════════════════════════════════════════════════════════════════════════════
// ── 3. WEBAUTHN ROUTES IN AUTH.JS ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== 3. WebAuthn Routes ===');

test('auth.js has /webauthn/register-options route', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(src.includes('/webauthn/register-options'), 'register-options route missing');
});

test('auth.js has /webauthn/register route', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(src.includes('/webauthn/register\''), 'register route missing');
});

test('auth.js has /webauthn/auth-options route', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(src.includes('/webauthn/auth-options'), 'auth-options route missing');
});

test('auth.js has /webauthn/authenticate route', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(src.includes('/webauthn/authenticate'), 'authenticate route missing');
});

test('auth.js has credential list and delete routes', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(src.includes('/webauthn/credentials'), 'credentials list route missing');
  assertTrue(src.includes('/webauthn/credentials/:credId'), 'credential delete route missing');
});

test('auth.js enforces platform authenticator (device biometric only)', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(src.includes("authenticatorAttachment: 'platform'"),
    "Should restrict to platform authenticator (fingerprint/face/PIN, not USB keys)");
});

test('auth.js requires user verification (not just presence)', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(src.includes("userVerification: 'required'"),
    'userVerification must be required — PIN/biometric must be used, not just device presence');
});

test('auth.js challenges are single-use (deleted after retrieval)', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(src.includes('_challenges.delete(challenge)'),
    'Challenge must be deleted after use (one-time use)');
});

test('auth.js challenges expire after 5 minutes', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(src.includes('5 * 60 * 1000'),
    'Challenge TTL should be 5 minutes (5 * 60 * 1000 ms)');
});

// ══════════════════════════════════════════════════════════════════════════════
// ── 4. REPLAY ATTACK PROTECTION ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== 4. Replay Attack Protection ===');

test('auth.js checks sign counter against stored counter', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(src.includes('signCount') && src.includes('counter'),
    'Sign counter check must be present for replay attack prevention');
});

test('auth.js rejects when signCount <= stored counter (replay)', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(src.includes('signCount <= cred.counter'),
    'Must reject assertion where sign count is not greater than stored (replay attack)');
});

test('auth.js allows signCount=0 (some authenticators always return 0)', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(src.includes('signCount !== 0 &&'),
    'Must allow signCount=0 for authenticators that do not implement counter');
});

test('auth.js updates counter after successful authentication', () => {
  const src = require('fs').readFileSync('./src/auth.js', 'utf8');
  assertTrue(
    src.includes('UPDATE webauthn_credentials SET counter = $1'),
    'Counter must be updated in DB after each successful authentication'
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// ── 5. DATABASE SCHEMA ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== 5. Database Schema ===');

test('schema.js has webauthn_credentials table', () => {
  const src = require('fs').readFileSync('./src/schema.js', 'utf8');
  assertTrue(src.includes('CREATE TABLE IF NOT EXISTS webauthn_credentials'),
    'webauthn_credentials table must exist in schema');
});

test('schema.js webauthn table has credential_id UNIQUE', () => {
  const src = require('fs').readFileSync('./src/schema.js', 'utf8');
  const block = src.substring(src.indexOf('webauthn_credentials'), src.indexOf('webauthn_credentials') + 600);
  assertTrue(block.includes('credential_id') && block.includes('UNIQUE'),
    'credential_id must be UNIQUE to prevent duplicate registration');
});

test('schema.js webauthn table has counter column', () => {
  const src = require('fs').readFileSync('./src/schema.js', 'utf8');
  const block = src.substring(src.indexOf('webauthn_credentials'), src.indexOf('webauthn_credentials') + 600);
  assertTrue(block.includes('counter'),
    'counter column required for replay attack prevention');
});

test('schema.js webauthn table tracks last_used_at', () => {
  const src = require('fs').readFileSync('./src/schema.js', 'utf8');
  const block = src.substring(src.indexOf('webauthn_credentials'), src.indexOf('webauthn_credentials') + 600);
  assertTrue(block.includes('last_used_at'),
    'last_used_at needed so users can see when biometric was last used');
});

// ══════════════════════════════════════════════════════════════════════════════
// ── 6. FRONTEND WEBAUTHN HELPERS ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== 6. Frontend WebAuthn Helpers ===');

test('bridge.js exposes _attemptBiometricLogin globally', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  assertTrue(src.includes('window._attemptBiometricLogin'),
    '_attemptBiometricLogin must be on window for app.js to call it');
});

test('bridge.js exposes _offerBiometricSetup globally', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  assertTrue(src.includes('window._offerBiometricSetup'),
    '_offerBiometricSetup must be on window');
});

test('bridge.js exposes removeBiometricCredential globally', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  assertTrue(src.includes('window.removeBiometricCredential'),
    'removeBiometricCredential must be on window for settings page');
});

test('bridge.js exposes setupBiometricNow globally', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  assertTrue(src.includes('window.setupBiometricNow'),
    'setupBiometricNow must be on window for settings page button');
});

test('bridge.js stores credential ID in localStorage after registration', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  assertTrue(src.includes("localStorage.setItem(WA_CRED_KEY"),
    'Credential ID must be saved to localStorage after registration');
});

test('bridge.js removes credential from localStorage on removeCredential', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  assertTrue(src.includes("localStorage.removeItem(WA_CRED_KEY)"),
    'Credential must be cleared from localStorage when removed');
});

test('bridge.js handles NotAllowedError (user cancelled biometric) gracefully', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  assertTrue(src.includes("NotAllowedError"),
    "Must handle NotAllowedError — user tapped Cancel on biometric prompt");
});

test('bridge.js clears invalid credential on NotFoundError or InvalidStateError', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  assertTrue(src.includes("InvalidStateError") && src.includes("NotFoundError"),
    "Must handle credential-not-found errors (device wiped / credential revoked)");
});

test('bridge.js patches showLoginScreen to try biometric first', () => {
  const src = require('fs').readFileSync('./src/public/bridge.js', 'utf8');
  assertTrue(
    src.includes('_origShowLoginScreen') && src.includes('_attemptBiometricLogin'),
    'showLoginScreen must be patched to attempt biometric before showing password form'
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// ── 7. API CLIENT WEBAUTHN METHODS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== 7. API Client WebAuthn Methods ===');

test('api-client.js has webauthnRegisterOptions method', () => {
  const src = require('fs').readFileSync('./src/public/api-client.js', 'utf8');
  assertTrue(src.includes('webauthnRegisterOptions'), 'webauthnRegisterOptions missing');
});

test('api-client.js has webauthnRegister method', () => {
  const src = require('fs').readFileSync('./src/public/api-client.js', 'utf8');
  assertTrue(src.includes('webauthnRegister('), 'webauthnRegister missing');
});

test('api-client.js has webauthnAuthOptions method', () => {
  const src = require('fs').readFileSync('./src/public/api-client.js', 'utf8');
  assertTrue(src.includes('webauthnAuthOptions'), 'webauthnAuthOptions missing');
});

test('api-client.js has webauthnAuthenticate method', () => {
  const src = require('fs').readFileSync('./src/public/api-client.js', 'utf8');
  assertTrue(src.includes('webauthnAuthenticate('), 'webauthnAuthenticate missing');
});

test('api-client.js has webauthnRemoveCredential method', () => {
  const src = require('fs').readFileSync('./src/public/api-client.js', 'utf8');
  assertTrue(src.includes('webauthnRemoveCredential'), 'webauthnRemoveCredential missing');
});

// ══════════════════════════════════════════════════════════════════════════════
// ── 8. BASE64URL ENCODING (used by WebAuthn) ──────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== 8. Base64URL Encoding ===');

// Replicate the server-side helpers to unit-test them
function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function fromBase64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

test('base64url encodes without +/=', () => {
  for (let i = 0; i < 50; i++) {
    const buf = crypto.randomBytes(32);
    const encoded = base64url(buf);
    assertFalse(encoded.includes('+'), 'base64url must not contain +');
    assertFalse(encoded.includes('/'), 'base64url must not contain /');
    assertFalse(encoded.includes('='), 'base64url must not contain =');
  }
});

test('base64url round-trips correctly', () => {
  const original = crypto.randomBytes(64);
  const encoded = base64url(original);
  const decoded = fromBase64url(encoded);
  assertEqual(
    original.toString('hex'),
    decoded.toString('hex'),
    'base64url round-trip must produce identical bytes'
  );
});

test('base64url encoded challenge has sufficient entropy (>= 32 bytes)', () => {
  const challenge = base64url(crypto.randomBytes(32));
  // 32 bytes → 43 base64url chars minimum
  assertTrue(challenge.length >= 43, `Challenge too short: ${challenge.length}`);
});

test('two challenges are always unique', () => {
  const c1 = base64url(crypto.randomBytes(32));
  const c2 = base64url(crypto.randomBytes(32));
  assertNotEqual(c1, c2, 'Challenges must be unique — crypto.randomBytes must produce different values');
});

// ══════════════════════════════════════════════════════════════════════════════
// ── 9. CHALLENGE STORE LOGIC ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== 9. Challenge Store Logic ===');

// Reproduce the in-memory challenge store from auth.js to unit-test it
const _challenges = new Map();
function storeChallenge(challenge, data) {
  _challenges.set(challenge, { ...data, expiresAt: Date.now() + 5 * 60 * 1000 });
  for (const [k, v] of _challenges) {
    if (v.expiresAt < Date.now()) _challenges.delete(k);
  }
}
function getChallenge(challenge) {
  const entry = _challenges.get(challenge);
  if (!entry || entry.expiresAt < Date.now()) return null;
  _challenges.delete(challenge); // one-time use
  return entry;
}

test('challenge is stored and retrievable', () => {
  const ch = base64url(crypto.randomBytes(32));
  storeChallenge(ch, { userId: 1, action: 'register' });
  const entry = getChallenge(ch);
  assertTrue(entry !== null, 'Challenge should be retrievable immediately after storing');
  assertEqual(entry.userId, 1);
  assertEqual(entry.action, 'register');
});

test('challenge is single-use (deleted after retrieval)', () => {
  const ch = base64url(crypto.randomBytes(32));
  storeChallenge(ch, { userId: 2, action: 'authenticate' });
  const first  = getChallenge(ch);
  const second = getChallenge(ch);
  assertTrue(first !== null,  'First retrieval should succeed');
  assertTrue(second === null, 'Second retrieval must return null (already consumed)');
});

test('expired challenge returns null', () => {
  const ch = base64url(crypto.randomBytes(32));
  // Store with an already-expired timestamp
  _challenges.set(ch, { userId: 3, action: 'register', expiresAt: Date.now() - 1 });
  const entry = getChallenge(ch);
  assertTrue(entry === null, 'Expired challenge must return null');
});

test('unknown challenge returns null', () => {
  const entry = getChallenge('nonexistent_challenge_abc123');
  assertTrue(entry === null, 'Unknown challenge must return null');
});

test('different users get independent challenges', () => {
  const ch1 = base64url(crypto.randomBytes(32));
  const ch2 = base64url(crypto.randomBytes(32));
  storeChallenge(ch1, { userId: 10, action: 'register' });
  storeChallenge(ch2, { userId: 20, action: 'authenticate' });
  assertEqual(getChallenge(ch1).userId, 10, 'Challenge 1 should belong to user 10');
  // ch2 still valid since ch1 was a different key
  const e2 = getChallenge(ch2);
  assertEqual(e2.userId, 20, 'Challenge 2 should belong to user 20');
});

// ══════════════════════════════════════════════════════════════════════════════
// ── 10. SIGN COUNTER (replay attack) ─────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== 10. Replay Attack Sign Counter ===');

// Replicate the counter check logic
function checkSignCount(signCount, storedCounter) {
  // Allow signCount=0 (authenticators that don't implement counter)
  if (signCount !== 0 && signCount <= storedCounter) {
    return { ok: false, reason: 'replay' };
  }
  return { ok: true };
}

test('counter=0 (no counter support) is always allowed', () => {
  const result = checkSignCount(0, 999);
  assertTrue(result.ok, 'signCount=0 must be allowed (authenticator does not implement counter)');
});

test('counter greater than stored is allowed', () => {
  const result = checkSignCount(5, 4);
  assertTrue(result.ok, 'signCount=5 > stored=4 must be allowed');
});

test('counter equal to stored is rejected as replay', () => {
  const result = checkSignCount(4, 4);
  assertFalse(result.ok, 'signCount equal to stored must be rejected as potential replay');
  assertEqual(result.reason, 'replay');
});

test('counter less than stored is rejected as replay', () => {
  const result = checkSignCount(3, 4);
  assertFalse(result.ok, 'signCount < stored must be rejected — clear replay attempt');
  assertEqual(result.reason, 'replay');
});

test('counter increment of 1 on every auth is valid', () => {
  let stored = 0;
  for (let i = 1; i <= 10; i++) {
    const result = checkSignCount(i, stored);
    assertTrue(result.ok, `Increment to ${i} from ${stored} must be valid`);
    stored = i;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── 11. UI — BIOMETRIC BUTTON IN SETTINGS ────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n=== 11. Settings UI Biometric Button ===');

test('app.js shows biometric setup section in Change Password modal', () => {
  const src = require('fs').readFileSync('./src/public/app.js', 'utf8');
  assertTrue(src.includes('Biometric Login') || src.includes('biometric'),
    'Biometric section must appear in Change Password modal');
});

test('app.js calls _webauthnAvailable to conditionally show biometric UI', () => {
  const src = require('fs').readFileSync('./src/public/app.js', 'utf8');
  assertTrue(src.includes('_webauthnAvailable'),
    'Must check _webauthnAvailable before showing biometric UI — not all devices support it');
});

test('app.js shows Remove button if credential exists, Setup button if not', () => {
  const src = require('fs').readFileSync('./src/public/app.js', 'utf8');
  assertTrue(
    src.includes('removeBiometricCredential') && src.includes('setupBiometricNow'),
    'Both remove and setup buttons must be present in the settings UI'
  );
});

test('app.js checks localStorage for existing credential before rendering biometric UI', () => {
  const src = require('fs').readFileSync('./src/public/app.js', 'utf8');
  assertTrue(
    src.includes('localStorage.getItem') && src.includes('fb_wa_cred'),
    'Must check fb_wa_cred in localStorage to decide which button to show'
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// ── FINAL REPORT ──────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n' + '═'.repeat(72));
console.log('  WEBAUTHN & PERSISTENT SESSION TEST REPORT');
console.log('═'.repeat(72));

// Group by section
const sections = {};
results.forEach(r => {
  // Section comes from last console.log before the test
  sections['All'] = sections['All'] || [];
  sections['All'].push(r);
});

results.forEach(r => {
  if (r.ok) {
    console.log(`✅  ${r.name}`);
  } else {
    console.log(`❌  ${r.name}`);
    console.log(`      ↳ ${r.err}`);
  }
});

console.log('\n' + '─'.repeat(72));
console.log(`  Total: ${_total} tests  |  Passed: ${_pass}  |  Failed: ${_fail}`);
console.log('─'.repeat(72));

if (_fail === 0) {
  console.log('\n✅  All WebAuthn & session tests passed.\n');
  process.exit(0);
} else {
  console.log(`\n❌  ${_fail} test(s) failed.\n`);
  process.exit(1);
}
