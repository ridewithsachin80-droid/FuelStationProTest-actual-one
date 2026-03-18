---
description: "Use when writing or updating tests for FuelStation Pro backend and security behavior, including auth, validation, and API reliability checks."
name: "FuelStation Test Strategy"
applyTo: "tests/**/*.test.js"
---
# Test Strategy

- Prefer deterministic unit/integration-style tests with mocks over flaky environment-dependent tests.
- Cover both happy path and negative path for auth, role checks, validation, and lockout logic.
- Keep tests focused on behavior contracts, not implementation details.
- When fixing a bug, add a test that fails before the fix and passes after the fix.
- Keep test names descriptive and business-readable.
- Maintain fast local execution via npm test.
- If warnings are expected in tests, assert behavior instead of suppressing logs globally.
