# 🔐 Password Change Bug Investigation & Fix Report
**Role:** Senior QA Engineer  
**Date:** 2026-03-19  
**Scope:** Super Admin password change + Station Admin password change  
**Reported Symptom:** "Changing super admin password reverts to old password. Same with station admin passwords."

---

## 🔍 Root Cause Summary

The password change feature was broken at **every layer simultaneously** — frontend, backend routing, backend logic, and deployment infrastructure. There were **9 distinct bugs** working together to produce the observed revert behaviour.

---

## 🐛 Bug Register (All Fixed)

### BUG-01 — `saveAdminPassword()` Bridge Override Never Written
| | |
|---|---|
| **File** | `src/public/bridge.js` |
| **Severity** | 🔴 Critical |
| **Root Cause** | A comment in `app.js` (line ~400) says *"The bridge overrides saveAdminPassword() to use the API"* — but the override was never implemented. `app.js`'s fallback `saveAdminPassword()` ran instead, computing a SHA-256 hash and writing it only to `localStorage` via `mt_saveTenants()`. Every subsequent `mt_getTenants_async()` call re-fetched tenants from PostgreSQL and overwrote localStorage with the server's bcrypt hash. Password visually reverted. |
| **Fix** | Added `window.saveAdminPassword` override inside the `DOMContentLoaded` block in `bridge.js`. The override calls `TenantAPI.getAdmins()` to resolve real DB IDs (see BUG-09), then calls `TenantAPI.resetAdminPassword()`. |

---

### BUG-02 — `/api/auth` Routes Mounted Without `authMiddleware`
| | |
|---|---|
| **File** | `src/server.js` line 1292, `src/auth.js` |
| **Severity** | 🔴 Critical |
| **Root Cause** | `app.use('/api/auth', loginOnlyLimiter, authRoutes(db))` — no `authMiddleware` in the chain. Both `super-change-password` and `change-password` used `requireRole()`, which checks `req.userType`. Since `authMiddleware` never ran, `req.userType` was always `undefined`. `requireRole` returned `401` for every single request, forever. |
| **Fix** | Replaced `requireRole()` in both routes with an inline `resolveSession()` helper (the same pattern already used by `/api/auth/session`). The helper reads the `Authorization` header, looks up the session, and validates `user_type`. No changes to `server.js` route mounting needed. |

---

### BUG-03 — `mt_saveSupercreds()` localStorage Fallback Created Misleading "Success"
| | |
|---|---|
| **File** | `src/public/multitenant.js` |
| **Severity** | 🟠 High |
| **Root Cause** | The original `mt_saveSupercreds()` in `multitenant.js` computed a SHA-256 hash and called `mt_saveSuperCreds(newUser, passHash)` which wrote to `localStorage` — even when `bridge.js` was loaded and the API call was supposed to be the authoritative path. If the API call failed (silently, due to BUG-02), the function still showed a success toast and stored the wrong hash locally. Next login: the local SHA-256 matched the localStorage hash so the UI let the user in, but any server-side authenticated action failed because the server still had the old bcrypt hash. |
| **Fix** | Removed the SHA-256 localStorage write from `mt_saveSupercreds()`. The function now delegates to `bridge.js`'s API-backed override. In offline mode it shows an explicit error rather than a misleading success. |

---

### BUG-04 — Server Never Verified `currentPassword` on Admin Self-Password Change
| | |
|---|---|
| **File** | `src/auth.js` (change-password route), `src/public/bridge.js`, `src/public/api-client.js` |
| **Severity** | 🟡 Medium |
| **Root Cause** | The server's `/auth/change-password` only accepted `newPassword`. `currentPassword` was validated client-side in bridge.js but never sent to the server. Any attacker with a stolen session token could silently change the account password without knowing the original. |
| **Fix** | Server now accepts `{ currentPassword, newPassword }`, fetches the user row, calls `verifyPassword(currentPassword, user.pass_hash)`, returns 403 if wrong. `api-client.js` and `bridge.js` updated to send `currentPassword`. |

---

### BUG-05 — Schema Startup Unconditionally Reset Super Admin Password on Every Server Start
| | |
|---|---|
| **File** | `src/schema.js` |
| **Severity** | 🔴 Critical |
| **Root Cause** | `initSchema()` ran on every server startup. When `SUPER_ADMIN_INIT_PASS` was set in Railway env vars, it **always** ran `UPDATE super_admin SET pass_hash = $1`. This means every Railway deploy, crash-restart, or scaling event silently overwrote the super admin password back to the env var value. Even if BUG-02 were fixed and the API call succeeded, the next server restart destroyed the change. |
| **Fix** | Added a `credentials_user_managed` boolean column to `super_admin`. The API change-password route sets it to `TRUE` on success. `initSchema()` now only syncs from env vars when `credentials_user_managed = FALSE`. A `FORCE_SUPER_CREDS_RESET=true` env var override is provided for genuine reset scenarios. |

---

