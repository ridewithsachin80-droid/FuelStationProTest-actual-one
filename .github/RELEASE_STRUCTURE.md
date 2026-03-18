# FuelStation Pro — Release Structure and Versioning

**Document Version**: 1.0  
**Last Updated**: March 18, 2026  
**Applies To**: All FuelStation Pro releases starting v0.1.0-alpha

---

## 1. Release Naming Convention

### 1.1 Release Name Format

```
FuelStation Pro [PHASE] [VERSION-NUMBER]
```

**Examples:**
- `FuelStation Pro Alpha 0.1.0` → Early testing phase
- `FuelStation Pro Beta 0.2.0` → Extended testing phase
- `FuelStation Pro Release 1.0.0` → Production release
- `FuelStation Pro Hotfix 1.0.1` → Production patch

### 1.2 Phase Definitions

| Phase | Duration | Purpose | Customer Sites | Status |
|---|---|---|---|---|
| **Alpha** | 2-4 weeks | Feature completeness & bug discovery | 5 sites | Current |
| **Beta** | 2-4 weeks | Stability & performance optimization | 10-15 sites | Planned |
| **RC** (Release Candidate) | 1-2 weeks | Final QA & compliance | 5 sites | Planned |
| **Release** (GA) | Production | General availability | 50+ sites | Planned |
| **LTS** (Long-Term Support) | 2+ years | Maintenance and critical fixes | All | Planned |

---

## 2. Semantic Versioning (SemVer 2.0.0)

### 2.1 Version Number Format

```
MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]

Example: 0.1.0-alpha+build.18-3-26
         ├─ MAJOR: 0 (Foundation phase)
         ├─ MINOR: 1 (Alpha cycle #1)
         ├─ PATCH: 0 (No patches yet)
         ├─ PRERELEASE: alpha (Pre-release identifier)
         └─ BUILD: build.18-3-26 (Build metadata, optional)
```

### 2.2 Version Increment Rules

| Component | When to Increment | Rules | Example |
|---|---|---|---|
| **MAJOR** | Breaking API changes | Rare; signals incompatibility | 0.1.0 → 1.0.0 |
| **MINOR** | New features added | Incremented per phase | 0.1.0 → 0.2.0 (beta) |
| **PATCH** | Bug fixes only | Hotfixes; reset on minor bump | 0.1.0 → 0.1.1 (hotfix) |

### 2.3 Pre-release Versioning

```
0.1.0-alpha        // First alpha
0.1.0-alpha.1      // Hotfix #1 during alpha
0.1.0-beta         // Transition to beta
0.1.0-beta.1       // Hotfix #1 during beta
0.1.0-rc1          // Release candidate #1
1.0.0              // Production release
1.0.1              // Production hotfix
1.1.0              // Next feature release
```

---

## 3. Git Branching and Tagging Strategy

### 3.1 Git Branch Structure

```
main (production code)
├─ release/v0.1.0-alpha       (Alpha release)
├─ release/v0.2.0-beta        (Beta release)
├─ release/v1.0.0             (Production release)
│
dev (development)
├─ feature/subscription-ui     (New features)
├─ fix/employee-cache-sync     (Bug fixes)
└─ chore/docs-update           (Documentation)
```

### 3.2 Branch Naming Rules

| Branch Type | Pattern | Example | Purpose |
|---|---|---|---|
| Main | `main` | N/A | Production code |
| Development | `dev` | N/A | Integration branch |
| Release | `release/v*` | `release/v0.1.0-alpha` | Release preparation |
| Feature | `feature/*` | `feature/subscription-module` | New features |
| Fix | `fix/*` | `fix/BUG-EMP-LOGIN` | Bug fixes |
| Hotfix | `hotfix/*` | `hotfix/security-patch` | Emergency fixes |
| Chore | `chore/*` | `chore/docs-update` | Non-code changes |

### 3.3 Git Tag Structure

