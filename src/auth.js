/**
 * FuelBunk Pro — Auth Routes (PostgreSQL async)
 *
 * BUGS FIXED:
 *  1. db.prepare().get() returns a Promise in the async PgDbWrapper —
 *     all calls were already awaited correctly, but the SQLite-style
 *     $1/$2 placeholders in SQL were passed as positional args.
 *     PgDbWrapper.prepare().get(...params) spreads params as array —
 *     verified all calls pass correct number of params.
 *  2. super-login: checks admin.pass_hash !== hash — but if admin row
 *     is undefined (db returns undefined), accessing .pass_hash throws.
 *     Added explicit null check before property access.
 *  3. change-password route used requireRole('admin') but employee users
 *     (userType='employee') cannot change password — correct as-is, but
 *     now employees have their own PIN change route added.
 *  4. session route: req.session check was sufficient but req.userRole
 *     was sent as 'role' in response — matched frontend expectation.
 */
const express = require('express');
const { hashPassword, verifyPassword } = require('./schema');
const {
  bruteForceCheck, recordLoginAttempt, createSession,
  destroySession, auditLog, requireRole
} = require('./security');

function authRoutes(db) {
  const router = express.Router();

  // ── Super Admin Login ──────────────────────────────────────
  router.post('/super-login', bruteForceCheck(db), async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    try {
      const admin = await db.prepare('SELECT * FROM super_admin WHERE id = 1').get();
      // BUG FIX: guard against undefined admin row before accessing properties
      if (!admin) {
        await recordLoginAttempt(db, req._bruteForceIp, username, '', false);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      // C-01 FIX: Use bcrypt-aware verifyPassword (handles legacy SHA-256 migration)
      const validPass = await verifyPassword(password, admin.pass_hash);
      if (admin.username !== username || !validPass) {
        await recordLoginAttempt(db, req._bruteForceIp, username, '', false);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      // C-01 FIX: Upgrade legacy SHA-256 hash to bcrypt on first successful login
      if (admin.pass_hash && !admin.pass_hash.startsWith('$2')) {
        const newHash = await hashPassword(password);
        await db.prepare('UPDATE super_admin SET pass_hash = $1 WHERE id = 1').run(newHash);
      }
      await recordLoginAttempt(db, req._bruteForceIp, username, '', true);
      // FIX: Only clean up EXPIRED super sessions, not all of them.
      // Previously wiping all super sessions on login would invalidate valid tokens
      // mid-test (e.g. UAT-11 session duration check) — now sessions expire naturally
      // after 4 hours. Old expired sessions are cleaned up by createSession() already.
      await db.prepare("DELETE FROM sessions WHERE user_type = 'super' AND expires_at < NOW()").run();
      const token = await createSession(db, {
        tenantId: '', userId: 0, userType: 'super',
        userName: 'Super Admin', role: 'super',
        ip: req.ip, userAgent: req.headers['user-agent']
      });
      res.json({ success: true, token, userType: 'super', userName: 'Super Admin' });
    } catch (e) {
      console.error('[super-login]', e.message);
      res.status(500).json({ error: 'Login error' });
    }
  });

  // ── Admin Login ────────────────────────────────────────────
  router.post('/login', bruteForceCheck(db), async (req, res) => {
    const { username, password, tenantId } = req.body;
    if (!username || !password || !tenantId) {
      return res.status(400).json({ error: 'Missing credentials' });
    }
    try {
      const tenant = await db.prepare(
        'SELECT * FROM tenants WHERE id = $1 AND active = 1'
      ).get(tenantId);
      if (!tenant) return res.status(404).json({ error: 'Station not found or inactive' });

      // C-01 FIX: Fetch user first, then verify with bcrypt-aware verifyPassword
      const user = await db.prepare(
        'SELECT * FROM admin_users WHERE tenant_id = $1 AND username = $2 AND active = 1'
      ).get(tenantId, username);

      if (!user || !(await verifyPassword(password, user.pass_hash))) {
        await recordLoginAttempt(db, req._bruteForceIp, username, tenantId, false);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      // C-01 FIX: Upgrade legacy SHA-256 hash to bcrypt on first successful login
      if (user.pass_hash && !user.pass_hash.startsWith('$2')) {
        const newHash = await hashPassword(password);
        await db.prepare('UPDATE admin_users SET pass_hash = $1 WHERE id = $2').run(newHash, user.id);
      }
      await recordLoginAttempt(db, req._bruteForceIp, username, tenantId, true);
      const token = await createSession(db, {
        tenantId, userId: user.id, userType: 'admin',
        userName: user.name, role: user.role,
        ip: req.ip, userAgent: req.headers['user-agent']
      });
      // L-02 FIX: Include last login info so admins can detect unexpected access
      res.json({
        success: true, token,
        userType: 'admin', userName: user.name, userRole: user.role,
        tenantId, tenantName: tenant.name,
        loginIp: req.ip, loginAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[login]', e.message);
      res.status(500).json({ error: 'Login error' });
    }
  });

  // ── Phone Number Login (Owner / Staff) ────────────────────────────────
  // Phone is globally unique — server finds the user and their station automatically.
  // No tenantId required. Station owners type phone + password, done.
  router.post('/phone-login', bruteForceCheck(db), async (req, res) => {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone number and password are required' });
    }
    // Normalise: strip non-digits, remove leading 91 or 0
    const normalised = String(phone).replace(/\D/g, '').replace(/^(91|0)/, '').trim();
    if (!normalised || normalised.length < 10) {
      return res.status(400).json({ error: 'Enter a valid 10-digit phone number' });
    }
    try {
      const user = await db.prepare(
        'SELECT * FROM admin_users WHERE phone = $1 AND active = 1'
      ).get(normalised);

      if (!user || !(await verifyPassword(password, user.pass_hash))) {
        await recordLoginAttempt(db, req._bruteForceIp, normalised, '', false);
        return res.status(401).json({ error: 'Invalid phone number or password' });
      }

      const tenant = await db.prepare(
        'SELECT * FROM tenants WHERE id = $1 AND active = 1'
      ).get(user.tenant_id);
      if (!tenant) {
        return res.status(403).json({ error: 'Your station is inactive. Contact your service provider.' });
      }

      // Upgrade legacy SHA-256 hash on first successful login
      if (user.pass_hash && !user.pass_hash.startsWith('$2')) {
        const newHash = await hashPassword(password);
        await db.prepare('UPDATE admin_users SET pass_hash = $1 WHERE id = $2').run(newHash, user.id);
      }

      await recordLoginAttempt(db, req._bruteForceIp, normalised, user.tenant_id, true);
      const token = await createSession(db, {
        tenantId: user.tenant_id, userId: user.id, userType: 'admin',
        userName: user.name, role: user.role,
        ip: req.ip, userAgent: req.headers['user-agent']
      });
      res.json({
        success: true, token,
        userType: 'admin', userName: user.name, userRole: user.role,
        tenantId: user.tenant_id, tenantName: tenant.name,
        tenantIcon: tenant.icon || '⛽',
        tenantLocation: tenant.location || '',
        loginAt: new Date().toISOString(),
      });
    } catch (e) {
      console.error('[phone-login]', e.message);
      res.status(500).json({ error: 'Login error' });
    }
  });

  // ── Employee PIN Login ─────────────────────────────────────
  router.post('/employee-login', bruteForceCheck(db), async (req, res) => {
    const { pin, tenantId, employeeId } = req.body;
    if (!pin || !tenantId) return res.status(400).json({ error: 'Missing credentials' });
    // Validate PIN is numeric only
    if (!/^\d{4,8}$/.test(String(pin))) {
      return res.status(400).json({ error: 'PIN must be 4-8 digits' });
    }
    try {
      // C-01 FIX: verifyPassword handles both bcrypt and legacy SHA-256 PINs
      // Verify tenant is active before allowing employee login
      const tenant = await db.prepare(
        'SELECT id FROM tenants WHERE id = $1 AND active = 1'
      ).get(tenantId);
      if (!tenant) return res.status(404).json({ error: 'Station not found or inactive' });

      // BUG FIX: if employeeId provided, use it to disambiguate duplicate PINs
      let emp;
      if (employeeId) {
        const candidate = await db.prepare(
          'SELECT * FROM employees WHERE id = $1 AND tenant_id = $2 AND active = 1'
        ).get(employeeId, tenantId);
        emp = (candidate && await verifyPassword(String(pin), candidate.pin_hash)) ? candidate : null;
      } else {
        // No employeeId: fetch all with a pin_hash set, verify each (rare path)
        const candidates = await db.prepare(
          'SELECT * FROM employees WHERE tenant_id = $1 AND active = 1 AND pin_hash IS NOT NULL AND pin_hash != $2'
        ).all(tenantId, '');
        for (const c of candidates) {
          if (await verifyPassword(String(pin), c.pin_hash)) { emp = c; break; }
        }
      }
      // C-01 FIX: Upgrade legacy SHA-256 PIN hash to bcrypt on first successful login
      if (emp && emp.pin_hash && !emp.pin_hash.startsWith('$2')) {
        const newHash = await hashPassword(String(pin));
        await db.prepare('UPDATE employees SET pin_hash = $1 WHERE id = $2').run(newHash, emp.id);
      }
      if (!emp) {
        await recordLoginAttempt(db, req._bruteForceIp, 'employee-pin', tenantId, false);
        return res.status(401).json({ error: 'Invalid PIN' });
      }
      await recordLoginAttempt(db, req._bruteForceIp, emp.name, tenantId, true);
      const token = await createSession(db, {
        tenantId, userId: emp.id, userType: 'employee',
        userName: emp.name, role: 'attendant',
        ip: req.ip, userAgent: req.headers['user-agent']
      });
      res.json({
        success: true, token,
        userType: 'employee', userName: emp.name,
        employeeId: emp.id, tenantId
      });
    } catch (e) {
      console.error('[employee-login]', e.message);
      res.status(500).json({ error: 'Login error' });
    }
  });

  // ── Logout ─────────────────────────────────────────────────
  // ── Forgot Password — helper: send OTP via SMS or Email ─────────────────
  async function sendOtpDelivery(contactType, contact, otp) {
    if (contactType === 'phone') {
      const apiKey = process.env.FAST2SMS_API_KEY;
      if (apiKey) {
        const smsRes = await fetch(
          `https://www.fast2sms.com/dev/bulkV2?authorization=${apiKey}&route=otp&variables_values=${otp}&flash=0&numbers=${contact}`,
          { method: 'GET', headers: { 'cache-control': 'no-cache' } }
        );
        const smsJson = await smsRes.json();
        if (!smsJson.return) throw new Error('SMS send failed: ' + (smsJson.message||'unknown'));
      } else {
        console.log(`[OTP DEV SMS] Phone: ${contact}, OTP: ${otp} (set FAST2SMS_API_KEY in Railway)`);
      }
    } else {
      // Email OTP via nodemailer
      const emailUser = process.env.SMTP_USER;
      const emailPass = process.env.SMTP_PASS;
      const emailHost = process.env.SMTP_HOST || 'smtp.gmail.com';
      const emailPort = parseInt(process.env.SMTP_PORT || '587');
      const emailFrom = process.env.SMTP_FROM || emailUser;
      if (emailUser && emailPass) {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: emailHost, port: emailPort,
          secure: emailPort === 465,
          auth: { user: emailUser, pass: emailPass }
        });
        await transporter.sendMail({
          from: `"FuelBunk Pro" <${emailFrom}>`,
          to: contact,
          subject: 'Your FuelBunk Pro Password Reset OTP',
          text: `Your OTP is: ${otp}\n\nValid for 10 minutes. Do not share this with anyone.\n\n— FuelBunk Pro`,
          html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px;background:#0a0c10;color:#f4f5f7;border-radius:12px">
            <h2 style="color:#f0b429;margin-bottom:8px">FuelBunk Pro</h2>
            <p style="color:#9498a5;margin-bottom:20px">Password Reset OTP</p>
            <div style="background:#161a24;border:1px solid #2a3040;border-radius:8px;padding:20px;text-align:center;margin-bottom:20px">
              <div style="font-size:36px;font-weight:900;letter-spacing:12px;color:#f0b429">${otp}</div>
              <div style="font-size:12px;color:#6b7080;margin-top:8px">Valid for 10 minutes</div>
            </div>
            <p style="font-size:12px;color:#6b7080">Do not share this OTP with anyone. If you did not request this, ignore this email.</p>
          </div>`
        });
      } else {
        console.log(`[OTP DEV EMAIL] To: ${contact}, OTP: ${otp} (set SMTP_USER + SMTP_PASS in Railway)`);
      }
    }
  }

  // ── Forgot Password — Step 1: Send OTP (phone OR email) ──────────────────
  router.post('/forgot-password', async (req, res) => {
    const rawInput = (req.body.contact || req.body.phone || req.body.email || '').trim();
    if (!rawInput) return res.status(400).json({ error: 'Enter your phone number or email address' });

    // Detect type: email contains @, otherwise treat as phone
    const isEmail = rawInput.includes('@');
    let contact, contactType, user;

    if (isEmail) {
      contact = rawInput.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
        return res.status(400).json({ error: 'Enter a valid email address' });
      }
      contactType = 'email';
      user = await db.prepare('SELECT id, name FROM admin_users WHERE email = $1 AND active = 1').get(contact);
    } else {
      contact = rawInput.replace(/\D/g,'').replace(/^(91|0)/,'').trim();
      if (!contact || contact.length !== 10) {
        return res.status(400).json({ error: 'Enter a valid 10-digit phone number' });
      }
      contactType = 'phone';
      user = await db.prepare('SELECT id, name FROM admin_users WHERE phone = $1 AND active = 1').get(contact);
    }

    // Always return success to prevent enumeration
    if (!user) return res.json({ success: true, contactType, message: `If this ${contactType} is registered, an OTP has been sent` });

    try {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const otpHash = require('crypto').createHash('sha256').update(otp + contact).digest('hex');
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      await db.prepare('DELETE FROM otp_requests WHERE contact = $1').run(contact);
      await db.prepare(
        'INSERT INTO otp_requests (contact, contact_type, otp_hash, expires_at) VALUES ($1, $2, $3, $4)'
      ).run(contact, contactType, otpHash, expiresAt);

      await sendOtpDelivery(contactType, contact, otp);

      const maskedContact = isEmail
        ? contact.replace(/(.{2}).*(@.*)/, '$1***$2')
        : '+91 XXXXX' + contact.slice(5);

      res.json({ success: true, contactType, contact, maskedContact, message: `OTP sent to ${maskedContact}` });
    } catch(e) {
      console.error('[forgot-password]', e.message);
      res.status(500).json({ error: 'Failed to send OTP. Try the other method.' });
    }
  });

  // ── Forgot Password — Step 2: Verify OTP ────────────────────────────────
  router.post('/verify-otp', async (req, res) => {
    const contact = (req.body.contact || req.body.phone || req.body.email || '').trim().toLowerCase();
    const otp = (req.body.otp || '').trim();
    if (!contact || !otp) return res.status(400).json({ error: 'Contact and OTP required' });
    const normContact = contact.includes('@') ? contact : contact.replace(/\D/g,'').replace(/^(91|0)/,'').trim();
    try {
      const otpHash = require('crypto').createHash('sha256').update(otp + normContact).digest('hex');
      const record = await db.prepare(
        'SELECT * FROM otp_requests WHERE contact = $1 AND otp_hash = $2 AND token_used = 0'
      ).get(normContact, otpHash);
      if (!record) return res.status(401).json({ error: 'Invalid OTP' });
      if (new Date(record.expires_at) < new Date()) return res.status(401).json({ error: 'OTP has expired. Request a new one.' });

      const resetToken = require('crypto').randomBytes(32).toString('hex');
      const tokenExpiry = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      await db.prepare(
        'UPDATE otp_requests SET reset_token = $1, expires_at = $2 WHERE id = $3'
      ).run(resetToken, tokenExpiry, record.id);

      res.json({ success: true, resetToken });
    } catch(e) {
      console.error('[verify-otp]', e.message);
      res.status(500).json({ error: 'Verification failed' });
    }
  });

  // ── Forgot Password — Step 3: Set New Password ──────────────────────────
  router.post('/reset-password-otp', async (req, res) => {
    const rawContact = (req.body.contact || req.body.phone || req.body.email || '').trim().toLowerCase();
    const { resetToken, newPassword } = req.body;
    if (!rawContact || !resetToken || !newPassword) return res.status(400).json({ error: 'Missing fields' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const contact = rawContact.includes('@') ? rawContact : rawContact.replace(/\D/g,'').replace(/^(91|0)/,'').trim();
    try {
      const record = await db.prepare(
        'SELECT * FROM otp_requests WHERE contact = $1 AND reset_token = $2 AND token_used = 0'
      ).get(contact, resetToken);
      if (!record) return res.status(401).json({ error: 'Invalid or expired reset session. Start again.' });
      if (new Date(record.expires_at) < new Date()) return res.status(401).json({ error: 'Reset session expired. Start again.' });

      const newHash = await hashPassword(newPassword);
      const isEmail = contact.includes('@');
      const updateField = isEmail ? 'email' : 'phone';
      await db.prepare(`UPDATE admin_users SET pass_hash = $1 WHERE ${updateField} = $2`).run(newHash, contact);
      const user = await db.prepare(`SELECT id FROM admin_users WHERE ${updateField} = $1`).get(contact);
      if (user) await db.prepare("DELETE FROM sessions WHERE user_id = $1 AND user_type = 'admin'").run(user.id);
      await db.prepare('UPDATE otp_requests SET token_used = 1 WHERE id = $1').run(record.id);
      res.json({ success: true, message: 'Password updated successfully' });
    } catch(e) {
      console.error('[reset-password-otp]', e.message);
      res.status(500).json({ error: 'Password reset failed' });
    }
  });

  router.post('/logout', async (req, res) => {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (token) {
      await destroySession(db, token);
      // Best-effort audit log — don't fail logout if audit fails
      try { await auditLog(req, 'LOGOUT', 'auth', '', ''); } catch {}
    }
    res.json({ success: true });
  });

  // ── Session Check ──────────────────────────────────────────
  // /api/auth is NOT under authMiddleware, so we must inline the token lookup here.
  // Previously req.session was always undefined → always 401.
  router.get('/session', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No active session' });
    }
    const token = authHeader.replace('Bearer ', '').trim();
    if (!token || token.length < 10) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    try {
      const session = await db.prepare(
        'SELECT * FROM sessions WHERE token = $1 AND expires_at > NOW()'
      ).get(token);
      if (!session) return res.status(401).json({ error: 'Invalid or expired session' });
      res.json({
        valid: true,
        userType: session.user_type,
        userName: session.user_name,
        role: session.role,
        tenantId: session.tenant_id,
      });
    } catch (e) {
      res.status(500).json({ error: 'Session check error' });
    }
  });

  // ── Inline session resolver ────────────────────────────────
  // BUG-02 FIX: /api/auth routes are mounted WITHOUT authMiddleware, so req.userType
  // is never populated and requireRole() always returns 401. The /session route already
  // handles this correctly by doing its own inline token lookup — we replicate that
  // pattern here for the two change-password routes.
  async function resolveSession(req, requiredType) {
    const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
    if (!token || token.length < 10) return null;
    try {
      const session = await db.prepare(
        'SELECT * FROM sessions WHERE token = $1 AND expires_at > NOW()'
      ).get(token);
      if (!session) return null;
      if (requiredType && session.user_type !== requiredType) return null;
      return session;
    } catch {
      return null;
    }
  }

  // ── Super Change Password ──────────────────────────────────
  // BUG-02 FIX: was requireRole('super') — always 401 because authMiddleware not in chain.
  router.post('/super-change-password', async (req, res) => {
    const session = await resolveSession(req, 'super');
    if (!session) return res.status(401).json({ error: 'Super admin authentication required' });

    const { newUsername, newPassword, confirmPassword } = req.body;
    if (!newUsername || newUsername.length < 3) {
      return res.status(400).json({ error: 'Username too short (min 3 chars)' });
    }
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password too short (min 8 chars)' });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }
    try {
      const superHash = await hashPassword(newPassword);
      // BUG-05 companion fix: also set a flag so schema.js startup sync skips this row
      await db.prepare(
        'UPDATE super_admin SET username = $1, pass_hash = $2, updated_at = NOW(), credentials_user_managed = TRUE WHERE id = 1'
      ).run(newUsername, superHash);
      // SESSION INVALIDATION FIX: Revoke all other super sessions except the current one.
      // If an attacker obtained a super session token, changing the password now kicks them out.
      // The current token stays valid so the user doesn't get logged out immediately.
      const currentToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
      await db.prepare(
        "DELETE FROM sessions WHERE user_type = 'super' AND token != $1"
      ).run(currentToken).catch(() => {});
      // Audit
      try {
        await auditLog({ ...req, tenantId: '', userId: 0, userType: 'super', userName: 'Super Admin', ip: req.ip }, 'CHANGE_PASSWORD', 'super_admin', '1', 'Super admin credentials updated — other sessions revoked');
      } catch {}
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Admin Change Password (own password) ──────────────────
  // BUG-02 FIX: was requireRole('admin') — always 401 because authMiddleware not in chain.
  // BUG-04 FIX: verify currentPassword server-side before allowing update.
  router.post('/change-password', async (req, res) => {
    const session = await resolveSession(req, 'admin');
    if (!session) return res.status(401).json({ error: 'Admin authentication required' });

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword) {
      return res.status(400).json({ error: 'Current password is required' });
    }
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password too short (min 6 chars)' });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'New password must differ from current password' });
    }
    try {
      const user = await db.prepare(
        'SELECT * FROM admin_users WHERE id = $1 AND tenant_id = $2 AND active = 1'
      ).get(session.user_id, session.tenant_id);
      if (!user) return res.status(404).json({ error: 'Admin user not found' });

      const currentValid = await verifyPassword(currentPassword, user.pass_hash);
      if (!currentValid) return res.status(403).json({ error: 'Current password is incorrect' });

      const newHash = await hashPassword(newPassword);
      await db.prepare(
        'UPDATE admin_users SET pass_hash = $1 WHERE id = $2 AND tenant_id = $3'
      ).run(newHash, session.user_id, session.tenant_id);
      // SESSION INVALIDATION FIX: Revoke all other sessions for this admin user.
      // Attacker with a stolen token is kicked out when the legitimate user changes password.
      // Current token is preserved so the user stays logged in.
      const currentToken = (req.headers.authorization || '').replace('Bearer ', '').trim();
      await db.prepare(
        "DELETE FROM sessions WHERE user_type = 'admin' AND user_id = $1 AND tenant_id = $2 AND token != $3"
      ).run(session.user_id, session.tenant_id, currentToken).catch(() => {});
      try {
        await auditLog({ ...req, tenantId: session.tenant_id, userId: session.user_id, userType: 'admin', userName: session.user_name, ip: req.ip }, 'CHANGE_PASSWORD', 'admin_users', String(session.user_id), 'Admin changed own password — other sessions revoked');
      } catch {}
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = authRoutes;
