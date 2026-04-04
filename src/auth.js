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
const { extractPublicKeyDER, verifyWebAuthnSignature } = require('./webauthn-crypto');
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
      const apiKey      = process.env.FAST2SMS_API_KEY;
      const dltSenderId = process.env.FAST2SMS_SENDER_ID;    // e.g. FBLPRO — set after DLT registration
      const dltTemplate = process.env.FAST2SMS_TEMPLATE_ID;  // DLT template ID from Fast2SMS portal

      if (apiKey) {
        let smsUrl;

        if (dltSenderId && dltTemplate) {
          // ── DLT SMS route ──────────────────────────────────────────────
          // Used AFTER DLT registration is complete on Fast2SMS portal.
          // Requires: FAST2SMS_SENDER_ID + FAST2SMS_TEMPLATE_ID in Railway.
          // DLT message format: "Your FuelBunk Pro OTP is {#var#}. Valid 10 mins."
          // variables_values fills the {#var#} placeholder with the actual OTP.
          smsUrl = `https://www.fast2sms.com/dev/bulkV2?authorization=${apiKey}&route=dlt&sender_id=${dltSenderId}&message=${dltTemplate}&variables_values=${otp}&flash=0&numbers=${contact}`;
          console.log(`[SMS] Using DLT route — sender: ${dltSenderId}, template: ${dltTemplate}`);
        } else {
          // ── OTP route (no DLT needed) ──────────────────────────────────
          // Works immediately after Fast2SMS signup. No sender ID or template needed.
          // Sends: "Your OTP is 123456" (Fast2SMS default OTP message).
          // Switch to DLT route by adding FAST2SMS_SENDER_ID + FAST2SMS_TEMPLATE_ID to Railway.
          smsUrl = `https://www.fast2sms.com/dev/bulkV2?authorization=${apiKey}&route=otp&variables_values=${otp}&flash=0&numbers=${contact}`;
          console.log(`[SMS] Using OTP route. Add FAST2SMS_SENDER_ID + FAST2SMS_TEMPLATE_ID to switch to DLT route.`);
        }

        // DLT route already has apiKey in query param above; OTP route also includes it in URL
        const smsController = new AbortController();
        const smsTimeout = setTimeout(() => smsController.abort(), 8000); // 8 second timeout
        const smsRes = await fetch(smsUrl, {
          method: 'GET',
          headers: { 'cache-control': 'no-cache' },
          signal: smsController.signal
        });
        clearTimeout(smsTimeout);
        const smsJson = await smsRes.json();
        // Always log the full Fast2SMS response to Railway console for debugging
        console.log(`[SMS] Fast2SMS response:`, JSON.stringify(smsJson));
        if (!smsJson.return) throw new Error('SMS send failed: ' + (smsJson.message || JSON.stringify(smsJson)));
        console.log(`[SMS] ✅ Sent to ${contact} — request_id: ${smsJson.request_id || 'n/a'}`);        
        // Also try WhatsApp delivery if configured (as backup/primary)
        const waKey = process.env.FAST2SMS_API_KEY;
        const waEnabled = process.env.FAST2SMS_WHATSAPP === 'true';
        if (waEnabled && waKey) {
          try {
            const waMsg = `Your FuelBunk Pro OTP is *${otp}*. Valid for 10 minutes.`;
            const waRes = await fetch(
              `https://www.fast2sms.com/dev/whatsapp?authorization=${waKey}&to=${contact}&type=text&body=${encodeURIComponent(waMsg)}`,
              { method: 'GET', headers: { 'cache-control': 'no-cache' } }
            );
            const waJson = await waRes.json();
            console.log(`[WhatsApp] Fast2SMS WA response:`, JSON.stringify(waJson));
          } catch(waErr) {
            console.log(`[WhatsApp] Delivery failed (non-fatal):`, waErr.message);
          }
        }
      } else {
        console.log(`[OTP DEV SMS] Phone: ${contact}, OTP: ${otp} (set FAST2SMS_API_KEY in Railway to enable SMS)`);
      }
    } else {
      // ── Email OTP ──────────────────────────────────────────────────────────
      // Uses Resend HTTP API (port 443 — works on Railway, unlike SMTP which is blocked)
      // Free tier: 100 emails/day at resend.com
      const resendKey   = process.env.RESEND_API_KEY;
      const brevoKey    = process.env.BREVO_API_KEY;
      const emailUser   = process.env.SMTP_USER;  // kept for display name only

      const emailSubject = 'Your FuelBunk Pro Password Reset OTP';
      const emailText    = `Your OTP is: ${otp}\n\nValid for 10 minutes.\nDo not share this with anyone.\n\n— FuelBunk Pro`;
      const emailHtml    = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0a0c10;color:#f4f5f7;border-radius:8px">
  <h2 style="color:#d4940f;margin-bottom:8px">FuelBunk Pro</h2>
  <p style="color:#9098a8;font-size:13px;margin-bottom:24px">Password Reset</p>
  <div style="background:#14161a;border:1px solid #252830;border-radius:6px;padding:24px;text-align:center;margin-bottom:24px">
    <p style="color:#9098a8;font-size:12px;margin-bottom:8px;letter-spacing:.1em;text-transform:uppercase">Your OTP</p>
    <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#f4f5f7">${otp}</div>
    <p style="color:#6b7080;font-size:11px;margin-top:12px">Valid for 10 minutes</p>
  </div>
  <p style="color:#6b7080;font-size:11px">Do not share this OTP with anyone. FuelBunk Pro will never ask for your OTP.</p>
</div>`;

      if (resendKey) {
        // ── Resend API (resend.com — free 100/day, uses HTTPS) ──────────────
        console.log(`[Email] Sending via Resend API to ${contact}`);
        const fromAddr = emailUser ? `FuelBunk Pro <${emailUser}>` : 'FuelBunk Pro <onboarding@resend.dev>';
        const resendRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: fromAddr,
            to: [contact],
            subject: emailSubject,
            html: emailHtml,
            text: emailText
          }),
          signal: AbortSignal.timeout(10000)
        });
        const resendJson = await resendRes.json();
        if (!resendRes.ok) throw new Error('Resend failed: ' + (resendJson.message || JSON.stringify(resendJson)));
        console.log(`[Email] ✅ Sent via Resend to ${contact} — id: ${resendJson.id}`);

      } else if (brevoKey) {
        // ── Brevo API (brevo.com — free 300/day, uses HTTPS) ────────────────
        console.log(`[Email] Sending via Brevo API to ${contact}`);
        const brevoRes = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'api-key': brevoKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            sender: { name: 'FuelBunk Pro', email: emailUser || 'noreply@fuelbunk.app' },
            to: [{ email: contact }],
            subject: emailSubject,
            htmlContent: emailHtml,
            textContent: emailText
          }),
          signal: AbortSignal.timeout(10000)
        });
        const brevoJson = await brevoRes.json();
        if (!brevoRes.ok) throw new Error('Brevo failed: ' + (brevoJson.message || JSON.stringify(brevoJson)));
        console.log(`[Email] ✅ Sent via Brevo to ${contact} — id: ${brevoJson.messageId}`);

      } else {
        // ── Dev mode: log OTP to Railway console ────────────────────────────
        console.log(`[OTP DEV EMAIL] To: ${contact}, OTP: ${otp} (set RESEND_API_KEY or BREVO_API_KEY in Railway to send real emails)`);
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

      let smsErr = null;
      try {
        await sendOtpDelivery(contactType, contact, otp);
      } catch(smsErr) {
        // Non-fatal: OTP already saved to DB. Log and continue — dev mode shows OTP in Railway console.
        console.error('[forgot-password] OTP delivery failed (non-fatal):', smsErr.message);
      }

      const maskedContact = isEmail
        ? contact.replace(/(.{2}).*(@.*)/, '$1***$2')
        : '+91 XXXXX' + contact.slice(5);

      res.json({ 
        success: true, 
        contactType, 
        contact, 
        maskedContact, 
        message: `OTP sent to ${maskedContact}`,
        note: 'If SMS not received in 30 seconds, check Railway logs or use email OTP'
      });
    } catch(e) {
      console.error('[forgot-password]', e.message);
      res.status(500).json({ error: 'OTP delivery failed. Please try with your email address instead.' });
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

  // ══════════════════════════════════════════════════════════════════
  // ── WebAuthn Biometric Authentication Routes ─────────────────────
  // Uses the Web Authentication API (WebAuthn) standard.
  // No external library needed — pure crypto via Node.js built-ins.
  // Flow:
  //   Registration: logged-in user → /webauthn/register-options → device
  //                 prompt → /webauthn/register → credential saved in DB
  //   Authentication: app open → /webauthn/auth-options → biometric
  //                   prompt → /webauthn/authenticate → new session token
  // ══════════════════════════════════════════════════════════════════

  const crypto = require('crypto');

  // ── FIX 2: Stable rpId & origin from environment variables ───────────────
  // CRITICAL: rpId MUST be identical between registration and authentication.
  // Using req.hostname was broken on mobile because Railway's proxy can return
  // a different hostname depending on the request path/headers. Set these env
  // vars in your Railway dashboard to match the domain users access the app on.
  //
  //   RP_ID     = yourdomain.com          (no https://, no port, no path)
  //   RP_ORIGIN = https://yourdomain.com  (full origin, no trailing slash)
  //
  // Defaults fall back to fuelbunk.app for backward compatibility.
  const RP_ID     = process.env.RP_ID     || 'fuelbunk.app';
  const RP_ORIGIN = process.env.RP_ORIGIN || 'https://fuelbunk.app';

  // ── FIX 5: DB-backed challenge store (replaces in-memory Map) ────────────
  // The in-memory Map was wiped on every server restart (Railway restarts on
  // every deploy and can sleep/wake). Challenges are now stored in the DB with
  // a 5-minute TTL so they survive restarts and work across multiple instances.
  //
  // Schema (auto-created on first use):
  //   webauthn_challenges(challenge TEXT PK, data JSONB, expires_at TIMESTAMPTZ)
  //
  async function _ensureChallengeTable() {
    try {
      await db.prepare(
        `CREATE TABLE IF NOT EXISTS webauthn_challenges (
           challenge  TEXT PRIMARY KEY,
           data       TEXT NOT NULL,
           expires_at BIGINT NOT NULL
         )`
      ).run();
    } catch (e) {
      console.warn('[webauthn] Could not create challenges table:', e.message);
    }
  }
  _ensureChallengeTable();

  async function _storeChallenge(challenge, data) {
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    try {
      await db.prepare(
        `INSERT INTO webauthn_challenges (challenge, data, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (challenge) DO UPDATE SET data = $2, expires_at = $3`
      ).run(challenge, JSON.stringify(data), expiresAt);
      // Opportunistic cleanup of stale rows (non-blocking)
      db.prepare('DELETE FROM webauthn_challenges WHERE expires_at < $1')
        .run(Date.now()).catch(() => {});
    } catch (e) {
      console.error('[webauthn] Failed to store challenge:', e.message);
    }
  }
  async function _getChallenge(challenge) {
    try {
      const row = await db.prepare(
        'SELECT data, expires_at FROM webauthn_challenges WHERE challenge = $1'
      ).get(challenge);
      if (!row || row.expires_at < Date.now()) return null;
      // One-time use — delete immediately
      await db.prepare('DELETE FROM webauthn_challenges WHERE challenge = $1').run(challenge);
      return JSON.parse(row.data);
    } catch (e) {
      console.error('[webauthn] Failed to get challenge:', e.message);
      return null;
    }
  }

  function _base64url(buf) {
    return Buffer.from(buf).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  function _fromBase64url(str) {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, 'base64');
  }

  // ── Step 1: Registration Options (called after successful password login) ──
  // Returns a challenge + rp info for navigator.credentials.create()
  router.post('/webauthn/register-options', async (req, res) => {
    const session = await resolveSession(req, 'admin');
    if (!session) return res.status(401).json({ error: 'Login required' });

    // BUG-11 FIX: Cap credentials per user at 5 to prevent table bloat
    const existingCount = await db.prepare(
      'SELECT COUNT(*) as cnt FROM webauthn_credentials WHERE user_id = $1 AND tenant_id = $2'
    ).get(session.user_id, session.tenant_id);
    if ((existingCount?.cnt || 0) >= 5) {
      return res.status(400).json({ error: 'Maximum of 5 devices already registered. Remove one before adding another.' });
    }

    const challenge = _base64url(crypto.randomBytes(32));
    _storeChallenge(challenge, {
      userId: session.user_id,
      tenantId: session.tenant_id,
      userType: 'admin',
      action: 'register'
    });

    const appId = RP_ID;
    res.json({
      challenge,
      rp: { name: 'UpScale Fuel', id: appId },
      user: {
        id: _base64url(Buffer.from(String(session.user_id))),
        name: session.user_name,
        displayName: session.user_name
      },
      pubKeyCredParams: [
        { alg: -7, type: 'public-key' },   // ES256 (most common — Android, iPhone)
        { alg: -257, type: 'public-key' }  // RS256 (Windows Hello fallback)
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform', // device biometric only (no USB keys)
        userVerification: 'required',        // PIN/fingerprint/face required
        requireResidentKey: false
      },
      timeout: 60000,
      attestation: 'none' // skip attestation — simplifies verification considerably
    });
  });

  // ── Step 2: Register — save credential after device biometric confirmed ──
  router.post('/webauthn/register', async (req, res) => {
    const session = await resolveSession(req, 'admin');
    if (!session) return res.status(401).json({ error: 'Login required' });

    const { id, rawId, response: credResponse, deviceName } = req.body;
    if (!id || !credResponse?.clientDataJSON || !credResponse?.attestationObject) {
      return res.status(400).json({ error: 'Invalid credential data' });
    }

    try {
      // Parse clientDataJSON to verify challenge and origin
      const clientData = JSON.parse(
        Buffer.from(_fromBase64url(credResponse.clientDataJSON)).toString('utf8')
      );
      if (clientData.type !== 'webauthn.create') {
        return res.status(400).json({ error: 'Invalid credential type' });
      }
      // FIX 3: Verify origin matches the app's expected origin
      if (clientData.origin !== RP_ORIGIN) {
        console.warn('[webauthn/register] Origin mismatch — expected:', RP_ORIGIN, 'got:', clientData.origin);
        return res.status(403).json({ error: 'Origin mismatch — ensure you are accessing the app from the correct URL' });
      }
      const challengeData = _getChallenge(clientData.challenge);
      if (!challengeData || challengeData.action !== 'register') {
        return res.status(400).json({ error: 'Challenge expired or invalid — try again' });
      }
      if (challengeData.userId !== session.user_id) {
        return res.status(403).json({ error: 'Session mismatch' });
      }

      // For 'none' attestation we trust the device reported public key.
      // Extract public key from attestationObject (CBOR-encoded).
      // We store the raw attestationObject as the public key blob —
      // during authentication we use the credentialPublicKey from authData.
      // Since we cannot easily CBOR-decode without a library, we store the
      // full attestationObject and re-extract the public key at auth time
      // using the standard SubtleCrypto approach on the client side.
      // For server-side verification we use the clientDataJSON hash approach.

      // Extract SPKI DER from the attestationObject and store it directly.
      // This replaces the previous approach of storing the raw attestationObject blob,
      // which made server-side signature verification impossible without a CBOR library.
      const credentialId = id;
      let publicKeyBlob;
      try {
        const derBuf = extractPublicKeyDER(credResponse.attestationObject);
        publicKeyBlob = derBuf.toString('base64'); // stored as standard base64
      } catch (keyErr) {
        console.error('[webauthn/register] Failed to extract public key:', keyErr.message);
        return res.status(400).json({ error: 'Unsupported authenticator key type — only P-256 (ES256) is supported' });
      }

      // Check if already registered (update counter reset)
      const existing = await db.prepare(
        'SELECT id FROM webauthn_credentials WHERE credential_id = $1'
      ).get(credentialId);

      if (existing) {
        await db.prepare(
          'UPDATE webauthn_credentials SET last_used_at = NOW(), device_name = $1 WHERE credential_id = $2'
        ).run(deviceName || 'My Device', credentialId);
      } else {
        await db.prepare(
          `INSERT INTO webauthn_credentials
           (user_id, user_type, tenant_id, credential_id, public_key, counter, device_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`
        ).run(
          session.user_id, 'admin', session.tenant_id,
          credentialId, publicKeyBlob, 0, deviceName || 'My Device'
        );
      }

      res.json({ success: true, message: 'Biometric registered — use it next time you open the app!' });
    } catch (e) {
      console.error('[webauthn/register]', e.message);
      res.status(500).json({ error: 'Registration failed: ' + e.message });
    }
  });

  // ── Step 3: Auth Options — called on app open before showing login screen ──
  // Client passes the credentialId it stored locally, server returns a challenge.
  router.post('/webauthn/auth-options', async (req, res) => {
    const { credentialId, tenantId } = req.body;
    if (!credentialId) return res.status(400).json({ error: 'credentialId required' });

    try {
      const cred = await db.prepare(
        'SELECT * FROM webauthn_credentials WHERE credential_id = $1 AND tenant_id = $2'
      ).get(credentialId, tenantId || '');

      // BUG-13 FIX: Return a generic challenge even for unknown credentials so the
      // response is indistinguishable from a valid one — prevents credential enumeration.
      const challenge = _base64url(crypto.randomBytes(32));
      if (!cred) {
        // Unknown credential — return a plausible-looking (but unresolvable) challenge.
        // The subsequent /webauthn/authenticate call will fail because this challenge
        // was never stored, which is the correct security outcome.
        return res.json({
          challenge,
          timeout: 60000,
          rpId: RP_ID,
          allowCredentials: [{ type: 'public-key', id: credentialId }],
          userVerification: 'required'
        });
      }

      _storeChallenge(challenge, {
        userId: cred.user_id,
        tenantId: cred.tenant_id,
        credentialId,
        action: 'authenticate'
      });

      res.json({
        challenge,
        timeout: 60000,
        rpId: RP_ID,
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        userVerification: 'required'
      });
    } catch (e) {
      console.error('[webauthn/auth-options]', e.message);
      res.status(500).json({ error: 'Failed to start biometric' });
    }
  });

  // ── Step 4: Authenticate — verify assertion and issue new session token ──
  router.post('/webauthn/authenticate', async (req, res) => {
    const { id, response: credResponse, tenantId } = req.body;
    if (!id || !credResponse?.clientDataJSON || !credResponse?.authenticatorData) {
      return res.status(400).json({ error: 'Invalid assertion data' });
    }

    try {
      // Parse and verify clientDataJSON
      const clientData = JSON.parse(
        Buffer.from(_fromBase64url(credResponse.clientDataJSON)).toString('utf8')
      );
      if (clientData.type !== 'webauthn.get') {
        return res.status(400).json({ error: 'Invalid assertion type' });
      }
      // FIX 3: Verify origin matches the app's expected origin
      if (clientData.origin !== RP_ORIGIN) {
        console.warn('[webauthn/authenticate] Origin mismatch — expected:', RP_ORIGIN, 'got:', clientData.origin);
        return res.status(403).json({ error: 'Origin mismatch — ensure you are accessing the app from the correct URL' });
      }
      const challengeData = _getChallenge(clientData.challenge);
      if (!challengeData || challengeData.action !== 'authenticate') {
        return res.status(400).json({ error: 'Challenge expired — try again' });
      }
      if (challengeData.credentialId !== id) {
        return res.status(403).json({ error: 'Credential mismatch' });
      }

      // Lookup credential and user
      const cred = await db.prepare(
        'SELECT wc.*, au.name as user_name, au.role as user_role FROM webauthn_credentials wc JOIN admin_users au ON au.id = wc.user_id WHERE wc.credential_id = $1'
      ).get(id);
      if (!cred) return res.status(404).json({ error: 'Credential not found' });

      // Parse authenticatorData to get sign count (replay attack prevention)
      const authDataBuf = _fromBase64url(credResponse.authenticatorData);
      // FIX 8: WebAuthn spec guarantees ≥37 bytes, but reject malformed/tampered bodies
      // before readUInt32BE(33) throws an unhandled RangeError that leaks a stack trace.
      if (authDataBuf.length < 37) {
        return res.status(400).json({ error: 'Invalid authenticatorData — too short' });
      }
      // Bytes 33-36 are the sign count (big-endian uint32)
      const signCount = authDataBuf.readUInt32BE(33);

      // Replay attack check: new count must be > stored count (or both 0 for some authenticators)
      if (signCount !== 0 && signCount <= cred.counter) {
        console.warn('[webauthn] Replay attack detected! credentialId:', id,
          'stored counter:', cred.counter, 'received:', signCount);
        return res.status(403).json({ error: 'Authentication rejected — possible replay attack' });
      }

      // ── ECDSA Signature Verification (BUG-01 FIX) ──────────────────────
      // Verify the authenticator's cryptographic signature against the stored
      // public key. Without this, ANY credential ID + challenge is accepted.
      let sigValid = false;
      try {
        sigValid = verifyWebAuthnSignature(
          cred.public_key,                  // base64 SPKI DER (or legacy attestationObject)
          credResponse.authenticatorData,   // base64url
          credResponse.clientDataJSON,      // base64url
          credResponse.signature            // base64url DER-encoded ECDSA sig
        );
      } catch (sigErr) {
        console.error('[webauthn/authenticate] Signature verification error:', sigErr.message);
        return res.status(403).json({ error: 'Biometric verification failed' });
      }
      if (!sigValid) {
        console.warn('[webauthn/authenticate] INVALID signature for credential:', id);
        return res.status(403).json({ error: 'Biometric verification failed — invalid signature' });
      }
      // ── Signature verified ✓ ─────────────────────────────────────────────

      // All checks passed — update counter and issue session
      await db.prepare(
        'UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE credential_id = $2'
      ).run(signCount, id);

      // Check user is still active
      const user = await db.prepare(
        'SELECT * FROM admin_users WHERE id = $1 AND active = 1'
      ).get(cred.user_id);
      if (!user) return res.status(403).json({ error: 'Account is inactive' });

      const tenant = await db.prepare(
        'SELECT * FROM tenants WHERE id = $1 AND active = 1'
      ).get(cred.tenant_id);
      if (!tenant) return res.status(403).json({ error: 'Station is inactive' });

      const token = await createSession(db, {
        tenantId: cred.tenant_id, userId: cred.user_id, userType: 'admin',
        userName: cred.user_name, role: cred.user_role,
        ip: req.ip, userAgent: req.headers['user-agent']
      });

      res.json({
        success: true, token,
        userType: 'admin', userName: cred.user_name, userRole: cred.user_role,
        tenantId: cred.tenant_id, tenantName: tenant.name,
        tenantIcon: tenant.icon || '⛽',
        tenantLocation: tenant.location || '',
        loginAt: new Date().toISOString(),
        method: 'biometric'
      });
    } catch (e) {
      console.error('[webauthn/authenticate]', e.message);
      res.status(500).json({ error: 'Biometric authentication failed' });
    }
  });

  // ── List registered credentials for a user ──────────────────────────────
  router.get('/webauthn/credentials', async (req, res) => {
    const session = await resolveSession(req, 'admin');
    if (!session) return res.status(401).json({ error: 'Login required' });
    try {
      const creds = await db.prepare(
        'SELECT id, credential_id, device_name, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 AND tenant_id = $2'
      ).all(session.user_id, session.tenant_id);
      res.json({ credentials: creds || [] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Remove a credential (user manages their own) ─────────────────────────
  router.delete('/webauthn/credentials/:credId', async (req, res) => {
    const session = await resolveSession(req, 'admin');
    if (!session) return res.status(401).json({ error: 'Login required' });
    try {
      await db.prepare(
        'DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 AND tenant_id = $3'
      ).run(parseInt(req.params.credId), session.user_id, session.tenant_id);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Employee WebAuthn Biometric Routes ───────────────────────────────────
  // BUG-01 FIX: Employee biometric was purely client-side (no assertion verification).
  // BUG-06 FIX: Credentials are now stored server-side in webauthn_credentials.
  // BUG-02 FIX: authenticate returns a server-issued JWT so the session is real.
  //
  // Registration flow (employee must be PIN-logged-in first):
  //   POST /webauthn/employee/register-options  → server challenge
  //   device prompt
  //   POST /webauthn/employee/register          → credential saved in DB
  //
  // Authentication flow (pre-login):
  //   POST /webauthn/employee/auth-options      → server challenge
  //   device prompt
  //   POST /webauthn/employee/authenticate      → JWT issued
  // ─────────────────────────────────────────────────────────────────────────

  // Step 1: Register — get challenge (requires active employee OR admin session)
  router.post('/webauthn/employee/register-options', async (req, res) => {
    const empSession = await resolveSession(req, 'employee');
    const adminSession = !empSession ? await resolveSession(req, 'admin') : null;
    if (!empSession && !adminSession) return res.status(401).json({ error: 'Login required' });

    try {
      // Resolve the employee being registered
      let empId, empName, tenantId;
      if (empSession) {
        empId    = empSession.user_id;
        empName  = empSession.user_name;
        tenantId = empSession.tenant_id;
      } else {
        // Admin registering for a specific employee
        const { employeeId } = req.body;
        if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
        const emp = await db.prepare(
          'SELECT id, name, tenant_id FROM employees WHERE id = $1 AND tenant_id = $2 AND active = 1'
        ).get(employeeId, adminSession.tenant_id);
        if (!emp) return res.status(404).json({ error: 'Employee not found' });
        empId    = emp.id;
        empName  = emp.name;
        tenantId = emp.tenant_id;
      }

      // Cap at 3 devices per employee
      const existing = await db.prepare(
        'SELECT COUNT(*) as cnt FROM webauthn_credentials WHERE user_id = $1 AND user_type = $2 AND tenant_id = $3'
      ).get(String(empId), 'employee', tenantId);
      if ((existing?.cnt || 0) >= 3) {
        return res.status(400).json({ error: 'Maximum of 3 devices already registered for this employee.' });
      }

      const challenge = _base64url(crypto.randomBytes(32));
      _storeChallenge(challenge, { userId: empId, tenantId, userType: 'employee', action: 'register' });

      res.json({
        challenge,
        rp: { name: 'UpScale Fuel', id: RP_ID },
        user: {
          id: _base64url(Buffer.from(`emp_${tenantId}_${empId}`)),
          name: empName,
          displayName: empName,
        },
        pubKeyCredParams: [
          { alg: -7,   type: 'public-key' },  // ES256
          { alg: -257, type: 'public-key' },   // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          requireResidentKey: false,
        },
        timeout: 60000,
        attestation: 'none',
      });
    } catch (e) {
      console.error('[webauthn/employee/register-options]', e.message);
      res.status(500).json({ error: 'Failed to start biometric registration' });
    }
  });

  // Step 2: Register — save credential
  router.post('/webauthn/employee/register', async (req, res) => {
    const empSession = await resolveSession(req, 'employee');
    const adminSession = !empSession ? await resolveSession(req, 'admin') : null;
    if (!empSession && !adminSession) return res.status(401).json({ error: 'Login required' });

    const { id, rawId, response: credResponse, deviceName, employeeId: bodyEmpId } = req.body;
    if (!id || !credResponse?.clientDataJSON || !credResponse?.attestationObject) {
      return res.status(400).json({ error: 'Invalid credential data' });
    }

    try {
      const clientData = JSON.parse(
        Buffer.from(_fromBase64url(credResponse.clientDataJSON)).toString('utf8')
      );
      if (clientData.type !== 'webauthn.create') {
        return res.status(400).json({ error: 'Invalid credential type' });
      }
      if (clientData.origin !== RP_ORIGIN) {
        return res.status(403).json({ error: 'Origin mismatch' });
      }
      const challengeData = _getChallenge(clientData.challenge);
      if (!challengeData || challengeData.action !== 'register' || challengeData.userType !== 'employee') {
        return res.status(400).json({ error: 'Challenge invalid or expired' });
      }

      const empId    = empSession ? empSession.user_id    : (bodyEmpId || challengeData.userId);
      const tenantId = empSession ? empSession.tenant_id  : (adminSession?.tenant_id || challengeData.tenantId);

      // Extract SPKI DER from attestationObject for server-side sig verification
      let empPublicKeyBlob;
      try {
        const derBuf = extractPublicKeyDER(credResponse.attestationObject);
        empPublicKeyBlob = derBuf.toString('base64');
      } catch (keyErr) {
        console.error('[webauthn/employee/register] Key extraction failed:', keyErr.message);
        return res.status(400).json({ error: 'Unsupported authenticator key type — only P-256 (ES256) is supported' });
      }

      // Upsert: update last_used if already registered, otherwise insert
      const existing = await db.prepare(
        'SELECT id FROM webauthn_credentials WHERE credential_id = $1'
      ).get(id);
      if (existing) {
        await db.prepare(
          'UPDATE webauthn_credentials SET last_used_at = NOW(), device_name = $1 WHERE credential_id = $2'
        ).run(deviceName || 'My Device', id);
      } else {
        await db.prepare(
          `INSERT INTO webauthn_credentials
           (user_id, user_type, tenant_id, credential_id, public_key, counter, device_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`
        ).run(
          String(empId), 'employee', tenantId,
          id, empPublicKeyBlob, 0, deviceName || 'My Device'
        );
      }
      res.json({ success: true, message: 'Biometric registered — use it next time you log in!' });
    } catch (e) {
      console.error('[webauthn/employee/register]', e.message);
      res.status(500).json({ error: 'Registration failed' });
    }
  });

  // Step 3: Auth-options — return challenge for login prompt (public, pre-login)
  router.post('/webauthn/employee/auth-options', async (req, res) => {
    const { credentialId, tenantId } = req.body;
    if (!credentialId) return res.status(400).json({ error: 'credentialId required' });

    try {
      const challenge = _base64url(crypto.randomBytes(32));
      const cred = await db.prepare(
        'SELECT * FROM webauthn_credentials WHERE credential_id = $1 AND user_type = $2 AND tenant_id = $3'
      ).get(credentialId, 'employee', tenantId || '');

      // Return generic challenge for unknown credentials (no enumeration)
      if (!cred) {
        return res.json({
          challenge, timeout: 60000, rpId: RP_ID,
          allowCredentials: [{ type: 'public-key', id: credentialId }],
          userVerification: 'required'
        });
      }

      _storeChallenge(challenge, {
        userId: cred.user_id, tenantId: cred.tenant_id,
        credentialId, action: 'authenticate', userType: 'employee'
      });
      res.json({
        challenge, timeout: 60000, rpId: RP_ID,
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        userVerification: 'required'
      });
    } catch (e) {
      console.error('[webauthn/employee/auth-options]', e.message);
      res.status(500).json({ error: 'Failed to start biometric' });
    }
  });

  // Step 4: Authenticate — verify assertion and issue employee JWT (public, pre-login)
  router.post('/webauthn/employee/authenticate', async (req, res) => {
    const { id, response: credResponse, tenantId } = req.body;
    if (!id || !credResponse?.clientDataJSON || !credResponse?.authenticatorData) {
      return res.status(400).json({ error: 'Invalid assertion data' });
    }

    try {
      const clientData = JSON.parse(
        Buffer.from(_fromBase64url(credResponse.clientDataJSON)).toString('utf8')
      );
      if (clientData.type !== 'webauthn.get') {
        return res.status(400).json({ error: 'Invalid assertion type' });
      }
      if (clientData.origin !== RP_ORIGIN) {
        return res.status(403).json({ error: 'Origin mismatch' });
      }
      const challengeData = _getChallenge(clientData.challenge);
      if (!challengeData || challengeData.action !== 'authenticate' || challengeData.userType !== 'employee') {
        return res.status(400).json({ error: 'Challenge expired — try again' });
      }
      if (challengeData.credentialId !== id) {
        return res.status(403).json({ error: 'Credential mismatch' });
      }

      const cred = await db.prepare(
        'SELECT wc.*, e.name as emp_name, e.role as emp_role FROM webauthn_credentials wc JOIN employees e ON e.id = wc.user_id::int WHERE wc.credential_id = $1 AND wc.user_type = $2'
      ).get(id, 'employee');
      if (!cred) return res.status(404).json({ error: 'Credential not found' });

      // Replay attack prevention via sign counter
      const authDataBuf = _fromBase64url(credResponse.authenticatorData);
      if (authDataBuf.length < 37) {
        return res.status(400).json({ error: 'Invalid authenticatorData' });
      }
      const signCount = authDataBuf.readUInt32BE(33);
      if (signCount !== 0 && signCount <= cred.counter) {
        console.warn('[webauthn/employee] Replay attack detected! credentialId:', id);
        return res.status(403).json({ error: 'Authentication rejected — possible replay attack' });
      }

      // ── ECDSA Signature Verification (BUG-01 FIX) ──────────────────────
      let sigValid = false;
      try {
        sigValid = verifyWebAuthnSignature(
          cred.public_key,
          credResponse.authenticatorData,
          credResponse.clientDataJSON,
          credResponse.signature
        );
      } catch (sigErr) {
        console.error('[webauthn/employee/authenticate] Signature error:', sigErr.message);
        return res.status(403).json({ error: 'Biometric verification failed' });
      }
      if (!sigValid) {
        console.warn('[webauthn/employee/authenticate] INVALID signature for credential:', id);
        return res.status(403).json({ error: 'Biometric verification failed — invalid signature' });
      }
      // ── Signature verified ✓ ─────────────────────────────────────────────

      await db.prepare(
        'UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE credential_id = $2'
      ).run(signCount, id);

      // Verify employee is still active
      const emp = await db.prepare(
        'SELECT * FROM employees WHERE id = $1 AND tenant_id = $2 AND active = 1'
      ).get(String(cred.user_id), cred.tenant_id);
      if (!emp) return res.status(403).json({ error: 'Employee account is inactive' });

      const tenant = await db.prepare(
        'SELECT * FROM tenants WHERE id = $1 AND active = 1'
      ).get(cred.tenant_id);
      if (!tenant) return res.status(403).json({ error: 'Station is inactive' });

      // BUG-02 FIX: Issue a real server session token for biometric login
      const token = await createSession(db, {
        tenantId: cred.tenant_id, userId: emp.id, userType: 'employee',
        userName: emp.name, role: emp.role || 'attendant',
        ip: req.ip, userAgent: req.headers['user-agent']
      });

      res.json({
        success: true, token,
        userType: 'employee', userName: emp.name,
        employeeId: emp.id, tenantId: cred.tenant_id,
        method: 'biometric'
      });
    } catch (e) {
      console.error('[webauthn/employee/authenticate]', e.message);
      res.status(500).json({ error: 'Biometric authentication failed' });
    }
  });

  return router;
}

module.exports = authRoutes;