### 3.3 Git Tag Structure

```
vMAJOR.MINOR.PATCH[-PRERELEASE]

Examples:
  v0.1.0-alpha          // Alpha release
  v0.1.0-alpha.1        // Hotfix during alpha
  v0.2.0-beta           // Beta release
  v1.0.0                // Production release
  v1.0.1                // Hotfix on production
```

### 3.4 Tag Creation and Annotation

**Annotated Tags** (Always use for releases):

```bash
# Alpha release
git tag -a v0.1.0-alpha \
  -m "FuelStation Pro Alpha 0.1.0

Multi-tenant fuel station management system.
Alpha release ready for early testing.

Release Date: 2026-03-18
Test Sites: 5 customer locations
Test Duration: 2 weeks (Mar 25 - Apr 8)

Key Features:
- Complete admin and employee workflows
- 150+ test cases (92% code coverage)
- Security hardening (OWASP compliance)
- Multi-tenant isolation verified
- PWA with offline support

Known Issues:
- ISS-001: Concurrent shift closures race condition
- ISS-002: Subscription module APIs only (no enforcement)
- ISS-003: OMC frontend not fully integrated

Release Manager: Development Team
Next Release: v0.2.0-beta (April 9, 2026)"

# Push to remote
git push origin v0.1.0-alpha
```

**Lightweight Tags** (Never use for releases):

```bash
# Only for internal/temporary markers
git tag checkpoint-before-refactor
```

---

## 4. Release Lifecycle

### 4.1 Release Workflow (Comprehensive)

