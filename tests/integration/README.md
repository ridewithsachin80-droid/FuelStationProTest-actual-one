# FuelBunk Pro — Integration Tests

Tests how modules work **together** across real HTTP boundaries.
No mocks. Real DB. Real Express. Real token flows.

## Quick Start

```bash
# 1. Set environment variables
export DATABASE_URL=your_postgresql_url
export BASE_URL=http://localhost:3000
export TEST_TENANT_ID=test_tenant_001
export SUPER_USER=superadmin
export SUPER_PASS=SuperSecret123!
export ADMIN_USER=owner
export ADMIN_PASS=Owner1234!

# 2. Start the app
node src/server.js &

# 3. Seed test data (run once)
node tests/integration/seed.js

# 4. Run integration tests
node tests/integration/integration.test.js
```

## What is tested (16 suites, 70+ tests)

| Suite | Integration Points Tested |
|---|---|
| **Health** | Server up, JSON response |
| **SuperAuth** | bruteForce ↔ DB ↔ createSession ↔ token |
| **AdminAuth** | tenant check ↔ bcrypt ↔ session ↔ logout |
| **AuthMiddleware** | Bearer token ↔ session DB ↔ route access |
| **EmployeePIN** | PIN format ↔ bcrypt ↔ tenant check |
| **SaleFlow** | Validation ↔ tenant check ↔ stock enforcement ↔ DB ↔ idempotency |
| **SaleEditDelete** | Auth ↔ role check ↔ data router ↔ DB |
| **CreditLimit** | Credit customer DB ↔ outstanding balance ↔ sale block |
| **LubeSale** | Product stock ↔ atomic deduct ↔ idempotency ↔ settings DB |
| **Expense** | Validation ↔ idempotency ↔ DB insert |
| **TankDeduction** | Shift close ↔ fuel type matching ↔ idempotency ↔ tank UPDATE |
| **DayLock** | Lock state ↔ Owner role ↔ write block |
| **DataFlow** | Bulk load ↔ per-store reads ↔ tenant isolation |
| **Sanitisation** | XSS/SQLi input ↔ middleware ↔ server stability |
| **Subscription** | Public sub status endpoint |
| **SalesSummary** | Date filter ↔ aggregation query ↔ response shape |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | App URL |
| `TEST_TENANT_ID` | `test_tenant_001` | Test station ID |
| `SUPER_USER` | `superadmin` | Super admin username |
| `SUPER_PASS` | `SuperSecret123!` | Super admin password |
| `ADMIN_USER` | `owner` | Station admin username |
| `ADMIN_PASS` | `Owner1234!` | Station admin password |

## Test data created by seed.js

- **Super admin**: username/password from env
- **Tenant**: `test_tenant_001` — Test Station, BPCL, Koratagere
- **Admin user**: Owner role with password from env
- **Tanks**: Petrol 15K (12000L), Diesel 20K (8000L)
- **Pumps**: pump_1 (active), pump_2 (active), inactive_pump_test (inactive)
- **Employee**: Test Employee, PIN 1234
- **Credit customer**: TestCreditCustomer, limit ₹10000, balance ₹2000
- **Lube product**: MAK 2T Extra, 50 units
- **Prices**: Petrol ₹94, Diesel ₹87, Premium ₹112.5
