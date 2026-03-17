# FuelBunk Pro — System Tests

End-to-end system verification against a production-mirror environment.
Tests the COMPLETE system as a whole — functional AND non-functional requirements.

## Quick Start

```bash
# Prerequisites: integration seed data already loaded
# node tests/integration/seed.js (run once)

# Run against your live deployment
BASE_URL=https://your-app.railway.app \
TEST_TENANT_ID=test_tenant_001 \
SUPER_USER=superadmin \
SUPER_PASS=SuperSecret123! \
ADMIN_USER=owner \
ADMIN_PASS=Owner1234! \
node tests/system/system.test.js
```

## Coverage — 97 tests across 17 suites

### Functional Requirements (FR)

| ID | Suite | Tests | Business requirement |
|---|---|---|---|
| FR-01 | Availability | 5 | System up, health check, root URL |
| FR-02 | Multi-Tenant | 6 | Station management, tenant isolation, OMC field |
| FR-03 | Employees | 5 | PIN auth, employee list, no hash exposure |
| FR-04 | Fuel Sales | 7 | Sale recording, idempotency, stock enforcement, future date block |
| FR-05 | Tanks | 6 | Tank levels, deduction, case-insensitive fuel type, prices |
| FR-06 | Credit | 4 | Credit customer list, over-limit block, balance tracking |
| FR-07 | Lubes | 4 | Product lookup, stock deduction, atomic transaction, idempotency |
| FR-08 | Expenses | 4 | Expense recording, idempotency, amount limits |
| FR-09 | Subscription | 3 | Public status, required fields, authenticated details |
| FR-10 | Day-Lock | 4 | Lock status, Owner-only lock, locked day blocks writes, audit log |
| FR-11 | Reporting | 4 | Bulk load, sales summary, shift history, settings |

### Non-Functional Requirements (NFR)

| ID | Suite | Tests | Requirement |
|---|---|---|---|
| NFR-SEC | Security | 14 | Headers, CORS, XSS, SQLi, brute force, rate limit, role enforcement |
| NFR-PERF | Performance | 7 | Response SLAs, concurrency, DB pool under load |
| NFR-REL | Reliability | 5 | Error handling, JSON responses, idempotency, graceful degradation |
| NFR-USE | API Contract | 6 | Response shapes, HTTP semantics, error message format |
| NFR-PWA | PWA/Offline | 8 | Manifest, service worker, icons, cache headers |
| NFR-COMP | Compliance | 5 | Tenant isolation, IST dates, audit trail, RBAC |

## Performance SLAs tested

| Endpoint | SLA |
|---|---|
| `/api/health` | < 200ms |
| Login (bcrypt) | < 1500ms |
| Data API calls | < 800ms |
| Bulk load | < 1600ms |
| Static assets | < 300ms |
| 10 concurrent requests | All succeed |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | Target system URL |
| `TEST_TENANT_ID` | `test_tenant_001` | Test station ID |
| `SUPER_USER` | `superadmin` | Super admin username |
| `SUPER_PASS` | `SuperSecret123!` | Super admin password |
| `ADMIN_USER` | `owner` | Station admin username |
| `ADMIN_PASS` | `Owner1234!` | Station admin password |
