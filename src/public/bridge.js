/**
 * FuelBunk Pro — Backend Integration Bridge
 *
 * INCLUDE THIS SCRIPT AFTER api-client.js and BEFORE the main app script.
 *
 * This script overrides the localStorage/IndexedDB-based functions in the
 * original frontend to route through the REST API backend instead.
 *
 * Original functions overridden:
 *   - mt_getTenants() → API call
 *   - mt_saveTenants() → API call
 *   - mt_doSuperLogin() → AuthAPI.superLogin()
 *   - mt_superLogout() → AuthAPI.logout()
 *   - showLoginScreen() / appLogin() → AuthAPI.adminLogin()
 *   - FuelDB class → REST API (already in api-client.js)
 */

(function() {
  'use strict';

  // ═══════════════════════════════════════════
  // TENANT REGISTRY — API-backed with localStorage cache
  // ═══════════════════════════════════════════
  let _tenantCache = null;
  let _tenantCacheTime = 0;
  const CACHE_TTL = 5000; // 5 second cache

  // ── mt_showSelector override — landing page vs full station selector ────
  // When a non-super user has no active station, show the branded landing page
  // (rendered by showLoginScreen when APP.tenant is null) instead of the
  // full station list which exposes all station names publicly.
  // When super admin calls it (via secret URL cookie or after super login),
  // show the original full selector so they can manage all stations.
  const _origShowSelector = window.mt_showSelector;
  // Expose original selector so landingShowLogin() can call it directly
  // (bypassing our override when employee/super admin taps the landing page buttons)
  window._origShowSelectorForLanding = _origShowSelector;
  window.mt_showSelector = async function() {
    const isSuperActive = (typeof mt_isSuperLoggedIn === 'function') ? mt_isSuperLoggedIn() : false;
    const hasSuperCookie = (function() {
      var m = document.cookie.match(/(?:^|; )sa_entry=([^;]*)/);
      return m ? decodeURIComponent(m[1]) === '1' : false;
    })();
    if (isSuperActive || hasSuperCookie) {
      // Super admin path — show full selector with all stations + management tools
      if (typeof _origShowSelector === 'function') return _origShowSelector();
    }
    // Normal path — defer via setTimeout so initApp finishes setting up APP first
    // Without setTimeout: initApp calls mt_showSelector at line 110 BEFORE APP is
    // fully initialized, causing showLoginScreen → loadData → APP.data → crash
    if (typeof showLoginScreen === 'function') {
      setTimeout(function() { showLoginScreen(); }, 0);
    } else if (typeof _origShowSelector === 'function') {
      return _origShowSelector(); // fallback if employee.js not loaded yet
    }
  };

  // Override mt_getTenants to fetch from API with localStorage fallback
  const _origGetTenants = window.mt_getTenants;
  window.mt_getTenants = function() {
    // Return cache if fresh (sync — needed by original code)
    if (_tenantCache && (Date.now() - _tenantCacheTime < CACHE_TTL)) {
      return _tenantCache;
    }
    // Return localStorage fallback for sync access
    try {
      return JSON.parse(localStorage.getItem('fb_tenants') || '[]');
    } catch { return []; }
  };

  // Async version that fetches from server and updates cache
  window.mt_getTenants_async = async function() {
    try {
      const tenants = await TenantAPI.list();
      // Normalize active field: SQLite returns 0/1, frontend expects true/false
      tenants.forEach(t => { t.active = t.active === 1 || t.active === true; });
      _tenantCache = tenants;
      _tenantCacheTime = Date.now();

      if (tenants.length > 0) {
        // SERVER HAS DATA — authoritative, sync to localStorage cache
        localStorage.setItem('fb_tenants', JSON.stringify(tenants));
        return tenants;
      } else {
        // SERVER IS EMPTY — do NOT overwrite localStorage with [].
        // Stations may exist in localStorage from a previous deployment.
        // Wiping them here causes permanent visible data loss.
        // Preserve localStorage data and return it as fallback.
        const localTenants = mt_getTenants();
        if (localTenants.length > 0) {
          console.log('[Bridge] Server returned 0 stations — preserving', localTenants.length, 'local station(s) from cache');
        }
        return localTenants;
      }
    } catch (e) {
      console.warn('[Bridge] Failed to fetch tenants from server, using cache:', e.message);
      return mt_getTenants();
    }
  };

  // Override mt_saveTenants — this is tricky since original saves to localStorage
  // We keep localStorage sync AND push to server
  const _origSaveTenants = window.mt_saveTenants;
  window.mt_saveTenants = function(tenants) {
    // Keep localStorage sync for immediate UI
    localStorage.setItem('fb_tenants', JSON.stringify(tenants));
    _tenantCache = tenants;
    _tenantCacheTime = Date.now();
    // Note: individual tenant creates/updates should use TenantAPI directly
    // This function is called by the original code after modifications
  };

  // ═══════════════════════════════════════════
  // SUPER ADMIN LOGIN — API-backed
  // ═══════════════════════════════════════════
  const _origDoSuperLogin = window.mt_doSuperLogin;
  window.mt_doSuperLogin = async function() {
    const userEl = document.getElementById('superUser');
    const passEl = document.getElementById('superPass');
    if (!userEl || !passEl) return;

    const username = userEl.value.trim();
    const password = passEl.value;
    if (!username || !password) {
      if (typeof mt_toast === 'function') mt_toast('Enter username and password', 'error');
      return;
    }

    try {
      const result = await AuthAPI.superLogin(username, password);
      if (result.success) {
        // Token lives in sessionStorage only — clears when browser tab closes
        sessionStorage.setItem('fb_super_token', result.token);
        sessionStorage.setItem('fb_super_session', JSON.stringify({ loggedIn: true, at: Date.now() }));
        setAuthToken(result.token);
        if (typeof mt_toast === 'function') mt_toast('Super Admin logged in', 'success');
        await mt_getTenants_async();
        if (typeof mt_showSelector === 'function') mt_showSelector();
      }
    } catch (e) {
      if (typeof mt_toast === 'function') mt_toast(e.message || 'Login failed', 'error');
    }
  };

  // Override super logout
  const _origSuperLogout = window.mt_superLogout;
  window.mt_superLogout = async function() {
    try { await AuthAPI.logout(); } catch {}
    sessionStorage.removeItem('fb_super_token');
    sessionStorage.removeItem('fb_super_session');
    sessionStorage.removeItem('fb_session');
    clearAuth();
    // Clear APP state so showLoginScreen shows landing page
    if (typeof APP !== 'undefined') { APP.tenant = null; APP.loggedIn = false; APP.role = null; APP.adminUser = null; }
    if (typeof showLoginScreen === 'function') showLoginScreen();
    else if (typeof mt_showSelector === 'function') mt_showSelector();
  };

  // Override mt_isSuperLoggedIn — check sessionStorage only (clears on tab close)
  const _origIsSuperLoggedIn = window.mt_isSuperLoggedIn;
  window.mt_isSuperLoggedIn = function() {
    const token = sessionStorage.getItem('fb_super_token');
    // BUG-C FIX: guard against empty string token (written accidentally by old doAdminLogin code)
    if (!token || token.length < 10) return false;
    const s = (() => {
      try { return JSON.parse(sessionStorage.getItem('fb_super_session') || 'null'); } catch { return null; }
    })();
    if (!s || !s.loggedIn) return false;
    if (Date.now() - s.at > 4 * 60 * 60 * 1000) {
      sessionStorage.removeItem('fb_super_session');
      sessionStorage.removeItem('fb_super_token');
      return false;
    }
    return true;
  };

  // ═══════════════════════════════════════════
  // TENANT CRUD — Route through API
  // ═══════════════════════════════════════════
  const _origSaveTenant = window.mt_saveTenant;
  window.mt_saveTenant = async function(isEdit) {
    // Use same field IDs as index.html form
    const name     = document.getElementById('tName')?.value?.trim();
    const location = document.getElementById('tLocation')?.value?.trim();
    const ownerName= document.getElementById('tOwner')?.value?.trim();
    const phone    = document.getElementById('tPhone')?.value?.trim();
    const icon     = document.getElementById('tIcon')?.value || '⛽';
    const omc      = (document.querySelector('input[name="tOmc"]:checked')?.value || 'iocl');
    const id       = document.getElementById('tId')?.value;
    const adminUser= document.getElementById('tAdminUser')?.value?.trim() || 'admin';
    const adminPass= document.getElementById('tAdminPass')?.value || 'admin123';
    const ownerPhone= (document.getElementById('tOwnerPhone')?.value || '').replace(/\D/g,'').replace(/^(91|0)/,'').trim();
    const ownerEmail= (document.getElementById('tOwnerEmail')?.value || '').trim().toLowerCase();

    if (!name || name.length < 2) { if (typeof mt_toast === 'function') mt_toast('Enter a station name', 'error'); return; }

    // Ensure token is set — restore from sessionStorage or prompt re-login
    if (!getAuthToken()) {
      const saved = sessionStorage.getItem('fb_super_token');
      if (saved) {
        setAuthToken(saved);
      } else {
        if (typeof mt_toast === 'function') mt_toast('Session expired. Please log in again.', 'error');
        if (typeof mt_showSelector === 'function') mt_showSelector();
        return;
      }
    }

    try {
      if (isEdit && id) {
        await TenantAPI.update(id, { name, location, ownerName, phone, icon, omc });
        if (typeof mt_toast === 'function') mt_toast(name + ' updated', 'success');
      } else {
        await TenantAPI.create({ name, location, ownerName, phone, ownerPhone, ownerEmail, icon, omc, adminUser, adminPass });
        if (typeof mt_toast === 'function') mt_toast(name + ' created!', 'success');
      }
      // Fetch fresh list from server (includes updated omc field)
      const freshTenants = await mt_getTenants_async();
      // Patch any tenant in the list that is missing omc — defensive for stale cache
      if (Array.isArray(freshTenants)) {
        freshTenants.forEach(function(t) {
          if (!t.omc) t.omc = 'iocl';
          // If this is the station we just saved, force its omc to what the user selected
          if (isEdit && String(t.id) === String(id)) t.omc = omc;
        });
        localStorage.setItem('fb_tenants', JSON.stringify(freshTenants));
      }
      if (typeof mt_showSelector === 'function') mt_showSelector();
    } catch (e) {
      if (typeof mt_toast === 'function') mt_toast(e.message || 'Failed to save', 'error');
    }
  };

  const _origDeleteTenant = window.mt_deleteTenant;
  window.mt_deleteTenant = async function(id) {
    // MUST use super admin token — admin token doesn't have permission to delete stations
    const superToken = sessionStorage.getItem('fb_super_token');
    if (!superToken) { mt_toast('Super admin session expired. Please log in again.', 'error'); mt_showSelector(); return; }
    const prevToken = getAuthToken();
    setAuthToken(superToken);
    try {
      await TenantAPI.remove(id);
      const active = mt_getActiveTenant();
      if (active?.id === id) mt_clearActiveTenant();
      await mt_getTenants_async();
      mt_toast('Station deleted', 'success');
      mt_showSelector();
    } catch (e) {
      mt_toast(e.message || 'Failed to delete', 'error');
    } finally {
      // Restore previous token
      if (prevToken) setAuthToken(prevToken); else clearAuth();
    }
  };

  // ═══════════════════════════════════════════
  // STATION SELECT — Login to selected station
  // ═══════════════════════════════════════════
  const _origSelectTenant = window.mt_selectTenant;
  window.mt_selectTenant = function(id) {
    const tenants = mt_getTenants();
    const t = tenants.find(x => x.id === id);
    if (!t) return;
    if (t.active === false) { mt_toast('This station is inactive', 'error'); return; }

    // Set active tenant in localStorage (for original code)
    mt_setActiveTenant(t);
    setTenantId(id);

    // Re-initialize FuelDB with API-backed version
    window.db = new FuelDB('FuelBunkPro_' + id);

    // Load the app
    location.reload();
  };

  // ═══════════════════════════════════════════
  // ADMIN LOGIN — API-backed
  // ═══════════════════════════════════════════
  // The original appLogin function will need to call AuthAPI
  // We patch the credential verification part

  // Override mt_toggleStation — sync active status to server
  const _origToggleStation = window.mt_toggleStation;
  window.mt_toggleStation = async function(id) {
    const tenants = mt_getTenants();
    const t = tenants.find(x => x.id === id);
    if (!t) return;
    const newActive = t.active === false ? true : false;
    // Restore super token for this privileged operation
    const superToken = sessionStorage.getItem('fb_super_token');
    const prevToken = getAuthToken();
    if (superToken) setAuthToken(superToken);
    try {
      await TenantAPI.update(id, { active: newActive });
    } catch(e) {
      console.warn('[Bridge] Failed to update station active status on server:', e.message);
    } finally {
      if (prevToken) setAuthToken(prevToken);
    }
    // Refresh from server
    mt_getTenants_async().then(() => mt_showSelector()).catch(()=>{});
  };

  // Override doAdminLogin — handles BOTH login paths:
  // 1. Landing page (no APP.tenant) → phone + password via /phone-login
  //    Server returns tenantId/tenantName — no station selection needed
  // 2. Station login screen (APP.tenant already set) → username + password (unchanged)
  window.doAdminLogin = async function() {
    const tenant = (typeof mt_getActiveTenant === 'function') ? mt_getActiveTenant() : null;

    if (!tenant) {
      // ── PHONE LOGIN PATH (landing page) ─────────────────────────────────
      const phoneRaw = document.getElementById('adminUser')?.value?.trim() || '';
      const pass     = document.getElementById('adminPass')?.value || '';
      if (!phoneRaw || !pass) { if(typeof toast==='function') toast('Enter phone number and password', 'error'); return; }
      const phone = phoneRaw.replace(/\D/g,'').replace(/^(91|0)/,'').trim();
      if (phone.length !== 10) { if(typeof toast==='function') toast('Enter a valid 10-digit phone number', 'error'); return; }
      try {
        const result = await AuthAPI.phoneLogin(phone, pass);
        if (result.success) {
          setAuthToken(result.token);
          setTenantId(result.tenantId);
          // Build tenant object from response and save to localStorage
          const tenantObj = {
            id:          result.tenantId,
            name:        result.tenantName,
            location:    result.tenantLocation || '',
            icon:        result.tenantIcon    || '⛽',
            color:       '#d4940f',
            colorLight:  '#f0b429',
            active:      true,
          };
          if (typeof mt_setActiveTenant === 'function') mt_setActiveTenant(tenantObj);
          sessionStorage.setItem('fb_session', JSON.stringify({
            loggedIn: true, role: 'admin',
            adminUser: { name: result.userName, username: phone, role: result.userRole },
            tenant: tenantObj, token: result.token
          }));
          if (typeof APP !== 'undefined') {
            APP.loggedIn = true;
            APP.role     = 'admin';
            APP.adminUser = { name: result.userName, username: phone, role: result.userRole };
            APP.tenant    = tenantObj;
          }
          window.db = new FuelDB('FuelBunkPro_' + result.tenantId);
          // Refresh full tenant object from server (phone login returns minimal tenant data)
          // This ensures ownerName, omc, stationCode etc. are populated correctly
          try {
            if (typeof mt_getTenants_async === 'function') {
              const allTenants = await mt_getTenants_async();
              const fullTenant = allTenants.find(function(t) { return t.id === result.tenantId; });
              if (fullTenant) {
                APP.tenant = fullTenant;
                if (typeof mt_setActiveTenant === 'function') mt_setActiveTenant(fullTenant);
              }
            }
          } catch(e) { /* non-fatal — minimal tenant object still works */ }
          if (typeof loadData === 'function') {
            try { await loadData(); } catch(e) { console.warn('[Bridge] loadData:', e.message); }
          }
          if (typeof enterApp === 'function') enterApp();
          if (typeof toast === 'function') toast('Welcome, ' + result.userName, 'success');
        }
      } catch (e) {
        if (typeof toast === 'function') toast(e.message || 'Invalid phone or password', 'error');
      }
      return;
    }

    // ── USERNAME LOGIN PATH (station login screen — tenant already set) ───
    const user = document.getElementById('adminUser')?.value?.trim()?.toLowerCase();
    const pass = document.getElementById('adminPass')?.value;
    if (!user || !pass) { if(typeof toast==='function') toast('Enter credentials', 'error'); return; }
    try {
      const result = await AuthAPI.adminLogin(user, pass, tenant.id);
      if (result.success) {
        setAuthToken(result.token);
        sessionStorage.setItem('fb_session', JSON.stringify({
          loggedIn: true, role: 'admin',
          adminUser: { name: result.userName, username: user, role: result.userRole },
          tenant: tenant, token: result.token
        }));
        if (typeof APP !== 'undefined') {
          APP.loggedIn  = true;
          APP.role      = 'admin';
          APP.adminUser = { name: result.userName, username: user, role: result.userRole };
          APP.tenant    = tenant;
        }
        window.db = new FuelDB('FuelBunkPro_' + tenant.id);
        setTenantId(tenant.id);
        if (typeof loadData === 'function') {
          try { await loadData(); } catch(e) { console.warn('[Bridge] loadData:', e.message); }
        }
        if (typeof enterApp === 'function') enterApp();
        if (typeof toast === 'function') toast('Welcome, ' + result.userName, 'success');
      }
    } catch (e) {
      if (typeof toast === 'function') toast(e.message || 'Invalid credentials', 'error');
    }
  };
  const _origAppLogin = window.appLogin;
  window.appLogin = async function() {
    const user = document.getElementById('loginUser')?.value?.trim()?.toLowerCase();
    const pass = document.getElementById('loginPass')?.value;

    if (!user || !pass) { toast('Enter username and password', 'error'); return; }

    const tenant = mt_getActiveTenant();
    if (!tenant) { toast('No station selected', 'error'); return; }

    try {
      const result = await AuthAPI.adminLogin(user, pass, tenant.id);
      if (result.success) {
        // Set session in original APP state
        APP.loggedIn = true;
        APP.role = 'admin';
        APP.adminUser = { name: result.userName, username: user, role: result.userRole };
        APP.tenant = tenant;

        // Save to sessionStorage for page refresh
        sessionStorage.setItem('fb_session', JSON.stringify({
          loggedIn: true, role: 'admin', adminUser: APP.adminUser,
          tenant: tenant, token: result.token
        }));

        // Re-init DB with correct tenant
        window.db = new FuelDB('FuelBunkPro_' + tenant.id);
        setTenantId(tenant.id);
        // Load real DB data BEFORE rendering
        if (typeof loadData === 'function') {
          try { await loadData(); } catch(e) { console.warn('[Bridge] loadData:', e.message); }
        }
        enterApp();
        toast('Welcome, ' + result.userName, 'success');
      }
    } catch (e) {
      toast(e.message || 'Invalid credentials', 'error');
    }
  };

  // ═══════════════════════════════════════════
  // SESSION RESTORE — from sessionStorage
  // ═══════════════════════════════════════════
  const _origLoadSession = window.loadSession;
  window.loadSession = function() {
    try {
      const raw = sessionStorage.getItem('fb_session');
      if (!raw) return false;
      const session = JSON.parse(raw);
      if (!session.loggedIn) return false;

      // Restore auth token
      if (session.token) {
        setAuthToken(session.token);
        setTenantId(session.tenant?.id);
      }

      APP.loggedIn = true;
      APP.role = session.role === 'employee' ? 'employee' : 'admin';
      APP.adminUser = session.adminUser;
      APP.tenant = session.tenant;

      // Re-init DB
      if (session.tenant?.id) {
        window.db = new FuelDB('FuelBunkPro_' + session.tenant.id);
      }

      // Token is set above — loadData() will be called by initApp() with correct token

      return true;
    } catch (e) {
      return false;
    }
  };

  // ═══════════════════════════════════════════
  // LOGOUT — API-backed
  // ═══════════════════════════════════════════
  const _origAppLogout = window.appLogout;
  window.appLogout = async function() {
    try { await AuthAPI.logout(); } catch {}
    APP.loggedIn = false;
    APP.role = null;
    APP.adminUser = null;
    APP.data = null;
    sessionStorage.removeItem('fb_session');
    clearAuth();
    location.reload();
  };

  // ═══════════════════════════════════════════
  // AUTO-REFRESH TENANTS ON PAGE LOAD
  // ═══════════════════════════════════════════
  // ── Super session heartbeat ─────────────────────────────────────────────
  // Checks server every 2 MINUTES (not 5 seconds) to avoid hammering /api/auth/session.
  // visibilitychange + focus events give fast kick-out detection without polling.
  let _superHeartbeatTimer = null;
  function startSuperSessionHeartbeat() {
    stopSuperSessionHeartbeat();
    _superHeartbeatTimer = setInterval(async function() {
      const token = sessionStorage.getItem('fb_super_token');
      if (!token) { stopSuperSessionHeartbeat(); return; }
      try {
        setAuthToken(token);
        await AuthAPI.checkSession();
      } catch (e) { /* 401 handled by apiFetch → appLogout() */ }
    }, 120000); // 2 minutes — visibilitychange handles fast detection
  }
  // Also check immediately when this tab regains focus — catches the kicked-out state instantly
  async function _superSessionCheck() {
    const token = sessionStorage.getItem('fb_super_token');
    if (!token) { stopSuperSessionHeartbeat(); return; }
    try {
      // Manually call the session endpoint — bypass apiFetch's auto-logout
      // so WE control the cleanup, not appLogout (which doesn't clear super tokens)
      const resp = await fetch('/api/auth/session', {
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
      });
      if (resp.status === 401) {
        // Another device logged in and killed this session — force super logout NOW
        stopSuperSessionHeartbeat();
        sessionStorage.removeItem('fb_super_token');
        sessionStorage.removeItem('fb_super_session');
        clearAuth();
        if (typeof mt_toast === 'function') mt_toast('⚠️ Super Admin session ended — another login was detected', 'error');
        setTimeout(function() {
          if (typeof mt_showSelector === 'function') mt_showSelector();
        }, 1500);
      }
      // Any other status (200, 500, network error) — stay logged in, try next tick
    } catch (e) {
      // Network offline or server error — do nothing, retry on next tick
    }
  }
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible' && sessionStorage.getItem('fb_super_token')) {
      _superSessionCheck();
    }
  });
  window.addEventListener('focus', function() {
    if (sessionStorage.getItem('fb_super_token')) {
      _superSessionCheck();
    }
  });

  function stopSuperSessionHeartbeat() {
    if (_superHeartbeatTimer) {
      clearInterval(_superHeartbeatTimer);
      _superHeartbeatTimer = null;
    }
  }

  document.addEventListener('DOMContentLoaded', function() {
    // ── 0. Super Admin Secret Entry Route handler ─────────────────────────
    // When the server serves index.html from the secret SUPER_ENTRY_PATH, it sets
    // the X-Super-Entry response header. We can't read response headers in JS directly,
    // so instead we check a meta tag the server injects — OR we use the cleaner approach:
    // check if the current pathname matches what we stored in a session flag.
    // Actual mechanism: the /super route sets a short-lived cookie 'sa_entry=1' (httpOnly:false
    // so JS can read it), then bridge.js reads it, clears it, and opens the selector.
    // This way the secret path never appears in JS source code.
    (function() {
      function _getCookie(name) {
        var match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return match ? decodeURIComponent(match[1]) : null;
      }
      if (_getCookie('sa_entry') === '1') {
        // Clear the cookie immediately — single-use
        document.cookie = 'sa_entry=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Strict';
        // Clear active tenant so the selector is shown (not the login screen)
        if (typeof mt_clearActiveTenant === 'function') mt_clearActiveTenant();
        // Show selector after a short delay to let the rest of bridge init complete
        setTimeout(function() {
          if (typeof mt_showSelector === 'function') mt_showSelector();
          else if (typeof mt_getTenants_async === 'function') {
            mt_getTenants_async().then(function() {
              if (typeof mt_showSelector === 'function') mt_showSelector();
            });
          }
        }, 150);
        return; // skip normal init flow
      }
    })();

    // ── 1. Restore super token from sessionStorage only ───────────────────
    const savedToken = sessionStorage.getItem('fb_super_token');
    if (savedToken) {
      setAuthToken(savedToken);
      // Restore heartbeat after page reload — still need to watch for takeover
      startSuperSessionHeartbeat();
    }

    // ── 2. Fetch tenants from server; landing page handles no-tenant case ─
    // When no active tenant: app.js initApp() calls mt_showSelector() → which now
    // routes to the landing page (showLoginScreen checks APP.tenant === null).
    // mt_getTenants_async() is still called to warm the tenant cache, but we no longer
    // force mt_showSelector() here — the login screen renderer decides what to show.
    const activeTenant = (typeof mt_getActiveTenant === 'function') ? mt_getActiveTenant() : null;
    if (!activeTenant) {
      mt_getTenants_async().catch(() => {});
      // mt_showSelector will be called by initApp → mt_showSelector → showLoginScreen
      // which detects APP.tenant === null and renders the landing page
    } else {
      mt_getTenants_async().catch(() => {});
    }

    // ── 3. Re-apply ALL bridge overrides (index.html overwrites them) ─────
    // index.html runs window.X = X after bridge.js loads, undoing our overrides.
    // We must re-apply everything inside DOMContentLoaded which runs last.

    // ── Super admin login ──────────────────────────────────────────────────
    window.mt_doSuperLogin = async function() {
      const userEl = document.getElementById('superUser');
      const passEl = document.getElementById('superPass');
      if (!userEl || !passEl) return;
      const username = userEl.value.trim();
      const password = passEl.value;
      if (!username || !password) {
        if (typeof mt_toast === 'function') mt_toast('Enter username and password', 'error');
        return;
      }
      try {
        const result = await AuthAPI.superLogin(username, password);
        if (result.success) {
          // Token in sessionStorage only — never written to localStorage
          sessionStorage.setItem('fb_super_token', result.token);
          sessionStorage.setItem('fb_super_session', JSON.stringify({ loggedIn: true, at: Date.now() }));
          setAuthToken(result.token);
          if (typeof mt_toast === 'function') mt_toast('Super Admin logged in', 'success');
          // ── Start session heartbeat — kicks this tab out if another device logs in ──
          startSuperSessionHeartbeat();

          // ── AUTO-MIGRATION: recover stations from localStorage → PostgreSQL ──
          // If server has 0 stations but browser localStorage has stations, this means
          // the app previously ran in local-only mode (no backend) or the backend DB was
          // re-provisioned. Automatically migrate so no data is lost.
          try {
            const serverTenants = await TenantAPI.list();
            if (serverTenants.length === 0) {
              const localTenants = (typeof mt_getTenants === 'function') ? mt_getTenants() : [];
              if (localTenants.length > 0) {
                if (typeof mt_toast === 'function') mt_toast('⟳ Recovering ' + localTenants.length + ' station(s) from local storage...', 'info');
                let migrated = 0, failed = 0;
                const migratedPasswords = [];
                for (const t of localTenants) {
                  try {
                    const adminUsername = (t.adminUsers && t.adminUsers[0] && t.adminUsers[0].username) || 'admin';
                    // Generate a deterministic temporary password from the station name
                    const tempPass = 'Admin@' + (t.name || 'Station').replace(/[^a-zA-Z0-9]/g, '').substring(0, 8) + '1';
                    await TenantAPI.create({
                      id: t.id || undefined,
                      name: t.name,
                      location: t.location || '',
                      ownerName: t.ownerName || '',
                      phone: t.phone || '',
                      icon: t.icon || '⛽',
                      color: t.color || '#d4940f',
                      colorLight: t.colorLight || '#f0b429',
                      adminUser: adminUsername,
                      adminPass: tempPass,
                    });
                    migrated++;
                    migratedPasswords.push({ station: t.name, user: adminUsername, pass: tempPass });
                    console.log('[Bridge] ✅ Migrated station "' + t.name + '" — admin: ' + adminUsername + ' / pass: ' + tempPass);
                  } catch (migrErr) {
                    failed++;
                    console.warn('[Bridge] ⚠️ Migration failed for "' + (t.name || '?') + '":', migrErr.message);
                  }
                }
                if (migrated > 0) {
                  console.log('[Bridge] MIGRATION COMPLETE — New admin credentials:', JSON.stringify(migratedPasswords, null, 2));
                  if (typeof mt_toast === 'function') mt_toast('✅ ' + migrated + ' station(s) recovered! Open browser console (F12) for new login credentials.', 'success');
                }
                if (failed > 0 && typeof mt_toast === 'function') {
                  mt_toast('⚠️ ' + failed + ' station(s) could not be migrated — they may already exist', 'error');
                }
              }
            }
          } catch (migrationErr) {
            console.warn('[Bridge] Auto-migration check failed:', migrationErr.message);
          }

          await mt_getTenants_async();
          if (typeof mt_showSelector === 'function') mt_showSelector();
        }
      } catch (e) {
        if (typeof mt_toast === 'function') mt_toast(e.message || 'Login failed', 'error');
      }
    };

    // ── Super admin logout ────────────────────────────────────────────────
    window.mt_superLogout = async function() {
      stopSuperSessionHeartbeat();
      try { await AuthAPI.logout(); } catch {}
      sessionStorage.removeItem('fb_super_token');
      sessionStorage.removeItem('fb_super_session');
      sessionStorage.removeItem('fb_session');
      clearAuth();
      if (typeof APP !== 'undefined') { APP.tenant = null; APP.loggedIn = false; APP.role = null; APP.adminUser = null; }
      if (typeof showLoginScreen === 'function') showLoginScreen();
      else if (typeof mt_showSelector === 'function') mt_showSelector();
    };

    // ── Delete station (requires super token) ─────────────────────────────
    window.mt_deleteTenant = async function(id) {
      const superToken = sessionStorage.getItem('fb_super_token');
      if (!superToken) {
        if (typeof mt_toast === 'function') mt_toast('Super admin session expired. Please log in again.', 'error');
        if (typeof mt_showSelector === 'function') mt_showSelector();
        return;
      }
      const prevToken = getAuthToken();
      setAuthToken(superToken);
      try {
        await TenantAPI.remove(id);
        const active = (typeof mt_getActiveTenant === 'function') ? mt_getActiveTenant() : null;
        if (active && active.id === id) {
          if (typeof mt_clearActiveTenant === 'function') mt_clearActiveTenant();
          // FIX: Clear ALL stale data for this station from localStorage.
          // Otherwise deleted station's employees/data reappear next time any station is opened.
          try { localStorage.removeItem('fb_data_snapshot'); } catch(e) {}
          try { localStorage.removeItem('fb_api_cache'); } catch(e) {}
          try { localStorage.removeItem('fb_emp_pins'); } catch(e) {}
        }
        await mt_getTenants_async();
        if (typeof mt_toast === 'function') mt_toast('Station deleted', 'success');
        if (typeof mt_showSelector === 'function') mt_showSelector();
      } catch (e) {
        if (typeof mt_toast === 'function') mt_toast(e.message || 'Failed to delete', 'error');
      } finally {
        if (prevToken) setAuthToken(prevToken); else clearAuth();
      }
    };
    // Also update the confirm dialog reference
    window.mt_confirmDeleteTenant = function(id) {
      const t = mt_getTenants().find(x => x.id === id);
      if (!t) return;
      // Re-use the existing overlay or create a minimal one
      const existing = document.getElementById('mtDeleteOverlay');
      if (existing) existing.remove();
      document.getElementById('app').innerHTML += `
        <div id="mtDeleteOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:9999;display:grid;place-items:center">
          <div style="background:var(--bg-1,#1a1a2e);border:1px solid var(--border,#333);border-radius:16px;padding:32px;max-width:360px;width:90%;text-align:center">
            <div style="font-size:40px;margin-bottom:12px">⚠️</div>
            <div style="font-size:17px;font-weight:700;color:var(--text-0,#fff);margin-bottom:10px">Delete "${t.name}"?</div>
            <div style="font-size:13px;color:var(--text-2,#aaa);margin-bottom:20px;line-height:1.6">This permanently deletes the station and ALL its data. Cannot be undone.</div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-ghost" style="flex:1" onclick="document.getElementById('mtDeleteOverlay').remove()">Cancel</button>
              <button class="btn btn-red" style="flex:1" onclick="document.getElementById('mtDeleteOverlay').remove();mt_deleteTenant('${id}')">🗑 Delete</button>
            </div>
          </div>
        </div>
      `;
    };

    // ── Toggle station active/inactive (requires super token) ─────────────
    window.mt_toggleStation = async function(id) {
      const tenants = mt_getTenants();
      const t = tenants.find(x => x.id === id);
      if (!t) return;
      const newActive = t.active === false ? true : false;
      const superToken = sessionStorage.getItem('fb_super_token');
      const prevToken = getAuthToken();
      if (superToken) setAuthToken(superToken);
      try {
        await TenantAPI.update(id, { active: newActive });
        await mt_getTenants_async();
      } catch (e) {
        console.warn('[Bridge] toggleStation failed:', e.message);
      } finally {
        if (prevToken) setAuthToken(prevToken);
      }
      if (typeof mt_showSelector === 'function') mt_showSelector();
    };

    // ── Create / edit station ──────────────────────────────────────────────
    window.mt_saveTenant = async function(isEdit) {
      const name      = document.getElementById('tName')?.value?.trim();
      const location  = document.getElementById('tLocation')?.value?.trim();
      const ownerName = document.getElementById('tOwner')?.value?.trim();
      const phone     = document.getElementById('tPhone')?.value?.trim();
      const icon      = document.getElementById('tIcon')?.value || '\u26fd';
      const omc       = (document.querySelector('input[name="tOmc"]:checked')?.value || 'iocl');
      const id        = document.getElementById('tId')?.value;
      const adminUser = document.getElementById('tAdminUser')?.value?.trim() || 'admin';
      const adminPass = document.getElementById('tAdminPass')?.value || 'admin123';
      const ownerPhone= (document.getElementById('tOwnerPhone')?.value || '').replace(/\D/g,'').replace(/^(91|0)/,'').trim();
      const ownerEmail= (document.getElementById('tOwnerEmail')?.value || '').trim().toLowerCase();
      if (!name || name.length < 2) { if (typeof mt_toast === 'function') mt_toast('Enter a station name', 'error'); return; }
      if (!getAuthToken()) {
        const saved = sessionStorage.getItem('fb_super_token');
        if (saved) setAuthToken(saved);
        else { if (typeof mt_toast === 'function') mt_toast('Session expired. Please log in again.', 'error'); if (typeof mt_showSelector === 'function') mt_showSelector(); return; }
      }
      try {
        if (isEdit && id) {
          await TenantAPI.update(id, { name, location, ownerName, phone, icon, omc });
          if (typeof mt_toast === 'function') mt_toast(name + ' updated', 'success');
        } else {
          await TenantAPI.create({ name, location, ownerName, phone, ownerPhone, ownerEmail, icon, omc, adminUser, adminPass });
          if (typeof mt_toast === 'function') mt_toast(name + ' created!', 'success');
        }
        const freshT = await mt_getTenants_async();
        if (Array.isArray(freshT)) {
          freshT.forEach(function(t) { if (!t.omc) t.omc = 'iocl'; if (isEdit && String(t.id) === String(id)) t.omc = omc; });
          localStorage.setItem('fb_tenants', JSON.stringify(freshT));
        }
        if (typeof mt_showSelector === 'function') mt_showSelector();
      } catch (e) {
        if (typeof mt_toast === 'function') mt_toast(e.message || 'Failed to save', 'error');
      }
    };

    // ── Delete station admin user (requires super token) ──────────────────
    window.mt_deleteStationAdmin = async function(tenantId, userIdx) {
      if (!confirm('Remove this admin user?')) return;
      const superToken = sessionStorage.getItem('fb_super_token');
      const prevToken = getAuthToken();
      if (superToken) setAuthToken(superToken);
      try {
        // Get current admins list to find the user id
        const admins = await TenantAPI.getAdmins(tenantId);
        const user = admins[userIdx];
        if (!user) { if (typeof mt_toast === 'function') mt_toast('Admin user not found', 'error'); return; }
        await TenantAPI.removeAdmin(tenantId, user.id);
        if (typeof mt_toast === 'function') mt_toast('Admin removed', 'success');
        if (typeof mt_manageStationAdmins === 'function') mt_manageStationAdmins(tenantId);
      } catch (e) {
        if (typeof mt_toast === 'function') mt_toast(e.message || 'Failed to remove admin', 'error');
      } finally {
        if (prevToken) setAuthToken(prevToken);
      }
    };

    // ── Admin login via API (NOT localStorage hash check) ─────────────────
    // Re-apply dual-path doAdminLogin (same logic as top of IIFE — phone when no tenant, username when tenant set)
    window.doAdminLogin = async function() {
      const tenant = (typeof mt_getActiveTenant === 'function') ? mt_getActiveTenant() : null;
      if (!tenant) {
        // Phone login path (landing page)
        const phoneRaw = (document.getElementById('adminUser')?.value || '').trim();
        const pass     = document.getElementById('adminPass')?.value || '';
        if (!phoneRaw || !pass) { if(typeof toast==='function') toast('Enter phone number and password', 'error'); return; }
        const phone = phoneRaw.replace(/\D/g,'').replace(/^(91|0)/,'').trim();
        if (phone.length !== 10) { if(typeof toast==='function') toast('Enter a valid 10-digit phone number', 'error'); return; }
        try {
          const result = await AuthAPI.phoneLogin(phone, pass);
          if (result.success) {
            setAuthToken(result.token);
            setTenantId(result.tenantId);
            const tenantObj = { id: result.tenantId, name: result.tenantName, location: result.tenantLocation||'', icon: result.tenantIcon||'⛽', color:'#d4940f', colorLight:'#f0b429', active:true };
            if (typeof mt_setActiveTenant === 'function') mt_setActiveTenant(tenantObj);
            sessionStorage.setItem('fb_session', JSON.stringify({ loggedIn:true, role:'admin', adminUser:{name:result.userName, username:phone, role:result.userRole}, tenant:tenantObj, token:result.token }));
            if (typeof APP !== 'undefined') { APP.loggedIn=true; APP.role='admin'; APP.adminUser={name:result.userName, username:phone, role:result.userRole}; APP.tenant=tenantObj; }
            window.db = new FuelDB('FuelBunkPro_' + result.tenantId);
            try {
              if (typeof mt_getTenants_async === 'function') {
                var allT = await mt_getTenants_async();
                var fullT = allT && allT.find(function(t){return t.id===result.tenantId;});
                if (fullT) { APP.tenant=fullT; if(typeof mt_setActiveTenant==='function') mt_setActiveTenant(fullT); }
              }
            } catch(e2) {}
            if (typeof loadData === 'function') { try { await loadData(); } catch(e) {} }
            if (typeof enterApp === 'function') enterApp();
            if (typeof toast === 'function') toast('Welcome, ' + result.userName, 'success');
          }
        } catch(e) { if(typeof toast==='function') toast(e.message||'Invalid phone or password','error'); }
        return;
      }
      // Username login path (station login screen)
      const user = (document.getElementById('adminUser')?.value || '').trim().toLowerCase();
      const pass = document.getElementById('adminPass')?.value || '';
      if (!user || !pass) { if(typeof toast==='function') toast('Enter credentials','error'); return; }
      try {
        const result = await AuthAPI.adminLogin(user, pass, tenant.id);
        if (result.success) {
          setAuthToken(result.token);
          setTenantId(tenant.id);
          sessionStorage.setItem('fb_session', JSON.stringify({ loggedIn:true, role:'admin', adminUser:{name:result.userName, username:user, role:result.userRole}, tenant, token:result.token }));
          if (typeof APP !== 'undefined') { APP.loggedIn=true; APP.role='admin'; APP.adminUser={name:result.userName, username:user, role:result.userRole}; APP.tenant=tenant; }
          window.db = new FuelDB('FuelBunkPro_' + tenant.id);
          if (typeof loadData === 'function') { try { await loadData(); } catch(e) { console.warn('[Bridge] loadData:', e.message); } }
          if (typeof enterApp === 'function') enterApp();
          if (typeof toast === 'function') toast('Welcome, ' + result.userName, 'success');
        }
      } catch(e) { if(typeof toast==='function') toast(e.message||'Invalid credentials','error'); }
    };

    // ── Session restore (uses sessionStorage + API token) ─────────────────
    window.loadSession = function() {
      try {
        const raw = sessionStorage.getItem('fb_session');
        if (!raw) return false;
        const session = JSON.parse(raw);
        if (!session || !session.loggedIn || !session.token) return false;
        setAuthToken(session.token);
        setTenantId(session.tenant?.id);
        if (typeof APP !== 'undefined') {
          APP.loggedIn = true;
          APP.role = session.role === 'employee' ? 'employee' : 'admin';
          APP.adminUser = session.adminUser;
          APP.tenant = session.tenant;
        }
        if (session.tenant?.id) {
          window.db = new FuelDB('FuelBunkPro_' + session.tenant.id);
        }
        // Token set above — loadData() called by initApp() with correct token
        return true;
      } catch (e) {
        return false;
      }
    };

    // ── App logout ────────────────────────────────────────────────────────
    window.appLogout = async function() {
      try { await AuthAPI.logout(); } catch {}
      if (typeof APP !== 'undefined') {
        APP.loggedIn = false; APP.role = null; APP.adminUser = null; APP.data = null;
      }
      sessionStorage.removeItem('fb_session');
      clearAuth();
      // FIX: Clear snapshot on logout so stale data never persists across sessions.
      try { localStorage.removeItem('fb_data_snapshot'); } catch(e) {}
      try { localStorage.removeItem('fb_api_cache'); } catch(e) {}
      try { localStorage.removeItem('fb_emp_pins'); } catch(e) {}
      location.reload();
    };

    // ── Select tenant (station) → sets token + FuelDB ─────────────────────
    window.mt_selectTenant = function(id) {
      const tenants = mt_getTenants();
      const t = tenants.find(x => x.id === id);
      if (!t) return;
      if (t.active === false) { if (typeof mt_toast === 'function') mt_toast('This station is inactive', 'error'); return; }
      if (typeof mt_setActiveTenant === 'function') mt_setActiveTenant(t);
      setTenantId(id);
      // FIX: Clear stale offline snapshot and API cache from the previous station.
      // Without this, employees/tanks/sales from a deleted or different station
      // kept appearing because the old snapshot was restored on load.
      try { localStorage.removeItem('fb_data_snapshot'); } catch(e) {}
      try { localStorage.removeItem('fb_api_cache'); } catch(e) {}
      try { localStorage.removeItem('fb_emp_pins'); } catch(e) {}
      window.db = new FuelDB('FuelBunkPro_' + id);
      location.reload();
    };

    // ── Super admin password change → API ─────────────────────────────────
    window.mt_saveSupercreds = async function() {
      const newUser = document.getElementById('scNewUser')?.value?.trim()?.toLowerCase();
      const newPass = document.getElementById('scNewPass')?.value || '';
      const confPass = document.getElementById('scConfPass')?.value || '';
      if (!newUser || newUser.length < 3) { mt_toast('Username must be at least 3 characters', 'error'); return; }
      if (newPass.length < 6) { mt_toast('Password must be at least 6 characters', 'error'); return; }
      if (newPass !== confPass) { mt_toast('Passwords do not match', 'error'); return; }
      try {
        const superToken = sessionStorage.getItem('fb_super_token');
        if (superToken) setAuthToken(superToken);
        await AuthAPI.changeSuperPassword(newUser, newPass, confPass);
        document.getElementById('superCredsOverlay')?.remove();
        mt_toast('Super admin credentials updated! Use new credentials next time.', 'success');
      } catch(e) {
        mt_toast(e.message || 'Failed to update credentials', 'error');
      }
    };

    // ── Station admin password change → API ───────────────────────────────
    // BUG-01 FIX: This override was promised in a comment in app.js but never written.
    // app.js saveAdminPassword() only writes SHA-256 to localStorage; every server
    // re-fetch overwrites it with the server bcrypt hash, reverting the password.
    //
    // BUG-09 FIX: APP.tenant.adminUsers[idx].id may be a local _genId() timestamp, not a
    // real PostgreSQL integer. We call TenantAPI.getAdmins() first to get the DB id, then
    // match by username to avoid a silent 0-row UPDATE.
    window.saveAdminPassword = async function() {
      const idx  = parseInt(document.getElementById('adminUserIdx')?.value);
      const pass = document.getElementById('newAdminPass')?.value || '';
      const conf = document.getElementById('confirmAdminPass')?.value || '';
      if (!pass || pass.length < 6) { toast('Password must be at least 6 characters', 'error'); return; }
      if (pass !== conf) { toast('Passwords do not match', 'error'); return; }

      const t = (typeof mt_getActiveTenant === 'function') ? mt_getActiveTenant() : null;
      if (!t) { toast('No active station — cannot change password', 'error'); return; }

      // Get the user from localStorage to know the username
      const localUser = (t.adminUsers || [])[idx];
      if (!localUser) { toast('Admin user not found', 'error'); return; }

      try {
        // BUG-09 FIX: Fetch real DB admin records to get the correct PostgreSQL id.
        // We may have a super token (from the station management overlay) or an admin token.
        // Try with the current token first; if it fails, swap to super token.
        let dbAdmins = null;
        const savedToken = getAuthToken();
        const superToken = sessionStorage.getItem('fb_super_token');

        try {
          dbAdmins = await TenantAPI.getAdmins(t.id);
        } catch (firstErr) {
          // If admin token doesn't have access, try with super token
          if (superToken && superToken !== savedToken) {
            setAuthToken(superToken);
            try {
              dbAdmins = await TenantAPI.getAdmins(t.id);
            } finally {
              // Restore original token regardless of outcome
              if (savedToken) setAuthToken(savedToken);
              else clearAuth();
            }
          } else {
            throw firstErr;
          }
        }

        if (!dbAdmins || !dbAdmins.length) {
          toast('Could not load admin user list from server', 'error');
          return;
        }

        // Match by username to get the real DB id
        const dbUser = dbAdmins.find(u =>
          u.username && localUser.username &&
          u.username.toLowerCase() === localUser.username.toLowerCase()
        );

        if (!dbUser || !dbUser.id) {
          toast('Admin user not found on server — try refreshing the page', 'error');
          return;
        }

        await TenantAPI.resetAdminPassword(t.id, dbUser.id, pass);
        if (typeof closeModal === 'function') closeModal();
        toast('Password updated successfully', 'success');
      } catch(e) {
        toast(e.message || 'Failed to update password', 'error');
      }
    };

    // ── Admin change-own-password → API ───────────────────────────────────
    // BUG-03 FIX: Restored current-password check that was missing in this override.
    // BUG-04 FIX: Now sends currentPassword to the server so the server can verify it
    // (previously, server accepted newPassword alone without verifying current — security gap).
    window.saveMyPassword = async function() {
      const curPass  = document.getElementById('curPass')?.value || '';
      const newPass  = document.getElementById('newPass')?.value || '';
      const confPass = document.getElementById('confPass')?.value || '';
      if (!curPass) { toast('Enter your current password', 'error'); return; }
      if (!newPass || newPass.length < 6) { toast('New password must be at least 6 characters', 'error'); return; }
      if (newPass !== confPass) { toast('Passwords do not match', 'error'); return; }
      if (curPass === newPass) { toast('New password must differ from current password', 'error'); return; }
      try {
        await AuthAPI.changePassword(curPass, newPass);
        if (typeof closeModal === 'function') closeModal();
        toast('Password updated successfully', 'success');
      } catch(e) {
        toast(e.message || 'Failed to update password', 'error');
      }
    };

  });

  console.log('[Bridge] Backend integration bridge loaded');
})();