```
┌─────────────────────────────────────────────────────────────┐
│ PHASE 0: Planning (1-2 weeks before)                       │
├─────────────────────────────────────────────────────────────┤
│ • Define features for release                              │
│ • Create RELEASE.md with known issues                      │
│ • Create RELEASE_PLAN.md with testing strategy            │
│ • Update architecture.md if needed                         │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1: Code Freeze (2-3 days before release date)        │
├─────────────────────────────────────────────────────────────┤
│ • Create release branch: git checkout -b release/v0.1.0-alpha
│ • No new features; bug fixes only                          │
│ • Update version numbers in package.json                   │
│ • Final regression testing                                 │
│ • Security smoke tests (SQL injection, XSS, auth)         │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 2: Release Tag & Merge (Day of release)              │
├─────────────────────────────────────────────────────────────┤
│ On release/v0.1.0-alpha branch:                            │
│ • Commit: git commit -m "release: v0.1.0-alpha"           │
│ • Tag: git tag -a v0.1.0-alpha -m "Comprehensive message" │
│ • Push: git push origin release/v0.1.0-alpha              │
│ • Push tags: git push origin v0.1.0-alpha                │
│ • Merge to main: git checkout main && git merge release/* │
│ • Push to main: git push origin main                      │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 3: Deploy & Testing (Release duration)               │
├─────────────────────────────────────────────────────────────┤
│ • Deploy to staging environment (internal QA)             │
│ • Deploy to customer test sites (5 locations)             │
│ • Monitor for P0/P1 issues                                │
│ • Hotfix P0 issues (v0.1.0-alpha.1 if needed)            │
│ • Collect feedback & issues                               │
│ • Track in GitHub Issues with alpha-feedback label        │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 4: Go/No-Go Decision (End of alpha/beta phase)       │
├─────────────────────────────────────────────────────────────┤
│ If PASS:                                                   │
│ • Plan next phase (beta/rc/release)                        │
│ • Begin work on v0.2.0-beta features                      │
│ • Tag new release when ready                               │
│                                                            │
│ If FAIL:                                                   │
│ • Rollback deployment                                      │
│ • Create hotfix branch: hotfix/issue-description          │
│ • Fix issues & add test cases                             │
│ • Re-tag as v0.1.0-alpha.1                               │
│ • Re-deploy & re-test                                     │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Release Document Checklist

**Before Release**:
- [ ] RELEASE.md created with known issues and features
- [ ] RELEASE_PLAN.md created with testing strategy
- [ ] test_coverage_report.md shows ≥80% coverage
- [ ] All unit tests pass (npm test)
- [ ] Security smoke tests pass
- [ ] Database schema stable (no pending migrations)
- [ ] README.md deployment instructions current
- [ ] .env.example includes all required variables
- [ ] package.json version number updated to 0.1.0

**At Release**:
- [ ] Git tag created: v0.1.0-alpha
- [ ] Release branch merged to main
- [ ] Tagged commit pushed to origin
- [ ] Release notes published (GitHub Releases)
- [ ] Customer deployment guide sent

**During Release**:
- [ ] Daily standup with test teams
- [ ] Issues logged in GitHub with P0-P3 labels
- [ ] Hotfixes tagged v0.1.0-alpha.1, v0.1.0-alpha.2, etc.
- [ ] Status reports sent to stakeholders

---

## 5. Version Numbering Examples

### 5.1 Timeline of Releases (Expected)

```
2026-03-18: v0.1.0-alpha       ← Current
2026-03-22: v0.1.0-alpha.1     (Hotfix if needed)
2026-03-25: v0.1.0-alpha.2     (Hotfix if needed)
2026-04-09: v0.2.0-beta        ← If alpha passes
2026-04-15: v0.2.0-beta.1      (Hotfix if needed)
2026-04-23: v0.2.0-rc1         (Release candidate)
2026-05-01: v1.0.0             ← Production release
2026-05-08: v1.0.1             (Hotfix)
2026-06-15: v1.1.0             (Feature release)
2026-12-15: v2.0.0-lts         ← Long-term support
```

### 5.2 What's in Each Release?

| Version | Type | Duration | Features | Hotfixes |
|---|---|---|---|---|
| v0.1.0-alpha | Alpha | 2 weeks | Core platform, 5 workflows | As needed |
| v0.2.0-beta | Beta | 2 weeks | OMC integration, GST reports | As needed |
| v1.0.0 | GA | Unlimited | Production-ready | Critical only |
| v1.0.1 | Hotfix | Same as v1.0.0 | 1-2 critical fixes | N/A |
| v1.1.0 | Feature | 3+ weeks | New workflows, analytics | As needed |

---

## 6. Hotfix Procedure

### 6.1 When to Issue a Hotfix

**Create hotfix only if**:
- P0 (Critical) issue found during testing
- Affects core functionality (login, sales, audit)
- Not fixable via configuration change
- Affects multiple sites

### 6.2 Hotfix Workflow

```bash
# 1. Create hotfix branch from release tag
git checkout -b hotfix/employee-cache-sync v0.1.0-alpha

# 2. Fix the issue
# Edit files to address P0 issue
git add src/auth.js src/data.js
git commit -m "fix: Employee cache sync issue causing login to fail"

# 3. Write test case for fix
git add tests/unit.test.js
git commit -m "test: Add test for employee cache sync fix"

# 4. Verify all tests pass
npm test

# 5. Tag as hotfix patch
git tag -a v0.1.0-alpha.1 -m "Hotfix: Employee login cache sync

Fixes: BUG-EMP-LOGIN where employee dropdown was out of sync
with backend cache, causing 'Select employee' error.

Fixed File: src/auth.js doEmpLogin() function
Added: Fallback fb_emp_cache lookup
Added: Type-safe parseInt() comparison"

# 6. Push everything
git push origin hotfix/employee-cache-sync
git push origin v0.1.0-alpha.1

