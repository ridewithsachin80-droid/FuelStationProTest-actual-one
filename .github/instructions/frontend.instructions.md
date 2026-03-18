---
description: "Use when editing PWA frontend modules under src/public, including employee portal, admin dashboard, API bridge, and offline behavior."
name: "FuelStation Frontend Conventions"
applyTo: "src/public/**/*.js"
---
# Frontend Conventions

- Keep employee and admin workflows data-driven from backend where available.
- Avoid hardcoded staff, pumps, or station business data.
- Preserve both desktop and mobile behavior in each change.
- Keep login/session flows resilient to refresh, temporary offline, and API retry scenarios.
- Do not expose sensitive data in public endpoints or local caches unnecessarily.
- For PIN/auth flows, prefer server-side verification and keep client fallbacks backward compatible.
- Reuse existing helper functions before adding new global utilities.
- Keep DOM updates safe (sanitize user-visible strings where applicable).
