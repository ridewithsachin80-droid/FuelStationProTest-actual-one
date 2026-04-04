'use strict';
/**
 * webauthn-crypto.js
 * Minimal self-contained WebAuthn cryptographic helpers.
 * No external dependencies — uses Node.js built-in `crypto` only.
 *
 * Exports
 *   extractPublicKeyDER(attestationObjectB64url)  → Buffer (SPKI DER)
 *   verifyWebAuthnSignature(publicKeySource, authenticatorDataB64url, clientDataJSONB64url, signatureB64url) → boolean
 */

const crypto = require('crypto');

// ── Minimal CBOR decoder ──────────────────────────────────────────────────
// Handles only the subset used in WebAuthn:
//   Major types 0 (uint), 1 (negative int), 2 (byte string),
//               3 (text string), 4 (array), 5 (map)
// Does NOT handle: tags, floats, indefinite-length items.

function _readLength(buf, pos, additionalInfo) {
  if (additionalInfo < 24)  return { len: additionalInfo, next: pos };
  if (additionalInfo === 24) return { len: buf[pos], next: pos + 1 };
  if (additionalInfo === 25) return { len: buf.readUInt16BE(pos), next: pos + 2 };
  if (additionalInfo === 26) return { len: buf.readUInt32BE(pos), next: pos + 4 };
  throw new Error('CBOR: unsupported additional info ' + additionalInfo);
}

function _decode(buf, pos) {
  const byte = buf[pos];
  const majorType      = (byte >> 5) & 0x7;
  const additionalInfo = byte & 0x1f;
  const { len, next }  = _readLength(buf, pos + 1, additionalInfo);

  switch (majorType) {
    case 0: // unsigned integer
      return { value: len, next };
    case 1: // negative integer
      return { value: -1 - len, next };
    case 2: { // byte string
      const end = next + len;
      return { value: buf.slice(next, end), next: end };
    }
    case 3: { // text string
      const end = next + len;
      return { value: buf.slice(next, end).toString('utf8'), next: end };
    }
    case 4: { // array
      let p = next;
      const arr = [];
      for (let i = 0; i < len; i++) {
        const item = _decode(buf, p);
        arr.push(item.value);
        p = item.next;
      }
      return { value: arr, next: p };
    }
    case 5: { // map
      let p = next;
      const map = new Map();
      for (let i = 0; i < len; i++) {
        const k = _decode(buf, p); p = k.next;
        const v = _decode(buf, p); p = v.next;
        map.set(k.value, v.value);
      }
      return { value: map, next: p };
    }
    default:
      throw new Error('CBOR: unsupported major type ' + majorType);
  }
}

function decodeCBOR(buf) {
  return _decode(buf, 0).value;
}

// ── Base64url helpers ─────────────────────────────────────────────────────

function _fromB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

// ── SPKI DER builder for EC P-256 uncompressed point ─────────────────────
//
//  SEQUENCE {
//    SEQUENCE {
//      OID 1.2.840.10045.2.1   (id-ecPublicKey)
//      OID 1.2.840.10045.3.1.7 (prime256v1 / P-256)
//    }
//    BIT STRING 0x04 || x || y
//  }

const EC_SPKI_HEADER = Buffer.from(
  '3059'                            // SEQUENCE (89 bytes)
  + '3013'                          // SEQUENCE (19 bytes)
  +   '06072a8648ce3d0201'          // OID ecPublicKey
  +   '06082a8648ce3d030107'        // OID P-256
  + '034200'                        // BIT STRING (66 bytes, 0 unused bits)
  + '04',                           // uncompressed point marker
  'hex'
);

function _buildECP256SPKI(x, y) {
  if (!Buffer.isBuffer(x)) x = Buffer.from(x);
  if (!Buffer.isBuffer(y)) y = Buffer.from(y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error('WebAuthn: P-256 coordinates must be 32 bytes each');
  }
  return Buffer.concat([EC_SPKI_HEADER, x, y]);
}

