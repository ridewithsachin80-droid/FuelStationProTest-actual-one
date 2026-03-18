# FuelStation Pro Workspace Instructions

## Project context
- This project is a multi-tenant fuel station management system.
- Backend is Node.js + Express + PostgreSQL.
- Frontend is a PWA with plain JavaScript modules in src/public.
- Deployment target is Railway with environment-driven configuration.

## Global engineering rules
- Preserve tenant isolation: every tenant-scoped read/write must filter by tenant_id.
- Do not introduce SQL string interpolation for user input; use parameterized queries.
- Keep security middleware behavior intact (authMiddleware, requireRole, brute-force checks, rate limits).
- Keep API compatibility for existing clients (camelCase + snake_case compatibility where currently supported).
- Prefer additive, backward-compatible changes over breaking changes.

## Date and financial correctness
- For operational dates, use IST-safe handling (existing istDate() helpers).
- Treat sales, credit, and expense operations as transactional where concurrent writes are possible.
- Preserve idempotency behavior for write paths that already use idempotency keys.

## Database and schema changes
- Place schema evolution in src/schema.js migrations block.
- Do not remove existing columns/tables unless explicitly requested and migration-safe.
- Maintain indexes for high-frequency filters (tenant_id, date, session/token lookups).

## Frontend integration rules
- Keep APP global state contract stable unless refactor is explicitly requested.
- Do not break offline-capable flows and service worker behavior.
- Keep employee/admin flows synchronized with backend source of truth.

## Testing expectations
- **Requirement-Test-Commit Workflow (Required for every feature/fix):**
  1. Update [.github/requirements.md](.github/requirements.md) with new requirement or status update
  2. Add test cases to appropriate tests/*.test.js file (or create new test file)
  3. Run `npm test` to verify all tests pass
  4. Only commit changes after successful test execution
- Run npm test before major changes and after changes.
- Add or update tests for auth/security/business-rule fixes.
- Do not ship a change that reduces existing test pass status.

## Documentation expectations
- Update architecture, project, and requirements docs when behavior or scope changes.
- Clearly mark what is implemented vs planned or partial.
