---
name: release-readiness
description: 'Use when preparing FuelStation Pro for release, hotfix, or deployment. Covers baseline tests, impact review, migration safety, and post-change verification.'
argument-hint: 'Describe the release scope, impacted modules, and risk areas.'
user-invocable: true
---

# Release Readiness Workflow

## When to Use
- Before merging feature branches to main
- Before production deploys or hotfix deploys
- After changes to auth, security, sales, credit, shifts, or schema

## Procedure
1. Capture baseline test state with npm test.
2. Review changed files for tenant_id safety and SQL parameterization.
3. Validate write paths for transaction safety and idempotency where applicable.
4. Verify schema updates are additive and in src/schema.js migration block.
5. Re-run npm test and compare with baseline.
6. Summarize risk, blast radius, and rollback approach.

## Required Checks
- Tenant isolation preserved
- Authentication and authorization behavior preserved
- No API contract regression for frontend clients
- No reduction in test pass status

## Output Checklist
- Scope summary
- Baseline test result
- Post-change test result
- Risk notes
- Rollback notes
