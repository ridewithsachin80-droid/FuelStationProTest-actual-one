# FuelBunk Pro — UAT Sign-Off Checklist

**Station**: Sri Vanamala Service Station, Koratagere
**Date**: March 2026
**Tested by**: Station Owner / End-Users
**Version**: FuelBunk Pro v1.2.0

---

## How to Run

```bash
BASE_URL=https://your-app.railway.app \
TEST_TENANT_ID=your_station_id \
ADMIN_USER=owner \
ADMIN_PASS=YourPassword \
node tests/uat/uat.test.js
```

---

## UAT Scenarios — 15 Business Workflows, 76 Tests

| # | Scenario | Persona | Business workflow | Status |
|---|---|---|---|---|
| UAT-01 | Owner Morning | Gajendra (Owner) | Login → view dashboard → check tanks → check staff → logout | ⬜ |
| UAT-02 | Attendant Sale | Ravi (Attendant) | Record diesel UPI sale → cash petrol sale → oversell blocked → duplicate prevented | ⬜ |
| UAT-03 | Expense Recording | Ravi (Attendant) | Record cleaning expense → rejected if no desc → duplicate blocked | ⬜ |
| UAT-04 | Shift Close | Ravi (Attendant) | Close shift → tank deducted → idempotent (can't deduct twice) → summary saved | ⬜ |
| UAT-05 | Lube Sales | Ravi (Attendant) | Sell MAK 2T oil → stock deducted → oversell blocked → retry safe | ⬜ |
| UAT-06 | Credit Management | Gajendra (Owner) | View credit customers → valid credit sale → overlimit sale blocked | ⬜ |
| UAT-07 | Sale Correction | Gajendra (Owner) | Find wrong sale → Owner edits it → non-Owner cannot edit/delete | ⬜ |
| UAT-08 | Day Close | Gajendra (Owner) | Check lock status → Owner locks day → backdated sale blocked → audit log | ⬜ |
| UAT-09 | Financial Reports | Suresh (Accountant) | View sales summary → expenses → fuel purchases → credit transactions | ⬜ |
| UAT-10 | BPCL Dip Chart | Gajendra (Owner) | 100cm → 7803.71L ✓ → 185cm → 15075.62L ✓ → mm interpolation works | ⬜ |
| UAT-11 | Super Admin | Super Admin | Login → view all stations → each has OMC → isolated from station admin | ⬜ |
| UAT-12 | Subscription | Gajendra (Owner) | Check subscription status → read-only flag present → full details accessible | ⬜ |
| UAT-13 | Security | All users | Wrong password blocked → PINs/passwords never exposed → SQL injection safe | ⬜ |
| UAT-14 | PWA Mobile | All users | Installable (manifest) → offline capable (SW) → icons present → portrait mode | ⬜ |
| UAT-15 | Error Messages | All users | Clear errors → no stack traces → JSON responses always → available litres shown | ⬜ |

---

## Acceptance Criteria

For the system to be **ACCEPTED** for production release:

- [ ] All 15 scenarios pass (skipped tests due to missing seed data are acceptable)
- [ ] No UAT scenario shows a FAIL
- [ ] Pass rate ≥ 95%

---

## Sign-Off

| Role | Name | Signature | Date |
|---|---|---|---|
| Station Owner | | | |
| Shift Manager | | | |
| Accountant | | | |
| Developer | | | |

---

## Notes

- Skipped tests (`s`) mean the seed data for that test was not present — run `node tests/integration/seed.js` to create it
- UAT-10 (Dip Chart) runs locally without a server — it directly verifies the official BPCL calibration data
- UAT-13 (Security) verifies data privacy without needing to be logged in as a specific role
