# FuelBunk Pro — Deployment Guide

## Quick Start (Railway — recommended)

1. Push this repo to GitHub
2. Create new project in [Railway](https://railway.app) → Deploy from GitHub repo
3. Add a PostgreSQL plugin to your Railway project
4. Set the environment variables below in Railway → Variables tab
5. Railway auto-detects `deploy/Dockerfile` via `railway.json` — no extra config needed
6. First deploy runs `npm run prestart` (setup.js) then `node src/server.js`

**Required env vars on Railway:**
```
RP_ID                  = your-railway-domain.up.railway.app
RP_ORIGIN              = https://your-railway-domain.up.railway.app
SUPER_ADMIN_USERNAME   = superadmin
SUPER_ADMIN_INIT_PASS  = YourStrongPassword123!
NODE_ENV               = production
COMPANY_NAME           = Your Company Name
```
Railway injects `DATABASE_URL`, `PORT` automatically from the PostgreSQL plugin.

---

## Docker (self-hosted / VPS)

```bash
# Build
docker build -f deploy/Dockerfile -t fuelbunk-pro .

# Run
docker run -d \
  -p 3000:3000 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/db" \
  -e RP_ID="yourdomain.com" \
  -e RP_ORIGIN="https://yourdomain.com" \
  -e SUPER_ADMIN_USERNAME="superadmin" \
  -e SUPER_ADMIN_INIT_PASS="YourStrongPassword123!" \
  -e NODE_ENV="production" \
  -e COMPANY_NAME="Your Company" \
  --name fuelbunk-pro \
  fuelbunk-pro
```

Put Nginx or Caddy in front for HTTPS (required for WebAuthn/biometric).

---

## Local Development

```bash
cp .env.example .env
# Edit .env with your local PostgreSQL creds and domain

npm install
npm run setup       # downloads Chart.js
npm run dev         # node --watch src/server.js
```

---

## ⚠️  Biometric (WebAuthn) — Critical Setup

Biometric login **will silently fail** if `RP_ID` and `RP_ORIGIN` don't exactly match
the domain users access the app from.

| Setting | Example | Rule |
|---------|---------|------|
| `RP_ID` | `myapp.up.railway.app` | No `https://`, no port, no path |
| `RP_ORIGIN` | `https://myapp.up.railway.app` | Full origin, no trailing slash |

For **localhost development**, use:
```
RP_ID=localhost
RP_ORIGIN=http://localhost:3000
```

---

## Database

The app uses PostgreSQL (pg). Schema is auto-created on first start via `src/schema.js`.
No migrations to run manually.

**Minimum PostgreSQL version:** 13

---

## First Login

After deploy, visit `https://yourdomain.com` and log in with:
- Username: value of `SUPER_ADMIN_USERNAME` (default: `superadmin`)
- Password: value of `SUPER_ADMIN_INIT_PASS`

Change the password immediately after first login.

---

## Health Check

`GET /api/health` — returns `200 OK` with server status. Used by Railway and Docker HEALTHCHECK.

## Environment Variables Reference

See `.env.example` for the full list with descriptions.