### BUG-06 — `reset-password` Endpoint Was Super-Only But Button Is Shown to Station Admins
| | |
|---|---|
| **File** | `src/server.js` |
| **Severity** | 🔴 Critical |
| **Root Cause** | `POST /api/data/tenants/:tid/admins/:uid/reset-password` used `reqRole('super')`. The "Change Password" button (`openChangeAdminPassModal`) is rendered in the station admin settings panel in `admin.js` — visible and clickable by logged-in station admins (Owner/Manager role). When a station admin tried to use it, they received 403. |
| **Fix** | Changed to an inline ownership check: Super can reset any tenant's admin; a station Owner can reset passwords within their own tenant only. Cross-tenant resets are blocked with 403/404. |

---

### BUG-07 — `GET /api/data/tenants/:id/admins` Was Super-Only (Needed for BUG-01 Fix)
| | |
|---|---|
| **File** | `src/server.js` |
| **Severity** | 🟠 High |
| **Root Cause** | `GET /api/data/tenants/:id/admins` used `reqRole('super')`. The `saveAdminPassword` fix (BUG-01) needs to call `TenantAPI.getAdmins()` to resolve real DB user IDs (see BUG-09). A station admin token cannot call this endpoint, breaking the fix. |
| **Fix** | Changed to allow a station admin to list admins within their own tenant (`req.tenantId === req.params.id`). Super retains full access. |

---

### BUG-08 — Zero Test Coverage for All Password Change Endpoints
| | |
|---|---|
| **File** | `tests/integration/integration.test.js` |
| **Severity** | 🟠 High |
| **Root Cause** | None of the four test suites (`unit`, `integration`, `system`, `uat`) contained a single test for `super-change-password`, `change-password`, or `reset-password`. All these bugs were invisible to CI. |
| **Fix** | Added `suite_passwordChange()` with 22 regression tests covering: unauthenticated rejection, cross-role rejection, validation, successful change + new password works, old password rejected, cross-tenant attack prevention, and session integrity after reset. |

---

### BUG-09 — `APP.tenant.adminUsers[idx].id` May Be a Local Timestamp, Not a DB Integer
| | |
|---|---|
| **File** | `src/public/bridge.js`, `src/public/app.js` |
| **Severity** | 🟠 High |
| **Root Cause** | `APP.tenant` is loaded from `localStorage` via `mt_getActiveTenant()`. The `adminUsers` array is populated either from the offline fallback (using `_genId()` = a timestamp like `1710845921234`) or from the API path (real PostgreSQL integer). The tenant list endpoint (`TenantAPI.list()`) does NOT return `adminUsers`, so the localStorage object is always stale. Using `u.id` from this stale object in `TenantAPI.resetAdminPassword(t.id, u.id, pass)` would produce a silent `UPDATE … WHERE id = 1710845921234` matching 0 rows. |
| **Fix** | The `saveAdminPassword` bridge override now calls `TenantAPI.getAdmins(t.id)` first to get a fresh list with real DB IDs, then matches by `username` to find the correct record. |

---

## 📁 Files Changed

| File | Changes |
|------|---------|
| `src/auth.js` | Replaced `requireRole()` on change-password routes with inline `resolveSession()` helper. Added `currentPassword` verification. Added audit logging. |
| `src/schema.js` | Added `credentials_user_managed` column to `super_admin` table. Guarded env var sync to skip when user has changed credentials via UI. Added `FORCE_SUPER_CREDS_RESET` escape hatch. |
| `src/server.js` | Changed `reset-password` from `reqRole('super')` to ownership-aware inline check. Changed `GET admins` from `reqRole('super')` to allow own-tenant access. |
| `src/public/bridge.js` | Added `window.saveAdminPassword` override (the missing BUG-01 function). Updated `saveMyPassword` to send `currentPassword`. Updated `mt_saveSupercreds` (unchanged logic, kept as-is). |
| `src/public/multitenant.js` | Removed SHA-256 localStorage write from `mt_saveSupercreds()`. |
| `src/public/api-client.js` | Updated `AuthAPI.changePassword(currentPassword, newPassword)` signature. |
| `tests/integration/integration.test.js` | Added `suite_passwordChange()` with 22 regression tests. |

---

## 🧪 Running the New Tests

```bash
# Start the app first
node src/server.js

# Run only password change tests (set env vars to match your seed data)
BASE_URL=http://localhost:3000 \
TEST_TENANT_ID=test_tenant_001 \
SUPER_USER=superadmin \
SUPER_PASS=SuperSecret123! \
ADMIN_USER=owner \
ADMIN_PASS=Owner1234! \
node tests/integration/integration.test.js
```

The new suite is named `PasswordChange` — look for that section in the results output.

---

## ⚠️ Deployment Notes (Railway)

1. **Do NOT remove `SUPER_ADMIN_INIT_PASS` from Railway env vars** — it's still needed for first-time provisioning on a fresh DB. The fix makes it safe to keep it permanently without it wiping user-changed passwords.

2. **If you ever need to force-reset the super admin password** (e.g. someone locked themselves out), temporarily add `FORCE_SUPER_CREDS_RESET=true` to Railway env, redeploy, then immediately remove it.

3. **The `credentials_user_managed` column is added via `ALTER TABLE IF NOT EXISTS`** — the migration is safe to run on an existing production DB with zero downtime.