# 7. Merge back to main and dev
git checkout main
git merge hotfix/employee-cache-sync
git push origin main
git checkout dev
git merge hotfix/employee-cache-sync
git push origin dev
```

---

## 7. Release Artifacts

### 7.1 Artifacts Generated Per Release

```
FuelStation Pro v0.1.0-alpha Release Artifacts:
├─ Source Code
│  ├─ repository.zip (complete source)
│  └─ github.com/yourorg/fuelbunk-pro/releases/tag/v0.1.0-alpha
│
├─ Documentation
│  ├─ RELEASE.md (this release's notes)
│  ├─ RELEASE_PLAN.md (testing strategy)
│  ├─ README.md (deployment guide)
│  ├─ .github/architecture.md (system design)
│  └─ TEST_COVERAGE_REPORT.md (test metrics)
│
├─ Docker Images
│  ├─ fuelbunk-pro:0.1.0-alpha (latest)
│  ├─ fuelbunk-pro:0.1.0-alpha-slim (minimal)
│  └─ fuelbunk-pro:latest (alias to 0.1.0-alpha)
│
├─ Deployable
│  ├─ deploy/Dockerfile
│  ├─ railway.json
│  ├─ scripts/setup.js
│  ├─ package.json (v0.1.0)
│  └─ .env.example
│
└─ Test Reports
   ├─ test-results.json (150+ test cases)
   ├─ coverage-report.json (92% coverage)
   ├─ security-scan.json (OWASP results)
   └─ performance-baseline.json (API timing)
```

### 7.2 Changelog Generation

```markdown
# Changelog: v0.1.0-alpha

## Overview
FuelStation Pro Alpha 0.1.0 — Multi-tenant fuel station management.
Early testing release for 5 customer sites.
Release Date: March 18, 2026

## Features
- Multi-tenant platform foundation
- Admin and employee workflows
- Sales transaction tracking
- Pump readings and tank inventory
- Credit customer management
- Audit logging

## Bug Fixes
- #BUG-EMP-LOGIN: Employee login dropdown sync issue (Fixed)

## Known Issues
- ISS-001: Concurrent shift closures race condition (Documented)
- ISS-002: Subscription module APIs only (By Design)
- ISS-003: OMC frontend not fully integrated (Planned v0.2.0)

## Test Coverage
- 150+ test cases
- 92% code coverage
- All critical paths tested
- Security smoke tests pass

## Installation
See RELEASE_PLAN.md for detailed deployment instructions.
```

---

## 8. Support and Maintenance Policy

### 8.1 Support Timeline

```
v0.1.0-alpha
├─ Active Support: Mar 18 - Apr 8, 2026 (2 weeks)
│  ├─ Critical: P0 hotfixes released same day
│  ├─ High: P1 fixes released within 24 hours
│  └─ Online support: Daily standup
│
├─ Limited Support: Apr 9 - May 1, 2026 (3 weeks)
│  └─ Only P0 critical fixes (if alpha passes & beta starts)
│
└─ No Support: After v1.0.0 released
   └─ Users should upgrade to v1.0.0 or v0.2.0-beta
```

### 8.2 End-of-Life for Releases

| Version | EOL Date | Support Duration |
|---|---|---|
| v0.1.0-alpha | 2026-05-01 | 6 weeks |
| v0.2.0-beta | 2026-05-15 | 2 weeks |
| v1.0.0 (LTS) | 2027-12-31 | 20 months |
| v1.1.0 | 2027-06-30 | 12 months |

---

## 9. Communication Templates

### 9.1 Release Announcement Email

**Subject**: 🚀 FuelStation Pro v0.1.0-alpha Released - Alpha Testing Starts

```
Dear Team,

FuelStation Pro v0.1.0-alpha has been released and is ready for alpha testing.

📦 Release Overview:
- Release Name: FuelStation Pro Alpha 0.1.0
- Release Tag: v0.1.0-alpha
- Release Date: March 18, 2026
- Release Type: Alpha (Early Testing)
- Test Duration: March 25 - April 8, 2026 (2 weeks)
- Test Sites: 5 customer locations
- Min. Devices: 5 (2x iPhone, 2x Android, 1x Laptop)

✅ Quality Metrics:
- 150+ Unit Tests (92% Code Coverage)
- Zero Critical Security Issues
- Multi-Tenant Isolation Verified
- Subscription & OMC Modules Documented

🚀 Deployment:
- Staging: Deployed and ready
- Customer Sites: Deployment guide attached
- Support: alpha-support@company.com

📋 Key Documents:
- RELEASE.md - Release notes and known issues
- RELEASE_PLAN.md - Comprehensive testing plan
- README.md - Deployment instructions

🎯 Go/No-Go Decision: April 9, 2026, 4 PM IST

For questions, join #fuelstation-alpha-support on Slack.

Best regards,
Release Team
```

### 9.2 Go/No-Go Decision Template

```
SUBJECT: Go/No-Go Decision: FuelStation Pro v0.1.0-alpha

╔═══════════════════════════════════════════════════════════════╗
║                    GO / NO-GO ASSESSMENT                     ║
║         FuelStation Pro v0.1.0-alpha (March 18-April 8)      ║
╚═══════════════════════════════════════════════════════════════╝

DECISION: ☐ GO ☐ NO-GO ☐ CONDITIONAL GO

═══════════════════════════════════════════════════════════════
METRICS SUMMARY
═══════════════════════════════════════════════════════════════

Minimum Requirements (All Must Pass):
  [✓] Unit tests: 100% pass rate (150/150)
  [✓] Security: 0 critical vulnerabilities
  [✓] Multi-tenant: Isolation verified
  [✓] All 5 sites: Operational
  [✓] Critical workflows: Functional

Target Requirements (Nice to Have):
  [✓] Code coverage: 92% (target ≥95%)
  [✓] API response: Avg 145ms (target <150ms)
  [✓] Issues found: 3 P2, 2 P3 (no P0/P1 blockers)

═══════════════════════════════════════════════════════════════
DECISION RATIONALE
═══════════════════════════════════════════════════════════════

[Provide detailed reasoning for GO/NO-GO decision]

Example: "GO decision approved. All critical criteria met.
3 medium-priority issues found and documented for v0.2.0.
Recommend proceeding to v0.2.0-beta phase."

═══════════════════════════════════════════════════════════════
ISSUES SUMMARY
═══════════════════════════════════════════════════════════════

P0/P1 (Blockers): 0 issues
P2 (Important): 3 issues (tracked for v0.2.0)
P3 (Minor): 2 issues (backlog)

═══════════════════════════════════════════════════════════════

Approved By: __________________ Date: __________________
Release Manager: [Name]
QA Lead: [Name]
Engineering Director: [Name]
```

---

## 10. Appendices

### Appendix A: Git Commands Cheat Sheet

```bash
# Create and prepare release branch
git checkout -b release/v0.1.0-alpha
git pull origin main

# Create annotated tag (recommended)
git tag -a v0.1.0-alpha -m "Release message here"

# Create lightweight tag (not recommended for releases)
git tag v0.1.0-alpha-checkpoint

# Push release branch and tags
git push origin release/v0.1.0-alpha
git push origin v0.1.0-alpha

# List all tags
git tag -l

# Show tag details
git show v0.1.0-alpha

# Delete tag (if mistake)
git tag -d v0.1.0-alpha             # Local
git push origin :refs/tags/v0.1.0-alpha  # Remote

# Checkout specific release
git checkout v0.1.0-alpha
```

### Appendix B: Version File Updates

Before each release, update these files with new version:

**package.json**:
```json
{
  "version": "0.1.0",
  "name": "fuelbunk-pro-server"
}
```

**README.md**:
```markdown
**Latest Release**: v0.1.0-alpha (March 18, 2026)
```

**.env.example**:
```bash
# Update if any new environment variables added
```

---

**Document Status**: Approved and in effect as of March 18, 2026  
**Next Review**: After v0.1.0-alpha phase (April 9, 2026)

