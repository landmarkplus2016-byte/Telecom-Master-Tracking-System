// ============================================================
// app.js — App init and routing
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Entry point: called last after all modules are loaded
//   - Check for existing session (sessionStorage) on reload
//   - Route to: setup screen → login screen → main app
//   - Wire toolbar buttons (role-gated)
//   - Show / hide screens
//
// This is a Stage 1 stub. Expand in later stages as each
// module (grid, filters, backup, etc.) is built out.
// ============================================================

(function () {

  // ── Init ──────────────────────────────────────────────────

  function init() {
    console.log('[app.js] init() — starting');

    // If a session already exists (page reload within same tab),
    // skip login and go straight to the app.
    var name = sessionStorage.getItem('app_name');
    var role = sessionStorage.getItem('app_role');

    var code = sessionStorage.getItem('app_code');
    if (name && role && code) {
      console.log('[app.js] Session found — name:', name, 'role:', role);
      _showApp(name, role);
      return;
    }

    // Session incomplete (missing code) — clear and re-login
    if (name || role) {
      console.log('[app.js] Incomplete session — clearing and re-authenticating');
      sessionStorage.clear();
    }

    console.log('[app.js] No session — handing off to Auth.init()');

    // No session → Auth handles setup-screen-or-login routing
    Auth.init(function onLoginSuccess(name, role) {
      console.log('[app.js] Login success — name:', name, 'role:', role);
      _showApp(name, role);
    });
  }

  // ── Show main app ─────────────────────────────────────────

  function _showApp(name, role) {
    console.log('[app.js] _showApp() — role:', role);

    // Hide loading screen
    _hide('screen-loading');

    // Render app chrome (logo + role badge in header)
    _renderHeader(name, role);

    // Show the main app screen
    _show('screen-app');

    // Open IndexedDB first — needed for offline startup fallback and
    // for the sync queue to function. Callback is fast (< 50 ms typically).
    Offline.init(function () {

      // Fetch price config + dropdowns first, then init grid, then load rows.
      // Order matters: dropdowns and pricing must be ready before Grid.init
      // so that column sources are wired correctly on first render.
      _setLoadingStatus('Loading config\u2026');
      Sheets.fetchConfig(function (configResult) {
        if (configResult.success) {
          Pricing.init(configResult);
          Grid.applyDropdowns(configResult.dropdowns || {}, configResult.priceList || []);
        } else {
          // Non-fatal: both modules degrade gracefully with no config data
          console.warn('[app.js] fetchConfig failed:', configResult.error, '— pricing + dropdowns disabled');
          Pricing.init(null);
          Grid.applyDropdowns({}, []);
        }

        // Init grid AFTER dropdowns are loaded so column sources are set
        Grid.init(role, name);

        // Wire reconciliation panel — invoicing + manager only
        if (typeof Reconcile !== 'undefined') {
          Reconcile.init(role, name);
          Reconcile.wireToolbarButton();
        }

        // Start presence heartbeat — fires immediately then every 30 s.
        // Must come after Grid.init so the logout button (inserted by
        // _renderHeader) already exists in #presence-bar when the first
        // avatar cluster is created.
        //
        // The onChanges callback triggers an immediate delta sync when the
        // manager's heartbeat returns new coordinator saves. Without this,
        // the manager's grid only updates on the 2-minute background tick.
        Sheets.startPresence(name, function _onCoordinatorChanges() {
          if (role !== 'manager') return;
          var since = Offline.getLastSyncTime();
          if (since) _runDeltaSync(since);
        });

        // ── Offline startup: skip network fetch, load from IDB ──────
        if (!navigator.onLine) {
          _setLoadingStatus('Loading from cache\u2026');
          Offline.getAllRows(function (cachedRows) {
            _hide('screen-loading');
            if (cachedRows.length) {
              console.log('[app.js] Offline — loaded', cachedRows.length, 'rows from cache');
              Grid.loadData(cachedRows);
            } else {
              _showError('You are offline and no cached data is available. Connect to the internet and reload.');
            }
          });
          return;
        }

        // ── Always do a full fetch on startup ──────────────────────
        // Delta sync cannot detect rows deleted directly from Google Sheets,
        // so the IDB cache can drift silently if rows are removed outside the app.
        // Full fetch on every startup ensures the cache always mirrors the sheet.
        // Delta sync is still used for background polling (every 30 s) where
        // a missing row is less critical than on initial load.
        //
        // If the network call fails, fall back to IDB cache so the app still
        // works for read/offline use.
        _setLoadingStatus('Loading data\u2026');
        Sheets.fetchAllRows(function (result) {
          _hide('screen-loading');
          if (!result.success) {
            console.error('[app.js] fetchAllRows failed:', result.error);
            Offline.getAllRows(function (cachedRows) {
              if (cachedRows.length) {
                console.warn('[app.js] fetchAllRows failed — showing', cachedRows.length, 'cached rows');
                Grid.loadData(cachedRows);
                _startBackgroundSync();
              } else {
                _showError('Could not load data: ' + result.error);
              }
            });
            return;
          }
          console.log('[app.js] startup fetch — rows received:', result.rows.length);
          // replaceAllRows clears IDB before writing so deleted-from-sheet rows
          // never survive as phantoms in the local cache.
          Offline.replaceAllRows(result.rows);
          Offline.setLastSyncTime(result.serverTime);

          // Re-inject any pending new rows from the queue so they stay
          // visible in the grid while waiting for the drain to complete.
          // This handles the case where the user was offline at previous
          // startup, added rows, then reloaded while online.
          Offline.getPendingQueue(function (queueEntries) {
            var pendingNew = queueEntries
              .filter(function (e) { return e.rowData && !e.rowData._row_index; })
              .map(function (e) { return e.rowData; });
            if (pendingNew.length) {
              console.log('[app.js] startup — re-injecting', pendingNew.length, 'pending new row(s) from queue');
            }
            Grid.loadData(result.rows.concat(pendingNew));
            _startBackgroundSync();
          });
        });
      });
    });
  }

  // ── Delta sync ────────────────────────────────────────────
  //
  // Fetches rows changed since `since` (epoch-ms), skips any row that
  // has a pending local edit in the queue, merges the rest into IDB
  // and the grid, and advances the sync cursor.
  //
  // cb is optional — called when done (success or failure).

  function _runDeltaSync(since, cb) {
    Sheets.fetchDelta(since, function (result) {
      if (!result.success) {
        console.warn('[app.js] delta sync failed:', result.error);
        if (cb) cb();
        return;
      }

      var changed = result.rows || [];
      console.log('[app.js] delta sync — server returned', changed.length, 'changed rows');

      if (!changed.length) {
        Offline.setLastSyncTime(result.serverTime);
        if (cb) cb();
        return;
      }

      // Skip rows that have pending local edits to avoid overwriting them
      Offline.getPendingRowIndexes(function (pendingMap) {
        var toApply = changed.filter(function (r) {
          return !pendingMap[String(r._row_index)];
        });

        if (toApply.length) {
          Offline.storeRows(toApply);
          Grid.applyDelta(toApply);
          console.log('[app.js] delta sync applied', toApply.length, 'rows;',
            changed.length - toApply.length, 'skipped (pending local edits)');
        }

        Offline.setLastSyncTime(result.serverTime);
        if (cb) cb();
      });
    });
  }

  // ── Background sync timer ─────────────────────────────────
  //
  // Polls for changes every BACKGROUND_SYNC_INTERVAL_MS while the
  // app is open. Only runs when the tab is visible and the device
  // is online — skips silently otherwise.

  var BACKGROUND_SYNC_INTERVAL_MS = 30 * 1000; // 30 seconds
  var _bgSyncTimer = null;

  function _startBackgroundSync() {
    if (_bgSyncTimer) return; // already running
    _bgSyncTimer = setInterval(function () {
      if (!navigator.onLine) return;
      if (document.hidden)   return;
      var since = Offline.getLastSyncTime();
      if (!since) return;
      console.log('[app.js] background sync tick');
      _runDeltaSync(since);
    }, BACKGROUND_SYNC_INTERVAL_MS);
  }

  // ── Helpers ───────────────────────────────────────────────

  function _setLoadingStatus(text) {
    var el = document.getElementById('loading-status-text');
    if (!el) return;
    var ellipsis = el.querySelector('.loading-ellipsis');
    el.textContent = text;
    if (ellipsis) el.appendChild(ellipsis);
  }

  function _showError(msg) {
    var toast = document.createElement('div');
    toast.style.cssText = [
      'position:fixed', 'bottom:40px', 'right:20px',
      'background:#c0392b', 'color:#fff',
      'font-family:var(--font-body)', 'font-size:13px',
      'padding:10px 18px', 'z-index:9999', 'max-width:400px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.2)'
    ].join(';');
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function () { toast.remove(); }, 6000);
  }

  // ── Header ────────────────────────────────────────────────

  function _renderHeader(name, role) {
    var logoEl = document.getElementById('app-logo');
    if (!logoEl) return;

    var roleLabel = _roleLabel(role);
    var roleCls   = 'role-badge--' + role;

    logoEl.innerHTML = [
      '<span class="app-wordmark">Telecom Tracker</span>',
      '<span class="role-badge ' + roleCls + '">' + roleLabel + '</span>',
      '<span class="app-username">' + name + '</span>',
    ].join('');

    // Logout button — right edge of header
    var presenceBar = document.getElementById('presence-bar');
    if (presenceBar && !document.getElementById('logout-btn')) {
      var logoutBtn = document.createElement('button');
      logoutBtn.id        = 'logout-btn';
      logoutBtn.title     = 'Sign out';
      logoutBtn.innerHTML = '&#x2197;&#xFE0E; Sign Out';
      logoutBtn.addEventListener('click', _logout);
      presenceBar.appendChild(logoutBtn);
    }

    // Inject minimal header styles if not yet present
    if (!document.getElementById('app-header-styles')) {
      var s = document.createElement('style');
      s.id  = 'app-header-styles';
      s.textContent = [
        '#app-header {',
          'display: flex;',
          'align-items: center;',
          'gap: 16px;',
          'height: 48px;',
          'padding: 0 20px;',
          'background: var(--bg-navy);',
          'border-bottom: 1px solid var(--border-navy);',
          'flex-shrink: 0;',
        '}',
        '#app-logo {',
          'display: flex;',
          'align-items: center;',
          'gap: 10px;',
        '}',
        '.app-wordmark {',
          'font-family: var(--font-display);',
          'font-weight: 700;',
          'font-size: 16px;',
          'letter-spacing: 0.1em;',
          'text-transform: uppercase;',
          'color: var(--text-on-navy);',
          'white-space: nowrap;',
        '}',
        '.role-badge {',
          'font-family: var(--font-mono);',
          'font-size: 9px;',
          'letter-spacing: 0.16em;',
          'text-transform: uppercase;',
          'padding: 3px 8px;',
          'border: 1px solid;',
          'white-space: nowrap;',
        '}',
        '.role-badge--coordinator {',
          'color: var(--text-muted-navy);',
          'border-color: var(--border-navy);',
        '}',
        '.role-badge--invoicing {',
          'color: var(--accent);',
          'border-color: rgba(201,151,58,0.4);',
        '}',
        '.role-badge--manager {',
          'color: #7ec8a0;',
          'border-color: rgba(126,200,160,0.4);',
        '}',
        '#screen-app {',
          'display: flex;',
          'flex-direction: column;',
          'height: 100vh;',
          'overflow: hidden;',
        '}',
        '#app-body {',
          'flex: 1;',
          'overflow: hidden;',
          'display: flex;',
          'flex-direction: column;',
        '}',
        '#grid-container {',
          'flex: 1;',
          'overflow: hidden;',
        '}',
        '.app-username {',
          'font-family: var(--font-body);',
          'font-size: 12px;',
          'font-weight: 500;',
          'color: var(--text-muted-navy);',
          'white-space: nowrap;',
          'margin-left: 4px;',
        '}',
        '#presence-bar {',
          'display: flex;',
          'align-items: center;',
          'gap: 8px;',
          'margin-left: auto;',
        '}',
        '#logout-btn {',
          'height: 28px;',
          'padding: 0 12px;',
          'font-family: var(--font-display);',
          'font-weight: 600;',
          'font-size: 10px;',
          'letter-spacing: 0.12em;',
          'text-transform: uppercase;',
          'background: transparent;',
          'color: var(--text-muted-navy);',
          'border: 1px solid var(--border-navy);',
          'cursor: pointer;',
          'transition: background 0.15s, color 0.15s;',
          'white-space: nowrap;',
        '}',
        '#logout-btn:hover {',
          'background: rgba(255,255,255,0.08);',
          'color: var(--text-on-navy);',
        '}',
        '#app-statusbar {',
          'display: flex;',
          'align-items: center;',
          'gap: 20px;',
          'height: 28px;',
          'padding: 0 16px;',
          'background: var(--bg-surface);',
          'border-top: 1px solid var(--border);',
          'font-family: var(--font-mono);',
          'font-size: 10px;',
          'letter-spacing: 0.1em;',
          'text-transform: uppercase;',
          'color: var(--text-secondary);',
          'flex-shrink: 0;',
        '}',
      ].join('\n');
      document.head.appendChild(s);
    }
  }

  function _roleLabel(role) {
    return { coordinator: 'Coordinator', invoicing: 'Invoicing', manager: 'Manager' }[role] || role;
  }

  function _logout() {
    sessionStorage.clear();
    window.location.reload();
  }

  // ── Helpers ───────────────────────────────────────────────

  function _show(id) {
    var el = document.getElementById(id);
    if (el) el.removeAttribute('hidden');
  }

  function _hide(id) {
    var el = document.getElementById(id);
    if (el) el.setAttribute('hidden', '');
  }

  // ── Boot ──────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}());
