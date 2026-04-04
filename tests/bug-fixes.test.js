/**
 * FuelStation Pro — Bug Fix Verification Test Suite  v2
 *
 * BUG-01  WebAuthn sig never cryptographically verified
 * BUG-02  Duplicate bio functions override sessionStorage fix
 * BUG-03  WebAuthn rate limiting falls back to IP (inadequate)
 * BUG-04  Server 5xx falls back to local SHA-256 PIN bypass
 * BUG-05  credentialId stored in localStorage (should be sessionStorage)
 * BUG-07  _biometricUnlocked is a bare JS variable (DevTools accessible)
 * BUG-08  "Use PIN instead" shown before employee selected
 * BUG-09  Hardcoded 400ms race condition on biometric trigger
 */
'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Test runner — fully async sequential ──────────────────────────────────────
const _queue   = [];
const _results = [];
let _section   = '';
let PASS = 0, FAIL = 0;

function section(title) {
  _section = title;
  console.log(`\n${'─'.repeat(66)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(66));
}

function test(name, fn) { _queue.push({ section: _section, name, fn }); }

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const ok   = (v, msg)    => { if (!v) throw new Error(msg || `Expected truthy, got: ${v}`); };
const not  = (v, msg)    => { if (v)  throw new Error(msg || `Expected falsy, got: ${v}`); };
const eq   = (a, b, msg) => { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };
const throws = (fn, msg) => { let t=false; try{fn();}catch{t=true;} if(!t) throw new Error(msg||'Expected throw'); };

// ── WebAuthn test fixtures ────────────────────────────────────────────────────

// CBOR encoder that correctly handles byte-string lengths >= 24
function cborUint(n)  { return n < 24 ? Buffer.from([n]) : Buffer.from([0x18, n]); }
function cborNeg(n)   { const v=-n-1; return v<24 ? Buffer.from([0x20+v]) : Buffer.from([0x38,v]); }
function cborText(s)  { const b=Buffer.from(s,'utf8'); return Buffer.concat([b.length<24?Buffer.from([0x60+b.length]):Buffer.from([0x78,b.length]),b]); }
function cborBytes(b) {
  // major type 2: byte string with correct length prefix
  if (b.length < 24)   return Buffer.concat([Buffer.from([0x40 + b.length]), b]);
  if (b.length <= 255) return Buffer.concat([Buffer.from([0x58, b.length]),   b]);
  const hi=(b.length>>8)&0xff, lo=b.length&0xff;
  return Buffer.concat([Buffer.from([0x59, hi, lo]), b]);
}

async function makeKeyPair() {
  const { privateKey: priv, publicKey: pub } = await crypto.subtle.generateKey(
    { name:'ECDSA', namedCurve:'P-256' }, true, ['sign','verify']
  );
  const privDER = Buffer.from(await crypto.subtle.exportKey('pkcs8', priv));
  const pubDER  = Buffer.from(await crypto.subtle.exportKey('spki',  pub));
  return {
    privateKey: crypto.createPrivateKey({ key:privDER, format:'der', type:'pkcs8' }),
    publicKey:  crypto.createPublicKey ({ key:pubDER,  format:'der', type:'spki'  }),
    pubDER,
  };
}

function buildAttestationObject(publicKey) {
  const spkiDER = publicKey.export({ type:'spki', format:'der' });
  const x = spkiDER.slice(27, 59);
  const y = spkiDER.slice(59, 91);

  const coseKey = Buffer.concat([
    Buffer.from([0xa5]),
    cborUint(1),  cborUint(2),    // kty: EC2  (key 1 → value 2)
    cborUint(3),  cborNeg(-7),    // alg: ES256 (key 3 → value -7)
    cborNeg(-1),  cborUint(1),    // crv: P-256 (key -1 → value 1)
    cborNeg(-2),  cborBytes(x),   // x coord   (key -2 → 32 bytes)
    cborNeg(-3),  cborBytes(y),   // y coord   (key -3 → 32 bytes)
  ]);

  const rpIdHash  = crypto.createHash('sha256').update('localhost').digest();
  const flags     = Buffer.from([0x45]);
  const counter   = Buffer.alloc(4, 0);
  const aaguid    = Buffer.alloc(16, 0);
  const credId    = crypto.randomBytes(16);
  const credIdLen = Buffer.from([0x00, 0x10]);
  const authData  = Buffer.concat([rpIdHash, flags, counter, aaguid, credIdLen, credId, coseKey]);

  const attObj = Buffer.concat([
    Buffer.from([0xa3]),
    cborText('fmt'),      cborText('none'),
    cborText('attStmt'),  Buffer.from([0xa0]),
    cborText('authData'), cborBytes(authData),
  ]);

  return { attObjB64: attObj.toString('base64'), authData, credId };
}

function makeAssertion(privateKey, authData, clientDataJSON) {
  const cdh      = crypto.createHash('sha256').update(Buffer.from(clientDataJSON)).digest();
  const signed   = Buffer.concat([authData, cdh]);
  const sig      = crypto.sign('SHA-256', signed, privateKey);
  const b64url   = b => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  return {
    authenticatorDataB64url: b64url(authData),
    clientDataJSONB64url:    b64url(clientDataJSON),
    signatureB64url:         b64url(sig),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-01 — webauthn-crypto.js
// ═══════════════════════════════════════════════════════════════════════════════

section('BUG-01 · webauthn-crypto.js — CBOR decoder & COSE key extraction');

const { extractPublicKeyDER, verifyWebAuthnSignature } = require('../src/webauthn-crypto');
let _kp, _attObjB64, _authData;

test('extractPublicKeyDER — returns a Buffer', async () => {
  _kp = await makeKeyPair();
  const r = buildAttestationObject(_kp.publicKey);
  _attObjB64 = r.attObjB64; _authData = r.authData;
  ok(Buffer.isBuffer(extractPublicKeyDER(_attObjB64)), 'Must return Buffer');
});

test('extractPublicKeyDER — correct P-256 SPKI length (91 bytes)', async () => {
  eq(extractPublicKeyDER(_attObjB64).length, 91, 'P-256 SPKI DER must be 91 bytes');
});

test('extractPublicKeyDER — starts with 0x30 (ASN.1 SEQUENCE)', async () => {
  eq(extractPublicKeyDER(_attObjB64)[0], 0x30, 'Must start with SEQUENCE tag');
});

test('extractPublicKeyDER — Node crypto accepts the key', async () => {
  const der = extractPublicKeyDER(_attObjB64);
  ok(crypto.createPublicKey({ key:der, format:'der', type:'spki' }), 'Must be importable');
});

test('extractPublicKeyDER — extracted key matches original exactly', async () => {
  const der  = extractPublicKeyDER(_attObjB64);
  const orig = _kp.publicKey.export({ type:'spki', format:'der' });
  eq(der.toString('hex'), orig.toString('hex'), 'Keys must match byte for byte');
});

test('extractPublicKeyDER — throws on garbage input', async () => {
  throws(() => extractPublicKeyDER(Buffer.from('not cbor').toString('base64')), 'Must throw on garbage');
});

test('extractPublicKeyDER — 10 different key pairs all round-trip', async () => {
  for (let i=0; i<10; i++) {
    const kp2 = await makeKeyPair();
    const { attObjB64 } = buildAttestationObject(kp2.publicKey);
    const der  = extractPublicKeyDER(attObjB64);
    const orig = kp2.publicKey.export({ type:'spki', format:'der' });
    eq(der.toString('hex'), orig.toString('hex'), `Iteration ${i}: key mismatch`);
  }
});

section('BUG-01 · verifyWebAuthnSignature — valid & invalid assertions');

test('valid signature returns true', async () => {
  const cdj = JSON.stringify({ type:'webauthn.get', challenge:'abc', origin:'https://localhost' });
  const { authenticatorDataB64url, clientDataJSONB64url, signatureB64url } = makeAssertion(_kp.privateKey, _authData, cdj);
  const der = extractPublicKeyDER(_attObjB64);
  ok(verifyWebAuthnSignature(der.toString('base64'), authenticatorDataB64url, clientDataJSONB64url, signatureB64url),
    'Valid sig must return true — this IS the BUG-01 fix');
});

test('garbage signature returns false (BUG-01 core test)', async () => {
  const cdj = JSON.stringify({ type:'webauthn.get', challenge:'abc', origin:'https://localhost' });
  const { authenticatorDataB64url, clientDataJSONB64url } = makeAssertion(_kp.privateKey, _authData, cdj);
  const der     = extractPublicKeyDER(_attObjB64);
  const fakeSig = Buffer.alloc(64, 0xab).toString('base64');
  not(verifyWebAuthnSignature(der.toString('base64'), authenticatorDataB64url, clientDataJSONB64url, fakeSig),
    'Garbage sig must return false — old code would have accepted this');
});

test('tampered authenticatorData returns false', async () => {
  const cdj = JSON.stringify({ type:'webauthn.get', challenge:'t', origin:'https://localhost' });
  const { clientDataJSONB64url, signatureB64url } = makeAssertion(_kp.privateKey, _authData, cdj);
  const der = extractPublicKeyDER(_attObjB64);
  const t   = Buffer.from(_authData); t[5] ^= 0xff;
  const b64 = b => Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  not(verifyWebAuthnSignature(der.toString('base64'), b64(t), clientDataJSONB64url, signatureB64url),
    'Tampered authData must fail');
});

test('signature from wrong key returns false', async () => {
  const kp2 = await makeKeyPair();
  const cdj = JSON.stringify({ type:'webauthn.get', challenge:'x', origin:'https://localhost' });
  const { authenticatorDataB64url, clientDataJSONB64url, signatureB64url } = makeAssertion(kp2.privateKey, _authData, cdj);
  const der = extractPublicKeyDER(_attObjB64);
  not(verifyWebAuthnSignature(der.toString('base64'), authenticatorDataB64url, clientDataJSONB64url, signatureB64url),
    'Wrong-key sig must fail');
});

test('legacy attestationObject string is auto-parsed (backward compat)', async () => {
  const cdj = JSON.stringify({ type:'webauthn.get', challenge:'abc', origin:'https://localhost' });
  const { authenticatorDataB64url, clientDataJSONB64url, signatureB64url } = makeAssertion(_kp.privateKey, _authData, cdj);
  ok(verifyWebAuthnSignature(_attObjB64, authenticatorDataB64url, clientDataJSONB64url, signatureB64url),
    'Legacy attestationObject must be accepted');
});

test('10 cross-key checks never produce false positives', async () => {
  for (let i=0; i<10; i++) {
    const kpA = await makeKeyPair(); const kpB = await makeKeyPair();
    const { attObjB64:attA, authData:aA } = buildAttestationObject(kpA.publicKey);
    const cdj = JSON.stringify({ type:'webauthn.get', challenge:`c${i}`, origin:'https://x' });
    const { authenticatorDataB64url, clientDataJSONB64url, signatureB64url } = makeAssertion(kpB.privateKey, aA, cdj);
    const der = extractPublicKeyDER(attA);
    not(verifyWebAuthnSignature(der.toString('base64'), authenticatorDataB64url, clientDataJSONB64url, signatureB64url),
      `Iteration ${i}: cross-key sig must fail`);
  }
});

section('BUG-01 · auth.js — source structure');

test('auth.js imports webauthn-crypto', () => {
  const src = read('src/auth.js');
  ok(src.includes("require('./webauthn-crypto')"), 'Must require webauthn-crypto');
  ok(src.includes('extractPublicKeyDER'),          'Must import extractPublicKeyDER');
  ok(src.includes('verifyWebAuthnSignature'),      'Must import verifyWebAuthnSignature');
});

test('verifyWebAuthnSignature called in both authenticate routes', () => {
  const count = (read('src/auth.js').match(/verifyWebAuthnSignature\(/g)||[]).length;
  ok(count >= 2, `Must be called in both routes, found ${count}`);
});

test('auth.js returns 403 on invalid signature with warning log', () => {
  const src = read('src/auth.js');
  ok(src.includes('INVALID signature'),       'Must log INVALID signature');
  ok(src.includes("status(403)"),             'Must return 403');
});

test('extractPublicKeyDER called in admin registration route', () => {
  const src            = read('src/auth.js');
  const firstCallIdx   = src.indexOf('extractPublicKeyDER(');
  const registerIdx    = src.indexOf("router.post('/webauthn/register',");
  const authOptionsIdx = src.indexOf("router.post('/webauthn/auth-options',");
  ok(firstCallIdx > registerIdx && firstCallIdx < authOptionsIdx,
    'First extractPublicKeyDER call must be inside the admin /webauthn/register route');
});

test('extractPublicKeyDER called in employee registration route', () => {
  const count = (read('src/auth.js').match(/extractPublicKeyDER\(/g)||[]).length;
  ok(count >= 2, `extractPublicKeyDER must be called in both register routes, found ${count}`);
});

test('raw attestationObject is not passed directly to DB insert', () => {
  not(read('src/auth.js').includes('credResponse.attestationObject, 0,'),
    'Must not store raw attestationObject in DB');
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-02
// ═══════════════════════════════════════════════════════════════════════════════

section('BUG-02 · employee.js — no duplicate bio function definitions');

['emp_bioIsRegistered','emp_bioGetFails','emp_bioRecordFail','emp_bioClearFails'].forEach(fn => {
  test(`${fn} defined exactly once`, () => {
    const count = (read('src/public/employee.js').match(new RegExp(`^function ${fn}`,'gm'))||[]).length;
    eq(count, 1, `Must be defined once, found ${count}`);
  });
});

test('surviving bio functions use sessionStorage for fail tracking', () => {
  const src   = read('src/public/employee.js');
  const start = src.indexOf('function emp_bioGetFails');
  const block = src.slice(start, start + 600);
  ok(block.includes('sessionStorage'), 'Must use sessionStorage');
  not(block.includes('localStorage'),  'Must NOT use localStorage');
});

test('no localStorage references to BIO_FAIL_KEY remain', () => {
  const bad = read('src/public/employee.js').split('\n')
    .filter(l => l.includes('BIO_FAIL_KEY') && l.includes('localStorage'));
  eq(bad.length, 0, `Found ${bad.length} stale localStorage+BIO_FAIL_KEY lines:\n${bad.join('\n')}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-03
// ═══════════════════════════════════════════════════════════════════════════════

section('BUG-03 · server.js — dedicated WebAuthn rate limiter');

test('webauthnLimiter is defined', () => {
  ok(read('src/server.js').includes('webauthnLimiter'), 'webauthnLimiter must exist');
});

test('webauthnLimiter window is 60 s', () => {
  const src   = read('src/server.js');
  const block = src.slice(src.indexOf('webauthnLimiter'), src.indexOf('webauthnLimiter') + 500);
  ok(block.includes('60_000') || block.includes('60000'), 'Window must be 60 s');
});

test('webauthnLimiter max ≤ 10', () => {
  const src   = read('src/server.js');
  const match = src.slice(src.indexOf('webauthnLimiter'), src.indexOf('webauthnLimiter') + 500).match(/max:\s*(\d+)/);
  ok(match && parseInt(match[1]) <= 10, `max must be ≤ 10, got ${match?.[1]}`);
});

test('webauthnLimiter keys by credentialId', () => {
  const src   = read('src/server.js');
  const block = src.slice(src.indexOf('webauthnLimiter'), src.indexOf('webauthnLimiter') + 700);
  ok(block.includes('credentialId') || block.includes('credId'), 'Must key by credentialId');
});

test('webauthnLimiter covers all 4 WebAuthn endpoints', () => {
  const src = read('src/server.js');
  ['webauthn/auth-options','webauthn/authenticate','employee/auth-options','employee/authenticate']
    .forEach(ep => ok(src.includes(ep), `${ep} must be covered`));
});

test('webauthnLimiter registered before authRoutes mount', () => {
  const src = read('src/server.js');
  ok(src.indexOf('webauthnLimiter') < src.indexOf("app.use('/api/auth'"), 'Must precede authRoutes mount');
});

test('webauthnLimiter sends 429', () => {
  const block = read('src/server.js').slice(read('src/server.js').indexOf('webauthnLimiter'),
    read('src/server.js').indexOf('webauthnLimiter') + 800);
  ok(block.includes('429'), 'Must send 429');
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-04
// ═══════════════════════════════════════════════════════════════════════════════

section('BUG-04 · employee.js — no SHA-256 fallback on online error');

test('catch(netErr) does not fall back to SHA-256', () => {
  const src   = read('src/public/employee.js');
  const idx   = src.indexOf('catch(netErr)');
  ok(idx > -1, 'catch(netErr) must exist');
  const block = src.slice(idx, idx + 500);
  not(block.includes('pinHash === localHash'), 'SHA-256 fallback must be gone from catch block');
});

test('catch(netErr) shows toast and returns', () => {
  const src   = read('src/public/employee.js');
  const block = src.slice(src.indexOf('catch(netErr)'), src.indexOf('catch(netErr)') + 600);
  ok(block.includes('toast('),  'Must show toast');
  ok(block.includes('return;'), 'Must return immediately');
});

test('BUG-04 FIX comment is present', () => {
  ok(read('src/public/employee.js').includes('BUG-04 FIX'), 'Fix comment must be present');
});

test('offline path still permits local hash (genuine offline)', () => {
  const src = read('src/public/employee.js');
  ok(src.includes('OFFLINE PATH') && src.includes('navigator.onLine'), 'Offline path intact');
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-05
// ═══════════════════════════════════════════════════════════════════════════════

section('BUG-05 · bridge.js — credential IDs in sessionStorage');

test('no localStorage + WA_CRED_KEY in bridge.js', () => {
  const bad = read('src/public/bridge.js').split('\n')
    .filter(l => l.includes('WA_CRED_KEY') && l.includes('localStorage'));
  eq(bad.length, 0, `Found ${bad.length} bad lines:\n${bad.join('\n')}`);
});

test('no localStorage + WA_TENANT_KEY in bridge.js', () => {
  const bad = read('src/public/bridge.js').split('\n')
    .filter(l => l.includes('WA_TENANT_KEY') && l.includes('localStorage'));
  eq(bad.length, 0, `Found ${bad.length} bad lines:\n${bad.join('\n')}`);
});

test("app.js doesn't read fb_wa_cred from localStorage", () => {
  not(read('src/public/app.js').includes("localStorage.getItem('fb_wa_cred')"),
    'Must use sessionStorage');
});

test('sessionStorage used for set/get/remove of WA_CRED_KEY', () => {
  const src = read('src/public/bridge.js');
  ok(src.includes('sessionStorage.setItem(WA_CRED_KEY'),    'setItem via sessionStorage');
  ok(src.includes('sessionStorage.getItem(WA_CRED_KEY'),    'getItem via sessionStorage');
  ok(src.includes('sessionStorage.removeItem(WA_CRED_KEY'), 'removeItem via sessionStorage');
});

test('fb_session still uses localStorage (cross-tab persistence unchanged)', () => {
  const lines = read('src/public/bridge.js').split('\n')
    .filter(l => l.includes('fb_session') && l.includes('localStorage'));
  ok(lines.length >= 2, `fb_session must still use localStorage, found ${lines.length} lines`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-07
// ═══════════════════════════════════════════════════════════════════════════════

section('BUG-07 · bridge.js — _biometricUnlocked in _bioLock closure');

test('bare _biometricUnlocked declaration is gone', () => {
  const src = read('src/public/bridge.js');
  not(src.includes('let _biometricUnlocked'),   'Must not use bare let');
  not(src.includes('var _biometricUnlocked'),   'Must not use bare var');
  not(src.includes('const _biometricUnlocked'), 'Must not use bare const');
});

test('_bioLock closure is defined', () => {
  ok(read('src/public/bridge.js').includes('const _bioLock'), '_bioLock must be defined');
});

test('_bioLock exposes get, set, reset interface', () => {
  const src   = read('src/public/bridge.js');
  const block = src.slice(src.indexOf('const _bioLock'), src.indexOf('const _bioLock') + 500);
  ok(block.includes('get:'),   'Must have get');
  ok(block.includes('set:'),   'Must have set');
  ok(block.includes('reset:'), 'Must have reset');
});

test('_bioLock uses IIFE for private state', () => {
  const src   = read('src/public/bridge.js');
  const block = src.slice(src.indexOf('const _bioLock'), src.indexOf('const _bioLock') + 400);
  ok(block.includes('(() =>') || block.includes('(function'), 'Must use IIFE');
});

test('no bare _biometricUnlocked assignments remain', () => {
  const src = read('src/public/bridge.js');
  not(src.includes('_biometricUnlocked = true'),  'Must use _bioLock.set(true)');
  not(src.includes('_biometricUnlocked = false'), 'Must use _bioLock.reset()');
});

test('_bioLock API used throughout', () => {
  const src = read('src/public/bridge.js');
  ok(src.includes('_bioLock.set(true)'), '_bioLock.set(true) used');
  ok(src.includes('_bioLock.reset()'),   '_bioLock.reset() used');
  ok(src.includes('_bioLock.get()'),     '_bioLock.get() used');
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-08
// ═══════════════════════════════════════════════════════════════════════════════

section('BUG-08 · employee.js — "Use PIN instead" starts hidden');

test('empUsePinBtn renders with display:none', () => {
  const src = read('src/public/employee.js');
  const idx = src.indexOf('empUsePinBtn');
  ok(idx > -1, 'empUsePinBtn must exist');
  ok(src.slice(idx, idx + 250).includes('display:none'), 'Button must start hidden');
});

test('emp_loginNameChanged shows button only when bio is registered', () => {
  const src   = read('src/public/employee.js');
  const block = src.slice(src.indexOf('function emp_loginNameChanged'), src.indexOf('function emp_loginNameChanged') + 500);
  ok(block.includes('empUsePinBtn'), 'Must handle empUsePinBtn');
  ok(block.includes('hasBio'),       'Visibility must depend on hasBio');
});

test('emp_showPinFallback hides the button', () => {
  const src   = read('src/public/employee.js');
  const block = src.slice(src.indexOf('function emp_showPinFallback'), src.indexOf('function emp_showPinFallback') + 400);
  ok(block.includes('empUsePinBtn') && block.includes('display'), 'Must hide empUsePinBtn');
});

// ═══════════════════════════════════════════════════════════════════════════════
// BUG-09
// ═══════════════════════════════════════════════════════════════════════════════

section('BUG-09 · bridge.js — rAF replaces 400ms timeout');

test('setTimeout(doUnlock, 400) is gone', () => {
  not(read('src/public/bridge.js').includes('setTimeout(doUnlock, 400)'), 'Must be removed');
});

test('double-rAF pattern is used', () => {
  const src = read('src/public/bridge.js');
  ok(src.includes('requestAnimationFrame'), 'Must use rAF');
  ok(
    src.includes('requestAnimationFrame(() => requestAnimationFrame(doUnlock))') ||
    src.includes('requestAnimationFrame(()=>requestAnimationFrame(doUnlock))'),
    'Must use double-rAF for paint guarantee'
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Regression
// ═══════════════════════════════════════════════════════════════════════════════

section('Regression — existing functionality preserved');

test('auth.js has all 8 WebAuthn routes', () => {
  const src = read('src/auth.js');
  ['/webauthn/register-options','/webauthn/register','/webauthn/auth-options','/webauthn/authenticate',
   '/webauthn/employee/register-options','/webauthn/employee/register',
   '/webauthn/employee/auth-options','/webauthn/employee/authenticate']
    .forEach(r => ok(src.includes(r), `Route ${r} missing`));
});

test('auth.js replay-attack counter check in both auth routes', () => {
  const count = (read('src/auth.js').match(/signCount !== 0 && signCount <= cred\.counter/g)||[]).length;
  eq(count, 2, `Must appear in both routes, found ${count}`);
});

test('auth.js challenges are single-use (DELETE from DB)', () => {
  ok(read('src/auth.js').includes('DELETE FROM webauthn_challenges WHERE challenge'), 'Challenge must be deleted');
});

test('server.js loginOnlyLimiter still guards /api/auth', () => {
  const src = read('src/server.js');
  ok(src.includes('loginOnlyLimiter'),                      'loginOnlyLimiter must exist');
  ok(src.includes("app.use('/api/auth', loginOnlyLimiter"), 'Must be applied to /api/auth');
});

test('webauthn-crypto.js exports both functions', () => {
  const { extractPublicKeyDER:e, verifyWebAuthnSignature:v } = require('../src/webauthn-crypto');
  eq(typeof e, 'function', 'extractPublicKeyDER must be a function');
  eq(typeof v, 'function', 'verifyWebAuthnSignature must be a function');
});

test('emp_loginNameChanged still exists', () => {
  ok(read('src/public/employee.js').includes('function emp_loginNameChanged'), 'Must still exist');
});

test('offline fallback path intact in emp_doLogin', () => {
  const src = read('src/public/employee.js');
  ok(src.includes('OFFLINE PATH') && src.includes('navigator.onLine'), 'Offline path intact');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════════════════

(async () => {
  for (const { section: sec, name, fn } of _queue) {
    try {
      await fn();
      PASS++;
      _results.push({ sec, name, ok: true });
      console.log(`  ✅  ${name}`);
    } catch(e) {
      FAIL++;
      _results.push({ sec, name, ok: false, err: e.message });
      console.log(`  ❌  ${name}`);
      console.log(`       ↳ ${e.message}`);
    }
  }

  const total = PASS + FAIL;
  console.log('\n' + '═'.repeat(66));
  console.log('  BUG-FIX VERIFICATION — FINAL REPORT');
  console.log('═'.repeat(66));
  [...new Set(_results.map(r => r.sec))].forEach(sec => {
    const sr = _results.filter(r => r.sec === sec);
    const sp = sr.filter(r => r.ok).length;
    const sf = sr.filter(r => !r.ok).length;
    console.log(`  ${sf===0?'✅':'❌'}  ${sec}  (${sp}/${sr.length})`);
  });
  console.log('\n' + '─'.repeat(66));
  console.log(`  Total: ${total}  |  Passed: ${PASS}  |  Failed: ${FAIL}`);
  console.log('─'.repeat(66));

  if (FAIL === 0) {
    console.log('\n  ✅  ALL TESTS PASSED — safe to ship.\n');
    process.exit(0);
  } else {
    console.log(`\n  ❌  ${FAIL} test(s) failed:\n`);
    _results.filter(r => !r.ok).forEach(r =>
      console.log(`      [${r.sec}]\n       ${r.name}\n       ↳ ${r.err}\n`)
    );
    process.exit(1);
  }
})();
