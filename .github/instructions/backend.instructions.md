---
description: "Use when editing backend Express routes, PostgreSQL schema, authentication, authorization, or security middleware in src/*.js."
name: "FuelStation Backend Guardrails"
applyTo: "src/*.js"
---
# Backend Guardrails

- Keep tenant separation strict: tenant-scoped queries must include tenant_id.
- Use parameterized SQL only. Never concatenate user input into SQL strings.
- Preserve role boundaries:
  - super: cross-tenant administration
  - admin/Owner/Manager: tenant-scoped operations
  - employee: minimal operation scope
- For write operations that can race (sales, credit, readings), use transactional protection.
- Preserve idempotency behavior where idempotency_key already exists.
- Keep audit logging for high-risk operations (bulk delete, tenant delete, day lock, exports).
- Avoid changing response payload keys without checking frontend usage.
- For security-sensitive changes, include at least one regression test in tests/.