// ── Parse attestationObject → SPKI DER ───────────────────────────────────

/**
 * Extract the credential public key from a WebAuthn attestationObject
 * (base64url or base64 encoded) and return it as an SPKI DER Buffer.
 *
 * Supports: P-256 (ES256, alg -7). Throws for other key types.
 */
function extractPublicKeyDER(attestationObjectB64) {
  const raw      = _fromB64url(attestationObjectB64);
  const attObj   = decodeCBOR(raw);          // Map { fmt, attStmt, authData }

  const authData = attObj.get('authData');
  if (!Buffer.isBuffer(authData) || authData.length < 37) {
    throw new Error('WebAuthn: invalid authData length');
  }

  // Bit 6 of flags byte (offset 32) = AT (attested credential data present)
  const flags = authData[32];
  if (!(flags & 0x40)) {
    throw new Error('WebAuthn: AT flag not set — no credential data in authData');
  }

  // Parse attested credential data
  // [37:53]  AAGUID (16 bytes)
  // [53:55]  credentialIdLength (uint16be)
  // [55:55+L] credentialId
  // [55+L:]  COSE key (CBOR)
  const credIdLen     = authData.readUInt16BE(53);
  const coseKeyOffset = 55 + credIdLen;

  const coseKey = _decode(authData, coseKeyOffset).value; // Map

  const kty = coseKey.get(1);   // 2 = EC2
  const alg  = coseKey.get(3);  // -7 = ES256
  const crv  = coseKey.get(-1); // 1  = P-256

  if (kty !== 2 || alg !== -7 || crv !== 1) {
    throw new Error(`WebAuthn: unsupported COSE key (kty=${kty} alg=${alg} crv=${crv}). Only ES256/P-256 supported.`);
  }

  const x = coseKey.get(-2);
  const y = coseKey.get(-3);

  return _buildECP256SPKI(x, y);
}

// ── Signature verification ────────────────────────────────────────────────

/**
 * Verify a WebAuthn assertion signature.
 *
 * @param {Buffer|string} publicKeySource
 *   Either:
 *   - A Buffer containing SPKI DER (new format stored after this fix)
 *   - A base64url string of the raw attestationObject (legacy format)
 *     → will be parsed automatically for backward compatibility
 *
 * @param {string} authenticatorDataB64url  base64url encoded authenticatorData
 * @param {string} clientDataJSONB64url     base64url encoded clientDataJSON
 * @param {string} signatureB64url          base64url encoded DER signature
 *
 * @returns {boolean}
 */
function verifyWebAuthnSignature(publicKeySource, authenticatorDataB64url, clientDataJSONB64url, signatureB64url) {
  // Resolve the public key to SPKI DER
  let spkiDer;
  if (Buffer.isBuffer(publicKeySource)) {
    spkiDer = publicKeySource;
  } else {
    // String: check if it looks like DER (starts with 0x30 SEQUENCE) or is attestationObject CBOR
    const raw = _fromB64url(publicKeySource);
    if (raw[0] === 0x30) {
      // Looks like DER already
      spkiDer = raw;
    } else {
      // Assume it is a legacy attestationObject — extract from it
      spkiDer = extractPublicKeyDER(publicKeySource);
    }
  }

  const pubKey = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });

  // signed_data = authenticatorData || SHA-256(clientDataJSON)
  const authDataBuf     = _fromB64url(authenticatorDataB64url);
  const clientDataBuf   = _fromB64url(clientDataJSONB64url);
  const clientDataHash  = crypto.createHash('sha256').update(clientDataBuf).digest();
  const signedData      = Buffer.concat([authDataBuf, clientDataHash]);

  const signature = _fromB64url(signatureB64url);

  return crypto.verify('SHA-256', signedData, pubKey, signature);
}

module.exports = { extractPublicKeyDER, verifyWebAuthnSignature };
