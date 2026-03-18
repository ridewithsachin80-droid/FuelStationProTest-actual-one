# FuelStation Pro Project Documentation

## 1. Project summary
FuelStation Pro is a multi-tenant fuel station management application built as:
- Backend API: Node.js + Express + PostgreSQL
- Frontend: Plain JavaScript PWA
- Deployment target: Railway

The system supports fuel station operations for super admin, tenant admin, and employee roles.

## 2. Repository layout

Top-level files and folders:
- package.json: runtime metadata, scripts, dependencies
- railway.json: deployment settings
- README.md: project notes and deployment context
- FIXES.md: bug fix notes
- scripts/setup.js: setup helper (Chart.js and screenshots scaffolding)
- deploy/Dockerfile: container deployment artifact
- src/: backend and frontend source
- tests/: automated Jest test suite

## 3. Backend modules

### 3.1 src/server.js
Responsibilities:
- Express app initialization
- Security middleware setup (helmet, CORS, rate limit)
- Health endpoints
- Public endpoints for employee support and reference data
- Auth and data route mounting
- Tenant admin management routes

### 3.2 src/schema.js
Responsibilities:
- PostgreSQL pool configuration
- Schema initialization and migrations
- Password hashing/verification helpers
- SQLite-like compatibility wrapper used by legacy patterns

### 3.3 src/security.js
Responsibilities:
- inputSanitizerMiddleware
- authMiddleware
- requireRole authorization helper
- brute-force checks and login-attempt recording
- session create/destroy helpers
- audit logging helper

### 3.4 src/auth.js
Responsibilities:
- super/admin/employee login
- logout
- session check endpoint
- password migration behavior (legacy to bcrypt)

### 3.5 src/data.js
Responsibilities:
- Generic tenant-scoped data CRUD routes
- business-rule checks (day lock, idempotency, credit constraints)
- store metadata and alias mapping

## 4. Frontend modules (src/public)

Core UI and runtime files:
- index.html: shell and initial UI structure
- app.js: app bootstrapping, page rendering, and core workflows
- admin.js: admin-specific interactions
- employee.js: employee portal interactions (login, sales, readings)
- api-client.js: API helper client
- bridge.js: legacy behavior to API-backed behavior bridge
- utils.js: shared helpers (hashing, sanitize, utility methods)
- multitenant.js: tenant selection and tenant-centric helpers
- sw.js: service worker
- manifest.json: PWA metadata

## 5. Database model

Main table groups:
- tenancy and auth: super_admin, tenants, admin_users, sessions, login_attempts
- operations: sales, tanks, pumps, dip_readings, shifts, employees
- finance: expenses, fuel_purchases, credit_customers, credit_transactions
- extensions: lubes_products, lubes_sales
- governance/system: settings, audit_log

Schema and migration behavior:
- Table creation and index creation are in src/schema.js.
- Additive ALTER TABLE migrations are executed at startup.

## 6. API overview

Auth APIs:
- /api/auth/super-login
- /api/auth/login
- /api/auth/employee-login
- /api/auth/logout
- /api/auth/session

Health APIs:
- /api/health
- /api/health/detailed

Data APIs:
- /api/data/* (tenant-scoped data CRUD and business operations)
- /api/public/* (limited public support endpoints for employee flows)

## 7. Security controls currently present

- HTTP hardening via helmet
- CORS policy handling
- Rate limits (global and route-specific)
- Brute-force login protection
- Session token auth
- Role checks via requireRole
- Input sanitization
- Parameterized SQL usage
- Audit logging on key actions

## 8. Performance and reliability notes

- Connection pooling configured for production load profile.
- Health endpoints expose runtime and DB status.
- Transactions used in critical write paths.
- Idempotency keys used in selected create flows.

## 9. Testing setup

Framework:
- Jest

Current test files:
- tests/security.test.js
- tests/api.test.js
- tests/auth.test.js
- tests/schema.test.js
- tests/verify-pin.test.js
- tests/load/sales-concurrency.js

Commands:
- npm test
- npm run test:coverage
- npm run test:load:sales
- npm run test:load:sales:400

## 10. Build and deployment

Local:
- npm install
- npm run setup
- npm start

Deployment:
- Railway-compatible runtime
- Dockerfile available in deploy/

## 11. Current technical debt and next-step candidates

- Expand the new load/performance script into CI thresholds and repeatable benchmark baselines for 400+ concurrent operation targets.
- Add formal backup and restore scripts and runbook.
- Expand requirement traceability from business requirement to test coverage.
- Add API contract tests for public and auth endpoints.
