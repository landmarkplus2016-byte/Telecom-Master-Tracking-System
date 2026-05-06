// ============================================================
// app.js — App init and routing
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Entry point: called last after all modules are loaded
//   - Check for existing session (sessionStorage) on reload
//   - Route to: setup screen → login screen → main app
//   - On login: Db.init() → session owner check → full or delta fetch
//   - Wire toolbar buttons (role-gated)
//   - Show / hide screens
//
// Session 5: offline.js retired.  All storage is DuckDB (via db.js).
// Sync is handled by sync.js (DuckDB pending_queue → Apps Script batches of 50).
// ============================================================

(function () {

  // ── Init ──────────────────────────────────────────────────

  function init() {
    console.log('[app.js] init() — starting');

    if (typeof Theme !== 'undefined') Theme.init();

    var name = sessionStorage.getItem('app_name');
    var role = sessionStorage.getItem('app_role');
    var code = sessionStorage.getItem('app_code');

    if (name && role && code) {
      console.log('[app.js] Session found — name:', name, 'role:', role);
      _showApp(name, role);
      return;
    }

    if (name || role) {
      console.log('[app.js] Incomplete session — clearing');
      sessionStorage.clear();
    }

    Auth.init(function onLoginSuccess(name, role) {
      console.log('[app.js] Login success — name:', name, 'role:', role);
      _showApp(name, role);
    });
  }

  // ── Show main app ─────────────────────────────────────────

  function _showApp(name, role) {
    console.log('[app.js] _showApp() — role:', role);

    _hide('screen-loading');
    _renderHeader(name, role);
    _show('screen-app');

    // ── 1. Config (dropdowns, pricing) — must finish before Grid.init ──
    _setLoadingStatus('Loading config…');

    Sheets.fetchConfig(function (configResult) {
      if (configResult.success) {
        Pricing.init(configResult);
        Grid.applyDropdowns(configResult.dropdowns || {}, configResult.priceList || []);
      } else {
        console.warn('[app.js] fetchConfig failed:', configResult.error);
        Pricing.init(null);
        Grid.applyDropdowns({}, []);
      }

      // ── 2. Grid and all UI modules ──────────────────────────
      Grid.init(role, name);

      if (typeof Filters    !== 'undefined') Filters.init(role, name);
      if (typeof Theme      !== 'undefined') Theme.renderDropdown();
      if (typeof Delete     !== 'undefined') Delete.init(role, name);
      if (typeof Export     !== 'undefined') Export.init(role, name);
      if (typeof Backup     !== 'undefined') Backup.init(role, name);
      if (typeof Reconcile  !== 'undefined') {
        Reconcile.init(role, name);
        Reconcile.wireToolbarButton();
      }

      // Presence heartbeat + change notification for manager
      Sheets.startPresence(name, function _onCoordinatorChanges() {
        if (role !== 'manager') return;
        var since = Sync.getLastSyncTime();
        if (since) _runDeltaSync(since);
      });

      // ── 3. DuckDB startup — loads data into DuckDB, then to grid ─
      _setLoadingStatus('Initializing local database…');

      Db.init().then(function () {
        // When OPFS is unavailable DuckDB falls back to in-memory.
        // In-memory has no cached rows, so _startupFromCache would show an
        // empty grid.  Skip the session-owner check and always do a full fetch.
        if (!Db.isPersistent()) {
          console.log('[app.js] DuckDB in-memory — skipping cache, doing full fetch');
          return Db.setSessionOwner(name, role).then(function () {
            return _doFullFetch();
          });
        }

        return Db.getSessionOwner();

      }).then(function (owner) {
        // owner is undefined when the non-persistent path already ran _doFullFetch.
        if (!owner || typeof owner !== 'object') return;

        var isSameUser = owner.name === name;

        if (!isSameUser) {
          // Different user (or first-ever run): clear all local data and
          // do a full fetch so we never show another user's rows.
          console.log('[app.js] session owner changed (',
            owner.name, '→', name, ') — clearing DuckDB');
          return Db.clearRows()
            .then(function () { return Db.setSessionOwner(name, role); })
            .then(function () { return _doFullFetch(); });
        }

        // Same user — load from local DuckDB immediately, then delta-sync
        var since = Sync.getLastSyncTime();
        if (since) {
          return _startupFromCache(since);
        }
        // No sync time = first load for this user on this device
        return _doFullFetch();

      }).then(function () {
        // DuckDB is populated — initialize sync queue (drain if pending)
        Sync.init();

      }).catch(function (e) {
        console.error('[app.js] DuckDB startup failed:', e.message || e);
        // DuckDB unavailable — fall through to a direct Apps Script fetch
        _doFullFetch().then(function () { Sync.init(); });
      });
    });
  }

  // ── Full fetch ─────────────────────────────────────────────
  //
  // Downloads all rows from Apps Script, stores in DuckDB, loads the grid.
  // Used on: first load, user switch, or manual Refresh.
  // Returns a Promise.

  function _doFullFetch() {
    if (!navigator.onLine) {
      _hide('screen-loading');
      _showError('You are offline and no cached data is available. Connect to the internet and reload.');
      return Promise.resolve();
    }

    _setLoadingStatus('Loading data…');

    return new Promise(function (resolve) {
      Sheets.fetchAllRows(function (result) {
        _hide('screen-loading');

        if (!result.success) {
          console.error('[app.js] fetchAllRows failed:', result.error);
          _showError('Could not load data: ' + result.error);
          resolve();
          return;
        }

        console.log('[app.js] full fetch — rows received:', result.rows.length);
        Sync.setLastSyncTime(result.serverTime);

        Db.loadAllRows(result.rows).then(function () {
          Grid.loadData(result.rows);
          if (typeof Filters !== 'undefined' && Filters.onDataChanged) Filters.onDataChanged();
          _startBackgroundSync();
          resolve();
        }).catch(function (e) {
          // DuckDB load failed — still show rows in the grid (search won't work)
          console.warn('[app.js] DuckDB loadAllRows failed:', e.message || e);
          Grid.loadData(result.rows);
          _startBackgroundSync();
          resolve();
        });
      });
    });
  }

  // ── Startup from cache ─────────────────────────────────────
  //
  // Show DuckDB rows instantly, then run a background delta sync.
  // "Pending new rows" (created offline, not yet assigned a server row index)
  // are re-injected from the pending_queue so they remain visible.
  // Returns a Promise.

  function _startupFromCache(since) {
    _setLoadingStatus('Loading from cache…');

    return Db.query('SELECT * FROM rows WHERE _is_deleted = false').then(function (rows) {

      // Re-inject pending new rows so they stay visible in the grid
      // while waiting for the flush to assign them a server row index.
      return Db.query(
        "SELECT payload FROM pending_queue WHERE action = 'save'"
      ).then(function (pending) {
        var pendingNew = [];
        pending.forEach(function (p) {
          try {
            var r = JSON.parse(p.payload);
            if (r && !r._row_index) pendingNew.push(r);
          } catch (_) {}
        });

        _hide('screen-loading');
        Grid.loadData(rows.concat(pendingNew));
        if (typeof Filters !== 'undefined' && Filters.onDataChanged) Filters.onDataChanged();
        console.log('[app.js] startup from DuckDB —', rows.length, 'cached rows +',
          pendingNew.length, 'pending new');

        // Background delta sync (only when online)
        if (navigator.onLine) {
          _runDeltaSync(since, function () { _startBackgroundSync(); });
        } else {
          _startBackgroundSync();
        }
      });
    });
  }

  // ── Delta sync ─────────────────────────────────────────────
  //
  // Fetches rows changed since `since` (epoch-ms).
  // Skips rows that have a pending local edit in the queue (offline edits win).
  // cb is optional — called when done.

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
        Sync.setLastSyncTime(result.serverTime);
        if (cb) cb();
        return;
      }

      // Read pending queue to know which row indexes have un-flushed local edits
      Db.query('SELECT row_id FROM pending_queue').then(function (pending) {
        var pendingMap = {};
        pending.forEach(function (p) {
          // row_id is 'row_N' — extract the numeric index for matching
          var m = p.row_id && p.row_id.match(/^row_(\d+)$/);
          if (m) pendingMap[m[1]] = true;
        });

        var toApply = changed.filter(function (r) {
          return !pendingMap[String(r._row_index || '')];
        });

        var skipped = changed.length - toApply.length;
        if (skipped > 0) {
          console.log('[app.js] delta sync skipped', skipped, 'row(s) with pending local edits');
        }

        if (!toApply.length) {
          Sync.setLastSyncTime(result.serverTime);
          if (cb) cb();
          return;
        }

        return Db.loadAllRows(toApply).then(function () {
          Grid.applyDelta(toApply);
          if (typeof Filters !== 'undefined' && Filters.onDataChanged) Filters.onDataChanged();
          console.log('[app.js] delta sync applied', toApply.length, 'rows');
          Sync.setLastSyncTime(result.serverTime);
          if (cb) cb();
        });

      }).catch(function (e) {
        console.warn('[app.js] delta sync DuckDB update failed:', e.message || e);
        if (cb) cb();
      });
    });
  }

  // ── Background sync timer ──────────────────────────────────

  var BACKGROUND_SYNC_MS = 30 * 1000; // 30 seconds
  var _bgSyncTimer = null;

  function _startBackgroundSync() {
    if (_bgSyncTimer) return;
    _bgSyncTimer = setInterval(function () {
      if (!navigator.onLine) return;
      if (document.hidden)   return;
      var since = Sync.getLastSyncTime();
      if (!since) return;
      console.log('[app.js] background sync tick');
      _runDeltaSync(since);
    }, BACKGROUND_SYNC_MS);
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

    var presenceBar = document.getElementById('presence-bar');
    if (presenceBar && !document.getElementById('logout-btn')) {
      var logoutBtn = document.createElement('button');
      logoutBtn.id        = 'logout-btn';
      logoutBtn.title     = 'Sign out';
      logoutBtn.innerHTML = '&#x2197;&#xFE0E; Sign Out';
      logoutBtn.addEventListener('click', _logout);
      presenceBar.appendChild(logoutBtn);
    }

    if (!document.getElementById('app-header-styles')) {
      var s = document.createElement('style');
      s.id = 'app-header-styles';
      s.textContent = [
        '#app-header{display:flex;align-items:center;gap:16px;height:48px;padding:0 20px;background:var(--bg-navy);border-bottom:1px solid var(--border-navy);flex-shrink:0;}',
        '#app-logo{display:flex;align-items:center;gap:10px;}',
        '.app-wordmark{font-family:var(--font-display);font-weight:700;font-size:16px;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-on-navy);white-space:nowrap;}',
        '.role-badge{font-family:var(--font-mono);font-size:9px;letter-spacing:0.16em;text-transform:uppercase;padding:3px 8px;border:1px solid;white-space:nowrap;}',
        '.role-badge--coordinator{color:var(--text-muted-navy);border-color:var(--border-navy);}',
        '.role-badge--invoicing{color:var(--accent);border-color:rgba(201,151,58,0.4);}',
        '.role-badge--manager{color:#7ec8a0;border-color:rgba(126,200,160,0.4);}',
        '#screen-app{display:flex;flex-direction:column;height:100vh;overflow:hidden;}',
        '#app-body{flex:1;overflow:hidden;display:flex;flex-direction:column;}',
        '#grid-container{flex:1;}',
        '.app-username{font-family:var(--font-body);font-size:12px;font-weight:500;color:var(--text-muted-navy);white-space:nowrap;margin-left:4px;}',
        '#presence-bar{display:flex;align-items:center;gap:8px;margin-left:auto;}',
        '#logout-btn{height:28px;padding:0 12px;font-family:var(--font-display);font-weight:600;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;background:transparent;color:var(--text-muted-navy);border:1px solid var(--border-navy);cursor:pointer;transition:background 0.15s,color 0.15s;white-space:nowrap;}',
        '#logout-btn:hover{background:rgba(255,255,255,0.08);color:var(--text-on-navy);}',
        '#app-statusbar{display:flex;align-items:center;gap:20px;height:28px;padding:0 16px;background:var(--bg-base);border-top:2px solid rgba(201,151,58,0.35);font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-secondary);flex-shrink:0;}',
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

  function _show(id) { var el = document.getElementById(id); if (el) el.removeAttribute('hidden'); }
  function _hide(id) { var el = document.getElementById(id); if (el) el.setAttribute('hidden', ''); }

  // ── Boot ──────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}());
