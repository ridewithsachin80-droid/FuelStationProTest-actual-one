---
name: security-smoke-tests
description: 'Use when performing quick security checks for FuelStation Pro: auth/session controls, brute-force handling, input validation, SQL injection resistance, and rate limiting.'
argument-hint: 'Describe endpoint area to test and whether this is pre-release or post-incident.'
user-invocable: true
---

# Security Smoke Tests

## When to Use
- Before release
- After auth/security changes
- After incident or suspicious traffic pattern

## Quick Procedure
1. Run npm test and verify security-related tests pass.
2. Verify auth-required endpoints reject missing/invalid tokens.
3. Verify login and PIN brute-force limits trigger expected errors.
4. Verify input sanitization and validation reject malformed payloads.
5. Verify SQL uses parameterized queries only.
6. Confirm public endpoints do not expose sensitive fields.

## Focus Areas in This Repo
- src/security.js
- src/auth.js
- src/server.js public endpoints
- tests/security.test.js and related auth tests

## Expected Outcome
- No bypass of auth or role checks
- No known SQL injection vector in changed code
- No sensitive hash/token leak in public API responses
- Test suite status unchanged or improved
