# FuelStation Pro Requirements

## 1. Sources used
This requirements file is consolidated from:
- requirements-testscases.pdf (provided in workspace)
- Current codebase behavior in src/ and src/public/
- Existing schema and API behavior in src/schema.js, src/server.js, src/auth.js, src/data.js

Status legend:
- Implemented: available in current code and usable
- Partial: present but incomplete, limited, or not fully validated
- Planned: not implemented yet

## 2. User requirements

| ID | Requirement | Status | Notes |
|---|---|---|---|
| UR-01 | Employee should be able to input sale data | Implemented | Employee portal and public sales API exist. |
| UR-02 | Manager should see trends of sale per employee | Partial | Reporting exists, but requirement-level trend views need formal traceability. |
| UR-03 | Employee should take shift and work by shift | Partial | Shift entities and staff allocation exist; full attendance guardrails need stronger enforcement. |
| UR-19 | Roster allocation must only allow scheduling from current date onwards | Implemented | Roster tab blocks assignment/removal on past dates at UI and function level; past-day columns are read-only with visual dimming and guard checks use station-local current date. |
| UR-20 | In Staff & Allocation -> Roster, assign dropdown must show employees only for selected shift | Implemented | Dropdown now filters employees by shift mapping (including comma-separated shift assignments), excluding employees not configured for that shift. |
| UR-21 | In Staff & Allocation -> Allocation, older date allocations must not be editable | Implemented | Allocation tab blocks assignment/removal on past dates; past-day columns are read-only with visual dimming, disabled dropdowns, and empty handlers. Week navigation enforces current-date-onwards constraint. Uses IST-safe date handling for timezone-correct comparisons. |
| UR-04 | Employee enters sale data at end of shift | Implemented | Sales entry supports employee workflow. |
| UR-05 | Per day one employee should enter only once in sale collection system | Planned | No strict one-entry-per-employee-per-day constraint found. |
| UR-06 | Dashboard UI | Implemented | Dashboard is present in frontend flows. |
| UR-07 | Tanks and inventory UI | Implemented | Tanks/inventory workflows are present. |
| UR-08 | Pumps and opening/closing meter reading UI | Implemented | Pump and readings flows are present. |
| UR-09 | Sales log UI | Implemented | Sales pages and APIs exist. |
| UR-10 | UPI QR support for credit payments | Partial | Payment integrations exist but complete QR generation/verification flow needs explicit validation. |
| UR-11 | Username + role + PIN based login | Implemented | Admin and employee auth flows exist with role model and PIN login. |
| UR-12 | Mobile app support | Implemented | PWA (manifest + service worker) supports mobile usage. |
| UR-13 | Desktop dashboard support | Implemented | Admin dashboard is browser-based. |
| UR-14 | Capture employee login details in reporting | Partial | Session/login attempt tracking exists; report-level presentation needs explicit completion checks. |
| UR-15 | Employee shift report with monthly attendance details | Partial | Related data exists, but requirement-specific reporting output needs confirmation. |
| UR-16 | Credit limit validation during sales | Implemented | Server-side credit limit blocking is present in relevant flows. |
| UR-17 | Previous closing should carry forward as opening and prevent unsafe edits | Partial | Reading carry-forward logic exists, but strict immutability behavior needs full validation. |
| UR-18 | Display currently logged-in employees (live) | Partial | Session/live indicators exist in parts of UI; requirement is not fully standardized across views. |
| UR-19 | GSTR-1/Tally and GSTR-3B needs to be implemented | Partial | Implement both Tally xml and GSTR-3B XML workflow |
| UR-20 | Implement subscription & Billing functionality in Super user login | Partial | Implement subscription functionality for Monthly,quarterly,Half yearly,Yearly and Trial period with Payment record|


## 3. System requirements

| ID | Requirement | Status | Notes |
|---|---|---|---|
| SR-01 | Multi-tenant system with strict data separation | Implemented | tenant_id-based isolation is a core design rule. |
| SR-02 | Support 400+ concurrent add/view operations | Partial | Pool/rate-limit tuning exists; initial concurrent load script is present, but formal benchmark evidence is still pending. |
| SR-03 | Support around 100 bunks | Partial | Architecture is multi-tenant, but scale target is not benchmark-validated yet. |
| SR-04 | Support up to around 400 concurrent employee writes | Partial | Write-path protections exist, but benchmark and queue/retry strategy are incomplete. |
| SR-05 | Retry failed writes to eventual consistency | Partial | Idempotency exists on selected paths; generalized retry pipeline/queue not implemented. |
| SR-06 | UI should auto-populate fields where possible | Partial | Multiple auto-fill helpers exist, but full requirement coverage is not verified. |
| SR-07 | Daily backup and restore | Planned | No repository-level daily backup/restore automation found. |
| SR-08 | Cloud deployment support | Implemented | Railway-oriented configuration exists. |
| SR-09 | Secure API posture (rate limit, SQLi protection, auth controls) | Implemented | Parameterized queries, sanitization, auth middleware, brute-force and rate limiting present. |
| SR-10 | Security validation for DDoS/SQLi/API throttling | Partial | Code controls and unit tests exist; a basic concurrent sales load scaffold exists, but dedicated security/load toolchain and thresholds are not yet included in repo. |
| SR-11 | Idle session timeout and browser-close logout handling | Partial | Session expiry exists server-side; UX-specific idle timeout handling needs explicit requirement mapping. |
| SR-12 | Standardized error messaging | Partial | Many error messages are improved, but full normalization across all paths is incomplete. |

## 4. Requirements from review observations (backlog candidates)

From requirement review notes in the provided document, these remain key backlog candidates:
- Enforce one-login/one-entry daily constraints where business requires it.
- Complete and verify employee shift attendance report outputs.
- Strengthen geo-presence or station-bound checks for employee attendance/login misuse prevention.
- Complete UPI QR end-to-end verification flow traceability.
- Add robust backup/restore operations and runbook.
- Expand load tests into formal benchmark suites for concurrency targets (100 bunks, 400+ concurrent writes).
- Standardize and catalog all user-facing error messages.

## 5. Requirement-to-test traceability status

Current automated tests cover:
- Auth/session and role behavior
- Input validation and middleware safety
- Security helper behavior
- PIN verification compatibility path
- Core API health behavior
- Basic concurrent sales write load script (manual run)
- Roster date restriction: past-date guard logic in rosterAssign/rosterUnassign (tests/roster.test.js)
- Roster shift eligibility filtering for assign dropdown and function-level guard (tests/roster.test.js)

Traceability gaps to close:
- Requirement-level reporting outputs
- Full shift attendance scenarios (UR-03, UR-15)
- High-concurrency performance proof with repeatable thresholds
- Backup/restore verification

## 6. Recommended implementation order for open requirements

1. Backup and restore automation + restore drill.
2. Operationalize concurrency/load suite for target scale (benchmarks + CI thresholds).
3. Attendance/shift report completion and acceptance tests.
4. Unified error message contract and frontend mapping.
5. End-to-end UPI QR requirement validation and tests.
