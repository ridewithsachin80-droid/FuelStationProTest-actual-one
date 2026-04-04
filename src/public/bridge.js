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

  // ── Startup: retry any blocked IndexedDB deletions from previous session ──
  // When mt_deleteTenant fires while the IDB is still open (onblocked event),
  // it writes fb_idb_delete_pending_{tenantId} to localStorage and proceeds.
  // On the very next page load (this IIFE runs before any IDB connections open),
  // we pick up those pending deletions and complete them.
  (function _retryPendingIdbDeletes() {
    try {
      var toDelete = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.startsWith('fb_idb_delete_pending_')) {
          toDelete.push(k);
        }
      }
      toDelete.forEach(function(k) {
        var tenantId = k.replace('fb_idb_delete_pending_', '');
        var dbName   = 'FuelBunkPro_' + tenantId;
        try {
          var req = indexedDB.deleteDatabase(dbName);
          req.onsuccess = function() {
            localStorage.removeItem(k);
            console.log('[Bridge] Deferred IDB delete completed:', dbName);
          };
          req.onerror = function() { localStorage.removeItem(k); };
          req.onblocked = function() {
            console.warn('[Bridge] IDB delete still blocked on load:', dbName);
            // Leave the key — will retry next load
          };
        } catch(e) { localStorage.removeItem(k); }
      });
    } catch(e) { /* localStorage unavailable — non-fatal */ }
  })();

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
    // Always clean body overlays first — they intercept clicks on rendered content
    document.querySelectorAll(
      '#modal-overlay, [id*="Overlay"], [id*="overlay"], .modal-overlay'
    ).forEach(function(el){ el.remove(); });
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

        // PERMANENT FIX: Validate the currently cached active tenant still exists
        // in the server's authoritative list. If the station was deleted and recreated
        // with the same name, a different tenant_id is generated. The browser's
        // localStorage still holds the OLD tenant_id → fetchPublicEmployees() fetches
        // employees from the old (deleted) station's DB rows — showing stale employees
        // even after clearing browser cache (cache clears cookies/files, NOT localStorage).
        //
        // Fix: if the cached active tenant_id is not in the server's list, it means
        // that station no longer exists. Wipe all localStorage state for it so the
        // user must re-select a valid station.
        try {
          const cachedActiveTenantId = localStorage.getItem('fb_active_tenant_id');
          if (cachedActiveTenantId) {
            const stillExists = tenants.some(t => String(t.id) === String(cachedActiveTenantId));
            if (!stillExists) {
              console.warn('[Bridge] Active tenant', cachedActiveTenantId, 'no longer exists on server — clearing stale localStorage state');
              // Remove all keys related to the deleted station
              const keysToRemove = [];
              for (var i = 0; i < localStorage.length; i++) {
                var k = localStorage.key(i);
                if (k && (
                  k === 'fb_active_tenant' ||
                  k === 'fb_active_tenant_id' ||
                  k.endsWith('_' + cachedActiveTenantId) ||
                  k.includes('_' + cachedActiveTenantId + '_')
                )) {
                  keysToRemove.push(k);
                }
              }
              keysToRemove.forEach(function(k) {
                try { localStorage.removeItem(k); } catch(e) {}
              });
              // Also clear window state so stale employee/lube data doesn't survive
              try {
                window._lubesProducts  = [];
                window._lubesSales     = [];
                window._rosterData     = {};
                window._attendanceData = {};
                if (typeof APP !== 'undefined') { APP.tenant = null; APP.data = null; }
              } catch(e) {}
              // Also delete the stale IndexedDB for this station
              try {
                var req = indexedDB.deleteDatabase('FuelBunkPro_' + cachedActiveTenantId);
                req.onsuccess = function() { console.log('[Bridge] Deleted stale IDB for:', cachedActiveTenantId); };
              } catch(e) {}
            }
          }
        } catch(e) { /* non-fatal — stale check failure should not break tenant load */ }

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
    const adminPass= document.getElementById('tAdminPass')?.value || '';
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
          localStorage.setItem('fb_session', typeof signData === 'function' ? signData({
            loggedIn: true, role: 'admin',
            adminUser: { name: result.userName, username: phone, role: result.userRole },
            tenant: tenantObj, token: result.token,
            timestamp: Date.now(), lastActive: Date.now()
          }) : JSON.stringify({
            loggedIn: true, role: 'admin',
            adminUser: { name: result.userName, username: phone, role: result.userRole },
            tenant: tenantObj, token: result.token,
            timestamp: Date.now(), lastActive: Date.now()
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
        localStorage.setItem('fb_session', typeof signData === 'function' ? signData({
          loggedIn: true, role: 'admin',
          adminUser: { name: result.userName, username: user, role: result.userRole },
          tenant: tenant, token: result.token,
          timestamp: Date.now(), lastActive: Date.now()
        }) : JSON.stringify({
          loggedIn: true, role: 'admin',
          adminUser: { name: result.userName, username: user, role: result.userRole },
          tenant: tenant, token: result.token,
          timestamp: Date.now(), lastActive: Date.now()
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
        localStorage.setItem('fb_session', typeof signData === 'function' ? signData({
          loggedIn: true, role: 'admin', adminUser: APP.adminUser,
          tenant: tenant, token: result.token,
          timestamp: Date.now(), lastActive: Date.now()
        }) : JSON.stringify({
          loggedIn: true, role: 'admin', adminUser: APP.adminUser,
          tenant: tenant, token: result.token,
          timestamp: Date.now(), lastActive: Date.now()
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
      const raw = localStorage.getItem('fb_session');
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
    localStorage.removeItem('fb_session');
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
      localStorage.removeItem('fb_session');
      document.cookie = 'sa_entry=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Strict';
      clearAuth();
      if (typeof APP !== 'undefined') { APP.tenant = null; APP.loggedIn = false; APP.role = null; APP.adminUser = null; }
      // Remove the fixed selector panel + all overlays
      var _sp = document.getElementById('stationSelectorPanel');
      if (_sp) _sp.remove();
      document.querySelectorAll('[id*="Overlay"],[id*="overlay"],[id*="Modal"],[id*="billing"],[id*="compare"]')
        .forEach(function(el){ el.remove(); });
      // Call the original mt_showSelector directly — re-renders app.innerHTML fresh.
      // With tokens cleared, isSuperLoggedIn()=false → shows login form (not logout button).
      var _origSel = window._origShowSelectorForLanding;
      if (typeof _origSel === 'function') _origSel();
      else if (typeof mt_showSelector === 'function') mt_showSelector();
      else window.location.reload();
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
        // ROOT-CAUSE FIX: Await IndexedDB deletion before proceeding.
        // The previous fire-and-forget indexedDB.deleteDatabase() returned immediately
        // without waiting for the actual deletion to complete. If the DB was still open
        // (e.g. another tab, or the current page still held a connection), the request
        // would fire the 'onblocked' event and the database would remain intact until
        // all connections closed. On station recreate with the same tenant_id, loadData()
        // then read the old IDB data (employees, lubes_products, lubes_sales from March 16)
        // and wrote it back to the server settings table — making stale data reappear.
        //
        // Fix: wrap in a Promise that resolves on success, error, OR blocked (blocked means
        // the current page holds a connection — we still proceed; the IDB will be deleted
        // once the page reloads and the connection is released).
        try {
          const dbName = 'FuelBunkPro_' + id;
          await new Promise(function(resolve) {
            try {
              const req = indexedDB.deleteDatabase(dbName);
              req.onsuccess = function() {
                console.log('[mt_deleteTenant] IndexedDB deleted:', dbName);
                resolve();
              };
              req.onerror = function(ev) {
                console.warn('[mt_deleteTenant] IndexedDB delete error:', ev.target?.error?.message);
                resolve(); // non-fatal — proceed with deletion
              };
              req.onblocked = function() {
                // DB still open in this tab — will be deleted on next page load.
                // Mark it for cleanup so the next loadData() skips it.
                console.warn('[mt_deleteTenant] IndexedDB delete blocked (open connections) — will complete on reload:', dbName);
                try { localStorage.setItem('fb_idb_delete_pending_' + id, '1'); } catch(e) {}
                resolve(); // proceed — IDB cleanup happens on reload
              };
            } catch(e) {
              console.warn('[mt_deleteTenant] indexedDB.deleteDatabase threw:', e.message);
              resolve();
            }
          });
        } catch(e) { console.warn('[mt_deleteTenant] IndexedDB cleanup error:', e.message); }

        // Clear ALL in-memory window state for the deleted station so stale data
        // cannot survive in the current page session. This prevents employees,
        // lube products, roster, attendance etc. from the old station appearing
        // if the super admin navigates to a newly recreated station in the same session.
        try {
          window._lubesProducts   = [];
          window._lubesSales      = [];
          window._rosterData      = {};
          window._attendanceData  = {};
          window._payrollSaved    = {};
          window._billingData     = null;
          window._nozzleMeterLog  = [];
          window._bankReconData   = {};
          if (typeof APP !== 'undefined') APP.data = null;
          console.log('[mt_deleteTenant] Cleared in-memory window state for station:', id);
        } catch(e) { /* non-fatal */ }

        const active = (typeof mt_getActiveTenant === 'function') ? mt_getActiveTenant() : null;
        if (active && active.id === id) {
          if (typeof mt_clearActiveTenant === 'function') mt_clearActiveTenant();
          // Clear ALL stale localStorage data for this station
          const keySuffixes = ['fb_emp_cache', 'fb_emp_pins', 'fb_emp_session', 'fb_emp_history',
                               'fb_data_snapshot', 'fb_api_cache', 'fb_active_tenant_id'];
          keySuffixes.forEach(function(key) {
            try { localStorage.removeItem(key); } catch(e) {}
            try { localStorage.removeItem(key + '_' + id); } catch(e) {}
          });
        }
        // Also clear the global tenant_id cache if it matches deleted station
        const cachedId = localStorage.getItem('fb_active_tenant_id');
        if (cachedId === id) localStorage.removeItem('fb_active_tenant_id');

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
      const adminPass = document.getElementById('tAdminPass')?.value || '';
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
            localStorage.setItem('fb_session', typeof signData === 'function' ? signData({ loggedIn:true, role:'admin', adminUser:{name:result.userName, username:phone, role:result.userRole}, tenant:tenantObj, token:result.token, timestamp:Date.now(), lastActive:Date.now() }) : JSON.stringify({ loggedIn:true, role:'admin', adminUser:{name:result.userName, username:phone, role:result.userRole}, tenant:tenantObj, token:result.token, timestamp:Date.now(), lastActive:Date.now() }));
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
          localStorage.setItem('fb_session', typeof signData === 'function' ? signData({ loggedIn:true, role:'admin', adminUser:{name:result.userName, username:user, role:result.userRole}, tenant, token:result.token, timestamp:Date.now(), lastActive:Date.now() }) : JSON.stringify({ loggedIn:true, role:'admin', adminUser:{name:result.userName, username:user, role:result.userRole}, tenant, token:result.token, timestamp:Date.now(), lastActive:Date.now() }));
          if (typeof APP !== 'undefined') { APP.loggedIn=true; APP.role='admin'; APP.adminUser={name:result.userName, username:user, role:result.userRole}; APP.tenant=tenant; }
          window.db = new FuelDB('FuelBunkPro_' + tenant.id);
          if (typeof loadData === 'function') {
            try {
              await Promise.race([
                loadData(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('loadData timeout 20s')), 20000))
              ]);
            } catch(e) { console.warn('[Bridge] loadData:', e.message); }
          }
          if (typeof enterApp === 'function') enterApp();
          if (typeof toast === 'function') toast('Welcome, ' + result.userName, 'success');
        }
      } catch(e) { if(typeof toast==='function') toast(e.message||'Invalid credentials','error'); }
    };

    // ── Session restore (uses sessionStorage + API token) ─────────────────
    window.loadSession = function() {
      try {
        const raw = localStorage.getItem('fb_session');
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
      _bioLock.reset(); // FIX 4: always reset on logout
      try { await AuthAPI.logout(); } catch {}
      if (typeof APP !== 'undefined') {
        APP.loggedIn = false; APP.role = null; APP.adminUser = null; APP.data = null;
      }
      localStorage.removeItem('fb_session');
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

  // ══════════════════════════════════════════════════════════════════
  // ── WebAuthn Biometric — Frontend Logic ──────────────────────────
  // Handles biometric registration after login and biometric prompt
  // on app open when a saved credential exists on the device.
  // ══════════════════════════════════════════════════════════════════

  // BUG-05 FIX: Use sessionStorage for WebAuthn credential IDs.
  // localStorage persists across browser restarts, making the credential ID
  // readable by any JS running in the page (XSS) and by anyone with physical
  // access who opens DevTools after the browser has been closed. sessionStorage
  // is wiped when the tab closes, limiting the exposure window significantly.
  const WA_CRED_KEY    = 'fb_wa_cred'; // sessionStorage key for saved credential ID
  const WA_TENANT_KEY  = 'fb_wa_tid';  // sessionStorage key for tenant ID

  // ── Unlock state ─────────────────────────────────────────────────────────
  // BUG-07 FIX: Wrap the unlock flag in a closure object so it cannot be
  // trivially set to `true` from DevTools / a bookmarklet by name.
  // Note: this remains a UX gate, not a security boundary — the real
  // security control is the server-side Bearer token validated on every request.
  const _bioLock = (() => {
    let _unlocked = false;
    return {
      get:   ()    => _unlocked,
      set:   (val) => { _unlocked = !!val; },
      reset: ()    => { _unlocked = false; },
    };
  })();
  let _hiddenAt      = null;
  const RELOCK_AFTER = 60 * 1000; // re-lock after 60 s in background

  function _b64urlToBuffer(b64) {
    const b64std = b64.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64std);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr.buffer;
  }
  function _bufferToB64url(buf) {
    const arr = new Uint8Array(buf);
    let bin = '';
    arr.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  // ── Check if WebAuthn is supported on this device ─────────────────────────
  function _webauthnAvailable() {
    return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  }

  // ── After successful password login: offer biometric registration ─────────
  // Called from within bridge.js login success paths
  async function _offerBiometricSetup(token, tenantId, userName) {
    if (!_webauthnAvailable()) return;
    if (!token) return;

    // Don't ask again if already registered on this device
    const existingCred = sessionStorage.getItem(WA_CRED_KEY);
    if (existingCred) return;

    // Small delay so the welcome toast shows first
    await new Promise(r => setTimeout(r, 1500));

    // FIX 5: Use an in-app modal instead of confirm().
    // confirm() is BLOCKED by Chrome on Android when the app is installed as a
    // standalone PWA — it silently returns false, so biometric setup was never
    // offered to home-screen users. This bottom-sheet works in all modes.
    const wantsSetup = await new Promise(function(resolve) {
      var sheet = document.createElement('div');
      sheet.id = 'fb-bio-offer-sheet';
      sheet.style.cssText = [
        'position:fixed;inset:0;z-index:999998',
        'background:rgba(0,0,0,0.65)',
        'display:flex;align-items:flex-end;justify-content:center',
        'animation:fb-fade-in 0.2s ease'
      ].join(';');
      // Inject keyframe once
      if (!document.getElementById('fb-bio-anim')) {
        var style = document.createElement('style');
        style.id = 'fb-bio-anim';
        style.textContent = '@keyframes fb-fade-in{from{opacity:0}to{opacity:1}}' +
          '@keyframes fb-slide-up{from{transform:translateY(100%)}to{transform:translateY(0)}}';
        document.head.appendChild(style);
      }
      sheet.innerHTML =
        '<div style="' +
          'background:#161b27;border-radius:20px 20px 0 0;' +
          'padding:28px 24px 36px;width:100%;max-width:440px;box-sizing:border-box;' +
          'animation:fb-slide-up 0.25s ease' +
        '">' +
          '<div style="font-size:32px;margin-bottom:12px">🔐</div>' +
          '<div style="font-size:17px;font-weight:700;color:#f4f5f7;margin-bottom:8px">Enable biometric login?</div>' +
          '<div style="font-size:13px;color:#9498a5;line-height:1.6;margin-bottom:22px">' +
            'Next time you open the app, use your fingerprint, face, or screen PIN — no password needed.' +
          '</div>' +
          '<button id="fb-bio-offer-yes" style="' +
            'width:100%;background:#d4940f;color:#000;border:none;' +
            'padding:14px;border-radius:10px;font-size:15px;font-weight:700;' +
            'margin-bottom:10px;cursor:pointer' +
          '">Set Up Now</button>' +
          '<button id="fb-bio-offer-no" style="' +
            'width:100%;background:transparent;color:#9498a5;border:none;' +
            'padding:10px;font-size:13px;cursor:pointer' +
          '">Not Now</button>' +
        '</div>';
      document.body.appendChild(sheet);
      document.getElementById('fb-bio-offer-yes').onclick = function() { sheet.remove(); resolve(true); };
      document.getElementById('fb-bio-offer-no').onclick  = function() { sheet.remove(); resolve(false); };
    });
    if (!wantsSetup) return;

    try {
      // Get registration options from server
      const options = await AuthAPI.webauthnRegisterOptions();

      // Convert base64url strings to ArrayBuffers for the browser API
      const publicKey = {
        ...options,
        challenge: _b64urlToBuffer(options.challenge),
        user: { ...options.user, id: _b64urlToBuffer(options.user.id) },
        excludeCredentials: (options.excludeCredentials || []).map(c => ({
          ...c, id: _b64urlToBuffer(c.id)
        }))
      };

      // Trigger device biometric / PIN prompt
      const credential = await navigator.credentials.create({ publicKey });

      // Serialize the credential for sending to server
      const credData = {
        id: credential.id,
        rawId: _bufferToB64url(credential.rawId),
        type: credential.type,
        response: {
          clientDataJSON: _bufferToB64url(credential.response.clientDataJSON),
          attestationObject: _bufferToB64url(credential.response.attestationObject)
        }
      };

      const result = await AuthAPI.webauthnRegister(credData, 'My Device');

      if (result.success) {
        // Save credential ID locally for next app open
        sessionStorage.setItem(WA_CRED_KEY, credential.id);
        sessionStorage.setItem(WA_TENANT_KEY, tenantId);
        if (typeof toast === 'function') toast('✅ Biometric login enabled! Use it next time.', 'success');
      }
    } catch (e) {
      // User cancelled or device doesn't support it — silently ignore
      if (e.name !== 'NotAllowedError') {
        console.warn('[WebAuthn] Registration failed:', e.message);
      }
    }
  }

  // ── On app open: attempt biometric login if credential saved on device ────
  // Called from initApp before showing login screen
  async function _attemptBiometricLogin() {
    if (!_webauthnAvailable()) return false;

    const credentialId = sessionStorage.getItem(WA_CRED_KEY);
    const tenantId = sessionStorage.getItem(WA_TENANT_KEY);
    if (!credentialId || !tenantId) return false;

    try {
      // Get auth challenge from server
      const options = await AuthAPI.webauthnAuthOptions(credentialId, tenantId);
      if (!options.challenge) return false;

      const publicKey = {
        challenge: _b64urlToBuffer(options.challenge),
        timeout: options.timeout || 60000,
        rpId: options.rpId,
        allowCredentials: (options.allowCredentials || []).map(c => ({
          ...c, id: _b64urlToBuffer(c.id)
        })),
        userVerification: options.userVerification || 'required'
      };

      // This triggers the device biometric / PIN / pattern prompt
      const assertion = await navigator.credentials.get({ publicKey });

      const assertionData = {
        id: assertion.id,
        rawId: _bufferToB64url(assertion.rawId),
        type: assertion.type,
        response: {
          clientDataJSON: _bufferToB64url(assertion.response.clientDataJSON),
          authenticatorData: _bufferToB64url(assertion.response.authenticatorData),
          signature: _bufferToB64url(assertion.response.signature),
          userHandle: assertion.response.userHandle ? _bufferToB64url(assertion.response.userHandle) : null
        }
      };

      // Send to server for verification
      const result = await AuthAPI.webauthnAuthenticate(assertionData, tenantId);

      if (result.success && result.token) {
        // Full login — same as password login flow
        setAuthToken(result.token);
        const tenantObj = {
          id: result.tenantId, name: result.tenantName,
          location: result.tenantLocation || '',
          icon: result.tenantIcon || '⛽',
          color: '#d4940f', colorLight: '#f0b429', active: true
        };
        if (typeof mt_setActiveTenant === 'function') mt_setActiveTenant(tenantObj);
        localStorage.setItem('fb_session', typeof signData === 'function' ? signData({
          loggedIn: true, role: 'admin',
          adminUser: { name: result.userName, role: result.userRole },
          tenant: tenantObj, token: result.token,
          timestamp: Date.now(), lastActive: Date.now()
        }) : JSON.stringify({
          loggedIn: true, role: 'admin',
          adminUser: { name: result.userName, role: result.userRole },
          tenant: tenantObj, token: result.token,
          timestamp: Date.now(), lastActive: Date.now()
        }));
        if (typeof APP !== 'undefined') {
          APP.loggedIn = true; APP.role = 'admin';
          APP.adminUser = { name: result.userName, role: result.userRole };
          APP.tenant = tenantObj;
        }
        window.db = new FuelDB('FuelBunkPro_' + result.tenantId);
        setTenantId(result.tenantId);
        if (typeof loadData === 'function') {
          try { await loadData(); } catch(e) { console.warn('[WebAuthn] loadData:', e.message); }
        }
        _bioLock.set(true); // ← must be true BEFORE enterApp() so the wrap passes through
        if (typeof enterApp === 'function') enterApp();
        if (typeof toast === 'function') toast('👋 Welcome, ' + result.userName, 'success');
        return true;
      }
    } catch (e) {
      if (e.name === 'NotAllowedError') {
        // User dismissed or timed out — show a gentle hint and fall through to password login
        console.log('[WebAuthn] Biometric cancelled by user — showing password login');
        if (typeof toast === 'function') toast('Biometric cancelled — enter your password to log in', 'info');
      } else if (e.name === 'SecurityError') {
        // rpId mismatch or insecure context — clear stored credential and inform user
        console.warn('[WebAuthn] SecurityError (rpId mismatch or HTTP?) — clearing credential:', e.message);
        sessionStorage.removeItem(WA_CRED_KEY);
        sessionStorage.removeItem(WA_TENANT_KEY);
        if (typeof toast === 'function') toast('Biometric login unavailable on this connection — please log in with your password', 'warning');
      } else if (e.name === 'InvalidStateError' || e.name === 'NotFoundError') {
        // Credential no longer valid on this device — clear it and show password login
        console.warn('[WebAuthn] Credential invalid — clearing:', e.message);
        sessionStorage.removeItem(WA_CRED_KEY);
        sessionStorage.removeItem(WA_TENANT_KEY);
        if (typeof toast === 'function') toast('Biometric session expired — please log in with your password to re-enable it', 'info');
      } else {
        console.warn('[WebAuthn] Auth failed:', e.name, e.message);
        if (typeof toast === 'function') toast('Biometric failed — please log in with your password', 'warning');
      }
    }
    return false;
  }

  // ── Expose biometric functions globally for use in app.js / admin.js ──────
  window._attemptBiometricLogin = _attemptBiometricLogin;
  window._offerBiometricSetup   = _offerBiometricSetup;
  window._webauthnAvailable     = _webauthnAvailable;

  // ══════════════════════════════════════════════════════════════════════════
  // ── Biometric Lock Screen UI ───────────────────────────────────────────
  // A full-screen overlay shown when biometric verification is required.
  // Matches the app's dark splash theme (#0a0c10 bg, #d4940f gold accent).
  // opts.onSuccess  : called after successful biometric (overlay already gone)
  // opts.onFallback : called when user taps "Use Password Instead"
  // ══════════════════════════════════════════════════════════════════════════
  function _showBiometricLockScreen(opts) {
    opts = opts || {};

    // Never stack two lock screens
    if (document.getElementById('fb-bio-lock')) return;

    const tenantName = (typeof APP !== 'undefined' && APP.tenant && APP.tenant.name)
      ? APP.tenant.name : 'FuelBunk Pro';

    const overlay = document.createElement('div');
    overlay.id = 'fb-bio-lock';
    overlay.style.cssText = [
      'position:fixed;inset:0;z-index:999999',
      'background:#0a0c10',
      'display:flex;flex-direction:column;align-items:center;justify-content:center',
      'gap:16px;padding:32px;box-sizing:border-box',
      'font-family:inherit'
    ].join(';');

    overlay.innerHTML =
      '<div style="font-size:52px">⛽</div>' +
      '<div style="font-size:20px;font-weight:800;color:#f4f5f7;letter-spacing:-0.5px">' + tenantName + '</div>' +
      '<div style="font-size:13px;color:#9498a5;text-align:center;max-width:260px;line-height:1.6">' +
        'App locked — verify your identity to continue' +
      '</div>' +
      '<button id="fb-bio-btn" style="' +
        'margin-top:8px;background:#d4940f;color:#000;border:none;' +
        'padding:14px 36px;border-radius:12px;font-size:16px;font-weight:700;' +
        'cursor:pointer;display:flex;align-items:center;gap:8px;' +
      '">🔐 Unlock with Biometric</button>' +
      '<button id="fb-bio-pw-btn" style="' +
        'background:transparent;color:#9498a5;border:1px solid #2a2f3e;' +
        'padding:10px 24px;border-radius:10px;font-size:13px;font-weight:600;' +
        'cursor:pointer;' +
      '">Use Password Instead</button>' +
      '<div id="fb-bio-status" style="font-size:12px;color:#9498a5;min-height:18px;text-align:center"></div>';

    document.body.appendChild(overlay);

    function dismiss() {
      var el = document.getElementById('fb-bio-lock');
      if (el) el.remove();
    }

    async function doUnlock() {
      var btn    = document.getElementById('fb-bio-btn');
      var status = document.getElementById('fb-bio-status');
      if (btn)    { btn.disabled = true; btn.textContent = '⏳ Waiting for biometric...'; }
      if (status) { status.textContent = ''; }

      var ok = await _attemptBiometricLogin();

      if (ok) {
        // _bioLock was set true inside _attemptBiometricLogin.
        // enterApp() was also already called there — dismiss overlay and done.
        dismiss();
        if (opts.onSuccess) opts.onSuccess();
        return;
      }

      // Biometric failed or was cancelled — let user retry or fall back
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '🔐 Try Again';
      }
      if (status) { status.textContent = 'Could not verify — tap to retry'; }
    }

    document.getElementById('fb-bio-btn').addEventListener('click', doUnlock);

    document.getElementById('fb-bio-pw-btn').addEventListener('click', function() {
      dismiss();
      _bioLock.reset();
      if (opts.onFallback) {
        opts.onFallback();
      } else {
        // Default: clear session and show the original password login screen
        if (typeof clearSession === 'function') clearSession();
        if (typeof clearAuth    === 'function') clearAuth();
        if (typeof showLoginScreen === 'function') showLoginScreen();
      }
    });

    // BUG-09 FIX: Use double requestAnimationFrame instead of a hardcoded 400ms
    // delay. rAF fires after the browser has committed the current frame to the
    // screen, so the lock-screen overlay is guaranteed to be visible before the
    // biometric prompt appears — regardless of device speed.
    requestAnimationFrame(() => requestAnimationFrame(doUnlock));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ── Apply all patches after DOMContentLoaded ──────────────────────────
  // CRITICAL: deferred so every script (app.js, employee.js, multitenant.js)
  // has fully executed and placed its globals on window before we wrap them.
  // ══════════════════════════════════════════════════════════════════════════
  function _applyBiometricPatches() {

    // Capture originals before patching
    var _origEnterApp        = window.enterApp;
    var _origShowLoginScreen = window.showLoginScreen;
    var _origAppLogout       = window.appLogout;

    // ── PATCH 1 (THE CORE FIX): wrap enterApp ──────────────────────────────
    // THE ROOT CAUSE: initApp() calls loadSession() first. When a valid session
    // exists it goes straight to enterApp() — showLoginScreen() is NEVER called.
    // The previous fix only hooked showLoginScreen, so biometric was completely
    // skipped every time the app opened with a valid session.
    // FIX: intercept enterApp itself. If a biometric credential is saved and
    // _bioLock is still false, show the lock screen before entering.
    if (typeof _origEnterApp === 'function') {
      window.enterApp = function() {
        var credentialId = sessionStorage.getItem(WA_CRED_KEY);
        if (credentialId && _webauthnAvailable() && !_bioLock.get()) {
          // Show lock screen — it will call _attemptBiometricLogin(), which on
          // success sets _bioLock to true then calls enterApp() again.
          // That second call will see _bioLock.get() as true and pass through.
          _showBiometricLockScreen({
            onFallback: function() {
              // User chose password — clear session and show original login form
              if (typeof clearSession === 'function') clearSession();
              if (typeof clearAuth    === 'function') clearAuth();
              if (typeof _origShowLoginScreen === 'function') _origShowLoginScreen();
            }
          });
          return; // do NOT enter app yet
        }
        // Unlocked (or no biometric set up) — enter normally
        return _origEnterApp.apply(this, arguments);
      };
    }

    // ── PATCH 2: wrap ALL password login entry points ──────────────────────
    // BUG-1 FIX: The HTML form calls doAdminLogin() (not appLogin). Both must
    // be wrapped so that any successful password login sets _bioLock to true
    // BEFORE enterApp() is called, preventing the lock screen from firing immediately
    // after a deliberate password login.
    function _wrapLoginFn(fnName) {
      var orig = window[fnName];
      if (typeof orig !== 'function') return;
      window[fnName] = async function() {
        var tokenBefore = localStorage.getItem('_fb_auth_token');
        await orig.apply(this, arguments);
        var tokenAfter = localStorage.getItem('_fb_auth_token');
        if (tokenAfter && tokenAfter !== tokenBefore) {
          // A new token was issued → login succeeded → mark device as unlocked
          _bioLock.set(true);
          var sess = JSON.parse(localStorage.getItem('fb_session') || '{}');
          _offerBiometricSetup(tokenAfter, sess.tenant && sess.tenant.id, sess.adminUser && sess.adminUser.name);
        }
      };
    }
    _wrapLoginFn('doAdminLogin'); // called by HTML button onclick="doAdminLogin()"
    _wrapLoginFn('appLogin');     // called programmatically in some paths

    // ── PATCH 3: wrap showLoginScreen — biometric-first for expired-session path ──
    // Covers the case where session has fully expired (8-hour idle or 30-day max).
    // In that case initApp() does call showLoginScreen(), so we still hook it here
    // as a secondary safety net.
    if (typeof _origShowLoginScreen === 'function') {
      window.showLoginScreen = async function() {
        if (typeof APP !== 'undefined' && APP.loggedIn) {
          return _origShowLoginScreen.apply(this, arguments);
        }
        var credentialId = sessionStorage.getItem(WA_CRED_KEY);
        if (credentialId && _webauthnAvailable()) {
          var tried = await _attemptBiometricLogin();
          if (tried) return;
        }
        return _origShowLoginScreen.apply(this, arguments);
      };
    }

    // ── PATCH 4: wrap appLogout — reset unlock state ────────────────────────
    if (typeof _origAppLogout === 'function' && !_origAppLogout._bioWrapped) {
      window.appLogout = async function() {
        _bioLock.reset();
        return _origAppLogout.apply(this, arguments);
      };
      window.appLogout._bioWrapped = true;
    }

    // ── PATCH 5: visibilitychange — re-lock when PWA returns from background ──
    // On mobile, opening a PWA from the home screen or app switcher does NOT fire
    // DOMContentLoaded — the page is already loaded. Instead, the browser fires
    // visibilitychange (hidden → visible). We track how long the app was hidden:
    // if it exceeds the threshold and the user is logged in with biometric set up,
    // we show the lock screen again.
    //
    // FIX 6: Use a shorter threshold (60 s) only in standalone PWA mode.
    // In regular browser tabs use 5 minutes to avoid locking desktop users who
    // briefly switch tabs.
    var _isStandalonePWA = window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
    var _relockThreshold = _isStandalonePWA ? RELOCK_AFTER : 5 * 60 * 1000;

    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'hidden') {
        // FIX 7: Don't record hide time if lock screen already showing
        if (!document.getElementById('fb-bio-lock')) {
          _hiddenAt = Date.now();
        }
        return;
      }
      // App became visible
      if (!_hiddenAt) return;
      var elapsed = Date.now() - _hiddenAt;
      _hiddenAt = null;

      if (elapsed < _relockThreshold) return;

      var credentialId = sessionStorage.getItem(WA_CRED_KEY);
      var isLoggedIn   = typeof APP !== 'undefined' && APP.loggedIn;
      if (!isLoggedIn || !credentialId || !_webauthnAvailable()) return;

      // Enough time has passed — re-lock
      _bioLock.reset();
      _showBiometricLockScreen({
        // onSuccess: overlay dismissed, app already running — nothing else needed
        onFallback: function() {
          // User wants to re-authenticate via password — log them out
          if (typeof appLogout === 'function') appLogout();
        }
      });
    });

    console.log('[Bridge] Biometric patches applied — enterApp intercepted, visibilitychange armed');
  }

  // Defer until all bottom-of-body scripts have executed
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _applyBiometricPatches, { once: true });
  } else {
    _applyBiometricPatches();
  }

  // ── Manage biometric credentials (exposed for Settings page) ─────────────
  window.removeBiometricCredential = async function() {
    const credentialId = sessionStorage.getItem(WA_CRED_KEY);
    if (!credentialId) { if(typeof toast==='function') toast('No biometric set up on this device', 'info'); return; }
    try {
      const list = await AuthAPI.webauthnCredentials();
      const match = (list.credentials || []).find(c => c.credential_id === credentialId);
      if (match) await AuthAPI.webauthnRemoveCredential(match.id);
      sessionStorage.removeItem(WA_CRED_KEY);
      sessionStorage.removeItem(WA_TENANT_KEY);
      if(typeof toast==='function') toast('Biometric login removed from this device', 'success');
    } catch(e) {
      sessionStorage.removeItem(WA_CRED_KEY);
      sessionStorage.removeItem(WA_TENANT_KEY);
      if(typeof toast==='function') toast('Biometric login removed', 'success');
    }
  };

  // BUG-10 FIX: Validate the session token with the server before triggering the
  // device biometric prompt. Previously, an expired token in localStorage would
  // still initiate credentials.create() — the user sees the OS biometric dialog,
  // the sensor fires, then the server rejects the credential with a confusing error.
  // Now we verify first; if the token is expired we redirect to password login.
  window.setupBiometricNow = async function() {
    const token = localStorage.getItem('_fb_auth_token');
    const sess  = JSON.parse(localStorage.getItem('fb_session') || '{}');
    if (!token || !sess.tenant?.id) {
      if (typeof toast === 'function') toast('Please log in first', 'error');
      return;
    }
    try {
      // Lightweight server-side token check before touching the authenticator
      const check = await fetch('/api/auth/session', {
        headers: { Authorization: 'Bearer ' + token }
      });
      if (!check.ok) {
        if (typeof toast === 'function') toast('Session expired — please log in again to set up biometrics', 'warning');
        if (typeof showLoginScreen === 'function') showLoginScreen();
        return;
      }
    } catch(e) {
      // Network error — proceed optimistically; the register call will fail if token is bad
      console.warn('[setupBiometricNow] Session check failed (offline?):', e.message);
    }
    _offerBiometricSetup(token, sess.tenant.id, sess.adminUser?.name);
  };

  console.log('[Bridge] Backend integration bridge loaded');
})();
