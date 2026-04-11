// ============================================================
// sheets.js — ALL communication with Apps Script
// Telecom Coordinator Tracking App
// ============================================================
//
// This is the ONLY file that calls Apps Script.
// Every other file that needs data calls a function here.
//
// Public API:
//   Sheets.authenticate(name, code, callback)
//   Sheets.fetchAllRows(callback)
//   Sheets.writeRow(rowData, callback)
//
// Callbacks receive: { success, ...data } or { success:false, error }
//
// Cold start:
//   Apps Script sleeps after ~5 min of inactivity. The first
//   request after sleep takes 5–8 s. We show a subtle
//   "Waking up..." indicator in #cold-start-indicator so the
//   app never appears broken during this window.
//
// localStorage key read here (written by config.js):
//   apps_script_url
//
// ============================================================

var Sheets = (function () {

  // ── Constants ─────────────────────────────────────────────

  // A request is considered a "fresh start" if the app has
  // been idle longer than this threshold. Drives cold-start UI.
  var COLD_START_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  // Timeout for a single Apps Script request.
  // Cold starts can take 8 s; give generous headroom.
  var REQUEST_TIMEOUT_MS = 45 * 1000; // 45 seconds

  // Presence heartbeat interval (ms). Must be < PRESENCE_STALE_MS.
  var PRESENCE_INTERVAL_MS = 30 * 1000; // 30 seconds

  // An avatar is hidden on the client side if its last_seen is older
  // than this threshold. Two missed beats (60 s) before disappearing.
  var PRESENCE_STALE_MS = 75 * 1000; // 75 seconds

  // Timeout for silent presence requests.
  // Apps Script can take 5–15 s even when warm (sheet I/O is slow).
  // 10 s was too short — heartbeats timed out silently, breaking avatars
  // and change notifications. 25 s gives enough headroom while still
  // being shorter than the main request timeout (45 s).
  var PRESENCE_TIMEOUT_MS = 25 * 1000; // 25 seconds

  // ── Internal state ────────────────────────────────────────

  var _lastSuccessfulRequestAt = null; // Date | null
  var _coldStartTimerHandle    = null;
  var _coldStartVisible        = false;

  var _presenceName      = null; // set by startPresence()
  var _presenceTimer     = null; // setInterval handle
  var _onChangesCallback = null; // called when manager receives change notifications

  // ── Public: Authenticate ──────────────────────────────────

  /**
   * Verify a name + code pair against Apps Script.
   *
   * callback({ success, name, role, displayName })
   * callback({ success:false, error })
   */
  function authenticate(name, code, callback) {
    _post(
      { action: 'auth', name: name, code: code },
      { isColdStartCandidate: true, label: 'Authenticating' },
      callback
    );
  }

  // ── Public: Fetch all rows (first load) ──────────────────

  /**
   * Full data fetch — used ONLY on the very first load when there
   * is no sync timestamp in localStorage yet.
   * All subsequent loads must call fetchDelta instead.
   *
   * callback({ success, rows, columns, serverTime })
   * callback({ success:false, error })
   */
  function fetchAllRows(callback) {
    _post(
      { action: 'getRows' },
      { isColdStartCandidate: true, label: 'Loading data' },
      function (result) {
        if (result.success) _updateLastSyncTime(result.serverTime);
        callback(result);
      }
    );
  }

  // ── Public: Delta fetch ───────────────────────────────────

  /**
   * Fetch only rows modified after `since` (epoch-ms number).
   * Used on every app open after the first, and for background sync.
   *
   * since — epoch-ms number from Offline.getLastSyncTime().
   *         Pass 0 or null to get all rows (equivalent to fetchAllRows).
   *
   * callback({ success, rows, columns, serverTime })
   * callback({ success:false, error })
   */
  function fetchDelta(since, callback) {
    var payload = { action: 'getRows' };
    if (since) payload.since = since;

    _post(
      payload,
      { isColdStartCandidate: false, label: since ? 'Syncing changes' : 'Loading data' },
      function (result) {
        if (result.success) _updateLastSyncTime(result.serverTime);
        callback(result);
      }
    );
  }

  // ── Public: Batch write ───────────────────────────────────

  /**
   * Write many rows to Apps Script in chunks of 50.
   * Used for TSR reconciliation and other bulk operations.
   *
   * rows       — array of row objects (same shape as writeRow rowData)
   * onProgress — optional function(done, total) called after each chunk
   * callback({ success, results })  — results is array of per-row outcomes
   */
  function writeBatch(rows, onProgress, callback) {
    if (!rows || !rows.length) {
      if (callback) callback({ success: true, results: [] });
      return;
    }

    var BATCH_SIZE  = 50;
    var total       = rows.length;
    var allResults  = [];
    var batchStart  = 0;

    function sendNext() {
      if (batchStart >= total) {
        if (callback) callback({ success: true, results: allResults });
        return;
      }

      var chunk = rows.slice(batchStart, batchStart + BATCH_SIZE);
      var done  = Math.min(batchStart + BATCH_SIZE, total);

      if (onProgress) onProgress(done, total);

      _post(
        { action: 'writeBatch', rows: chunk },
        { isColdStartCandidate: false,
          label: 'Syncing ' + done + ' of ' + total + ' rows' },
        function (result) {
          if (!result.success) {
            // Hard failure — stop the batch and report
            if (callback) callback(result);
            return;
          }
          allResults = allResults.concat(result.results || []);
          batchStart += BATCH_SIZE;
          sendNext();
        }
      );
    }

    sendNext();
  }

  // ── Public: Fetch price config ───────────────────────────

  /**
   * Load price versions, price list, and contractor splits from
   * the Config tab. Called once on app startup before loading rows.
   *
   * callback({ success, versions, priceList, contractorSplits })
   * callback({ success:false, error })
   */
  function fetchConfig(callback) {
    _post(
      { action: 'getConfig' },
      { isColdStartCandidate: false, label: 'Loading config' },
      callback
    );
  }

  // ── Public: Write a single row ────────────────────────────

  /**
   * Create (no _row_index) or update (with _row_index) a row.
   * Auth credentials are re-read from sessionStorage on every
   * call so this always reflects the current session.
   *
   * When called from the offline queue drain, rowData includes
   * _queued_at (epoch-ms) so the server can detect conflicts.
   *
   * callback({ success, rowIndex, timestamp })
   * callback({ success:false, error })
   * callback({ success:false, conflict:true, conflictSheetRow, serverRow })
   */
  function writeRow(rowData, callback) {
    _post(
      { action: 'writeRow', row: rowData },
      { isColdStartCandidate: false, label: 'Saving' },
      callback
    );
  }

  // ── Public: Resolve a conflict ────────────────────────────

  /**
   * Notify Apps Script that a conflict has been resolved.
   *
   * conflictSheetRow — 1-based row index in the Conflicts sheet tab
   *                    (returned by the server when conflict was detected)
   * liveRowIndex     — 1-based row index in the Data sheet for the live row
   * keepVersion      — 'online' | 'offline' | 'merge'
   *   'online'  → live row unchanged, conflict copy deleted
   *   'offline' → write mergedData to live row, conflict copy deleted
   *   'merge'   → write mergedData to live row, conflict copy deleted
   * mergedData       — row data object to write (null when keepVersion === 'online')
   *
   * callback({ success })
   * callback({ success:false, error })
   */
  function fetchConflicts(callback) {
    _post(
      { action: 'getConflicts' },
      { isColdStartCandidate: false, label: 'Loading conflicts' },
      callback
    );
  }

  function resolveConflict(conflictSheetRow, liveRowIndex, keepVersion, mergedData, callback) {
    _post(
      {
        action:           'conflictResolve',
        conflictSheetRow: conflictSheetRow,
        liveRowIndex:     liveRowIndex,
        keepVersion:      keepVersion,
        mergedData:       mergedData || null
      },
      { isColdStartCandidate: false, label: 'Resolving conflict' },
      callback
    );
  }

  // ── Public: Presence heartbeat ───────────────────────────

  /**
   * Start the 30-second presence heartbeat.
   * Called once by app.js after Grid.init() — after the user is
   * authenticated and the session is active.
   *
   * Fires immediately on call, then every PRESENCE_INTERVAL_MS.
   * Each tick: writes this user's heartbeat to the Presence tab and
   * reads back the current online list in one round-trip.
   * All network failures are silently ignored.
   *
   * onChanges (optional) — callback fired when the manager's heartbeat
   * returns new coordinator changes. app.js uses this to trigger an
   * immediate delta sync so the manager's grid reflects the updated
   * row data, not just the row highlight.
   */
  function startPresence(name, onChanges) {
    if (!name || _presenceTimer) return; // already running
    _presenceName      = name;
    _onChangesCallback = onChanges || null;

    _heartbeatTick();
    _presenceTimer = setInterval(_heartbeatTick, PRESENCE_INTERVAL_MS);

    // Fire a heartbeat immediately when the device comes back online
    // so avatars refresh without waiting up to 30 seconds.
    window.addEventListener('online', _heartbeatTick);

    // Pause heartbeat when the window/PWA is minimized or hidden,
    // resume immediately when the user comes back.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') _heartbeatTick();
    });
  }

  function _heartbeatTick() {
    if (!_presenceName) return;
    if (!navigator.onLine) return;
    if (document.visibilityState !== 'visible') return; // skip when minimized

    _postSilent(
      { action: 'presenceWrite', presenceName: _presenceName },
      function (result) {
        if (!result || !result.success) {
          console.warn('[sheets.js] Heartbeat failed or timed out — result:', result);
          return;
        }
        console.log('[sheets.js] Heartbeat OK — online users:', (result.users || []).length,
          '| changes:', (result.changes || []).length);
        _renderAvatars(result.users || []);

        // Change notifications — manager only, one-directional:
        // coordinator saves → manager sees highlight + avatar pulse.
        // Coordinator is never notified of manager edits.
        var role = sessionStorage.getItem('app_role') || '';
        if (role === 'manager' && result.changes && result.changes.length) {
          _handleChanges(result.changes);
        }
        // Sync conflict count from server for ALL roles.
        // This clears stale IDB conflict entries on the coordinator's tab
        // after a manager resolves them, and shows the button on the manager's
        // tab even in incognito (where IDB is empty).
        if (typeof result.conflictCount === 'number') {
          if (typeof Offline !== 'undefined' && Offline.setServerConflictCount) {
            Offline.setServerConflictCount(result.conflictCount);
          }
        }
      }
    );
  }

  // ── Internal: apply change notifications ─────────────────
  //
  // Receives the `changes` array from the presenceWrite response.
  // For each entry: highlights the row in the grid (via Grid.highlightChange)
  // and pulses the coordinator's avatar bubble.
  //
  // Duplicate calls for the same rowId are idempotent — Grid.highlightChange
  // simply resets the clear timer, and re-pulsing an already-pulsing avatar
  // is a visual no-op.

  function _handleChanges(changes) {
    changes.forEach(function (change) {
      // Highlight the changed row in the grid
      if (typeof Grid !== 'undefined' && Grid.highlightChange) {
        Grid.highlightChange(change.rowId);
      }

      // Pulse the avatar of the coordinator who saved
      if (change.who) _pulseAvatar(change.who);
    });

    // Trigger an immediate delta sync so the manager's grid shows the
    // actual updated data (not just the row highlight). Without this,
    // the manager waits up to 2 minutes for the background sync to run.
    if (_onChangesCallback) _onChangesCallback();
  }

  // Add a brief pulse animation to the named coordinator's avatar bubble.
  // Pulse is purely visual — no state change, auto-removes the class.
  function _pulseAvatar(name) {
    var cluster = document.getElementById('avatar-cluster');
    if (!cluster) return;

    var safeName = name.replace(/"/g, '\\"');
    var avatar   = cluster.querySelector('[data-name="' + safeName + '"]');
    if (!avatar) return;

    // Remove first in case it's already pulsing (re-triggers animation)
    avatar.classList.remove('presence-avatar--pulse');
    // Force reflow so removing + re-adding the class restarts the animation
    void avatar.offsetWidth;
    avatar.classList.add('presence-avatar--pulse');

    setTimeout(function () {
      avatar.classList.remove('presence-avatar--pulse');
    }, 1200);
  }

  // ── Internal: silent POST for presence ───────────────────
  //
  // Like _post but: no cold-start UI, no loading-status text,
  // short 10-second timeout, all errors silently swallowed.
  // Still injects auth credentials and updates the cold-start clock.

  function _postSilent(payload, cb) {
    var url = _getUrl();
    if (!url) { if (cb) cb(null); return; }

    // Inject credentials exactly like _post
    var name = sessionStorage.getItem('app_name') || '';
    var role = sessionStorage.getItem('app_role') || '';
    var code = sessionStorage.getItem('app_code') || '';
    if (name && !payload.name) payload.name = name;
    if (role && !payload.role) payload.role = role;
    if (code && !payload.code) payload.code = code;

    var aborted = false;
    var timer = setTimeout(function () {
      aborted = true;
      if (cb) cb({ success: false });
    }, PRESENCE_TIMEOUT_MS);

    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      body:    JSON.stringify(payload)
    })
    .then(function (r) {
      if (aborted) return null;
      return r.ok ? r.json() : null;
    })
    .then(function (data) {
      if (aborted) return;
      clearTimeout(timer);
      if (data) _lastSuccessfulRequestAt = Date.now(); // server is awake
      if (cb) cb(data || { success: false });
    })
    .catch(function () {
      if (!aborted) { clearTimeout(timer); if (cb) cb({ success: false }); }
    });
  }

  // ── Internal: render avatar bubbles ──────────────────────
  //
  // Updates #avatar-cluster inside #presence-bar.
  // Excludes the current user. Skips users whose lastSeen timestamp
  // is older than PRESENCE_STALE_MS (belt-and-suspenders on top of
  // the server's own prune, handles clock skew gracefully).

  function _renderAvatars(users) {
    var presenceBar = document.getElementById('presence-bar');
    if (!presenceBar) return;

    var myName = (sessionStorage.getItem('app_name') || '').trim().toLowerCase();
    var now    = Date.now();

    // Filter: exclude self, exclude stale
    var active = users.filter(function (u) {
      if (!u.name) return false;
      if (u.name.trim().toLowerCase() === myName) return false;
      if (now - Number(u.lastSeen) > PRESENCE_STALE_MS) return false;
      return true;
    });

    // Ensure the cluster container exists, inserted before the logout button
    var cluster = document.getElementById('avatar-cluster');
    if (!cluster) {
      cluster = document.createElement('div');
      cluster.id = 'avatar-cluster';
      var logoutBtn = document.getElementById('logout-btn');
      if (logoutBtn) {
        presenceBar.insertBefore(cluster, logoutBtn);
      } else {
        presenceBar.appendChild(cluster);
      }
    }

    // Build a fast lookup of currently active names
    var activeMap = {};
    active.forEach(function (u) { activeMap[u.name] = u; });

    // Remove avatars for users who have gone offline
    var existing = cluster.querySelectorAll('.presence-avatar');
    for (var i = 0; i < existing.length; i++) {
      var el   = existing[i];
      var eName = el.getAttribute('data-name');
      if (!activeMap[eName]) {
        el.classList.add('presence-avatar--leaving');
        // Remove from DOM after the CSS transition completes
        (function (node) {
          setTimeout(function () {
            if (node.parentNode) node.parentNode.removeChild(node);
          }, 300);
        }(el));
      }
    }

    // Add avatars for users not yet rendered
    active.forEach(function (u) {
      var safeAttr = u.name.replace(/"/g, '&quot;');
      if (cluster.querySelector('[data-name="' + safeAttr + '"]')) return;

      var avatar = document.createElement('div');
      avatar.className = 'presence-avatar';
      avatar.setAttribute('data-name', u.name);
      avatar.title     = u.name + ' \u2014 online';
      avatar.textContent = _initials(u.name);
      cluster.appendChild(avatar);
    });
  }

  function _initials(name) {
    var parts = String(name || '').trim().split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }
    return parts[0].slice(0, 2).toUpperCase();
  }

  // ── Internal: POST to Apps Script ────────────────────────

  /**
   * All requests go through here.
   *
   * opts:
   *   isColdStartCandidate {boolean} — show "Waking up..." if idle too long
   *   label                {string}  — loading-status text prefix
   */
  function _post(payload, opts, callback) {
    var url = _getUrl();
    if (!url) {
      callback({ success: false, error: 'No Apps Script URL configured. Please reload and complete setup.' });
      return;
    }

    // Inject auth credentials from sessionStorage into every request
    var name = sessionStorage.getItem('app_name') || '';
    var role = sessionStorage.getItem('app_role') || '';
    if (name && !payload.name) payload.name = name;
    if (role && !payload.role) payload.role = role;

    // Read personal code from sessionStorage (stored by auth.js only
    // during authentication; subsequent calls re-use it from session)
    var code = sessionStorage.getItem('app_code') || '';
    if (code && !payload.code) payload.code = code;

    // Decide whether to show cold-start UI
    var showColdStart = opts.isColdStartCandidate && _isColdStart();
    if (showColdStart) _showColdStart();

    // Show loading status text on the loading screen (if still visible)
    _setLoadingStatus(opts.label + '…');

    // Abort controller for timeout
    var aborted  = false;
    var timerId  = setTimeout(function () {
      aborted = true;
      _hideColdStart();
      callback({
        success: false,
        error:   'The server is taking too long to respond. Please check your connection and try again.'
      });
    }, REQUEST_TIMEOUT_MS);

    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      // Apps Script requires text/plain to avoid CORS preflight;
      // body is valid JSON the server parses with JSON.parse()
      body: JSON.stringify(payload)
    })
    .then(function (response) {
      if (aborted) return null;
      if (!response.ok) {
        throw new Error('Server returned HTTP ' + response.status);
      }
      return response.json();
    })
    .then(function (data) {
      if (aborted) return;
      clearTimeout(timerId);
      _hideColdStart();
      _lastSuccessfulRequestAt = Date.now();

      if (!data) return; // aborted case

      if (!data.success) {
        // Pass the full server response through so conflict data
        // (conflict:true, conflictSheetRow, serverRow) is preserved.
        // Add a fallback error message if the server didn't include one.
        callback(Object.assign({ error: 'An unexpected error occurred.' }, data));
        return;
      }

      callback(data);
    })
    .catch(function (err) {
      if (aborted) return;
      clearTimeout(timerId);
      _hideColdStart();
      callback({ success: false, error: _friendlyError(err) });
    });
  }

  // ── Last-sync timestamp indicator ────────────────────────
  //
  // Updates #last-sync-time in the status bar after every successful
  // fetch (full or delta). serverTime is an epoch-ms number from the server.

  function _updateLastSyncTime(serverTime) {
    var el = document.getElementById('last-sync-time');
    if (!el || !serverTime) return;

    var d   = new Date(serverTime);
    var hh  = String(d.getHours()).padStart(2, '0');
    var mm  = String(d.getMinutes()).padStart(2, '0');
    var ss  = String(d.getSeconds()).padStart(2, '0');
    el.textContent = 'Synced ' + hh + ':' + mm + ':' + ss;
  }

  // ── Cold start ────────────────────────────────────────────

  function _isColdStart() {
    if (!_lastSuccessfulRequestAt) return true; // very first request
    return (Date.now() - _lastSuccessfulRequestAt) > COLD_START_THRESHOLD_MS;
  }

  function _showColdStart() {
    if (_coldStartVisible) return;
    _coldStartVisible = true;

    var el = document.getElementById('cold-start-indicator');
    if (!el) return;

    el.removeAttribute('hidden');
    el.textContent = '';

    // Build: pulsing dot + "Waking up..." text
    var dot  = document.createElement('span');
    dot.className   = 'cold-dot';

    var text = document.createElement('span');
    text.className  = 'cold-text';
    text.textContent = 'Waking up — this may take a few seconds';

    el.appendChild(dot);
    el.appendChild(text);

    // Escalate message after 6 s if still waiting
    _coldStartTimerHandle = setTimeout(function () {
      if (_coldStartVisible && text.parentNode) {
        text.textContent = 'Still connecting — Apps Script is starting up…';
      }
    }, 6000);
  }

  function _hideColdStart() {
    _coldStartVisible = false;
    clearTimeout(_coldStartTimerHandle);
    var el = document.getElementById('cold-start-indicator');
    if (el) el.setAttribute('hidden', '');
  }

  // ── Helpers ───────────────────────────────────────────────

  function _getUrl() {
    return (localStorage.getItem('apps_script_url') || '').trim() || null;
  }

  function _setLoadingStatus(text) {
    var el = document.getElementById('loading-status-text');
    if (!el) return;
    // Preserve the animated ellipsis element if present
    var ellipsis = el.querySelector('.loading-ellipsis');
    el.textContent = text;
    if (ellipsis) el.appendChild(ellipsis);
  }

  function _friendlyError(err) {
    var msg = (err && err.message) ? err.message : String(err);

    // Network failures
    if (/failed to fetch|network/i.test(msg)) {
      return 'Unable to reach the server. Check your internet connection and try again.';
    }
    // CORS issues (Apps Script URL misconfigured)
    if (/cors/i.test(msg)) {
      return 'Connection blocked. Ensure the Apps Script is deployed with "Anyone" access.';
    }
    // JSON parse failures (Apps Script returned an error page)
    if (/json|unexpected token/i.test(msg)) {
      return 'Received an unexpected response from the server. The Apps Script may have an error.';
    }

    return 'Something went wrong: ' + msg;
  }

  // ── Cold-start indicator styles ───────────────────────────
  // Injected once — minimal, complements main.css status bar

  (function _injectStyles() {
    if (document.getElementById('sheets-styles')) return;
    var s = document.createElement('style');
    s.id = 'sheets-styles';
    s.textContent = [

      '#cold-start-indicator {',
        'display: flex;',
        'align-items: center;',
        'gap: 7px;',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'color: var(--text-muted-navy, #8fa5bf);',
      '}',

      '.cold-dot {',
        'width: 6px;',
        'height: 6px;',
        'border-radius: 50%;',
        'background: var(--accent, #c9973a);',
        'animation: cold-pulse 1.2s ease-in-out infinite;',
        'flex-shrink: 0;',
      '}',

      '@keyframes cold-pulse {',
        '0%, 100% { opacity: 1; transform: scale(1); }',
        '50%       { opacity: 0.3; transform: scale(0.55); }',
      '}',

      '.cold-text {',
        'color: var(--text-secondary, #5a6a80);',
        'font-size: 10px;',
      '}',

      // ── Presence avatar cluster ────────────────────────────

      '#avatar-cluster {',
        'display: flex;',
        'align-items: center;',
        'gap: 4px;',
        'margin-right: 4px;',
      '}',

      '.presence-avatar {',
        'width: 28px;',
        'height: 28px;',
        'border-radius: 50%;',
        'background: var(--bg-navy-mid, #243d5c);',
        'border: 1.5px solid var(--accent, #c9973a);',
        'color: var(--text-on-navy, #e8edf3);',
        'font-family: var(--font-display, sans-serif);',
        'font-weight: 700;',
        'font-size: 10px;',
        'letter-spacing: 0.03em;',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        'cursor: default;',
        'user-select: none;',
        'animation: avatar-in 0.25s ease-out;',
        'transition: opacity 0.25s ease, transform 0.25s ease;',
        'flex-shrink: 0;',
      '}',

      '.presence-avatar:hover {',
        'border-color: var(--accent-bright, #e8b04a);',
        'background: var(--bg-navy-deep, #0f1e30);',
      '}',

      // Fade + shrink on leave
      '.presence-avatar--leaving {',
        'opacity: 0;',
        'transform: scale(0.4);',
      '}',

      // Brief gold pulse when this coordinator just saved a row
      '.presence-avatar--pulse {',
        'animation: avatar-pulse 1.2s ease-out !important;',
      '}',

      '@keyframes avatar-pulse {',
        '0%   { box-shadow: 0 0 0 0   rgba(201,151,58,0.9); }',
        '50%  { box-shadow: 0 0 0 8px rgba(201,151,58,0.3); }',
        '100% { box-shadow: 0 0 0 14px rgba(201,151,58,0);  }',
      '}',

      '@keyframes avatar-in {',
        'from { opacity: 0; transform: scale(0.4); }',
        'to   { opacity: 1; transform: scale(1);   }',
      '}',

    ].join('\n');
    document.head.appendChild(s);
  }());

  // ── Expose ────────────────────────────────────────────────

  return {
    authenticate:    authenticate,
    fetchConfig:     fetchConfig,
    fetchAllRows:    fetchAllRows,
    fetchDelta:      fetchDelta,
    writeBatch:      writeBatch,
    writeRow:        writeRow,
    fetchConflicts:  fetchConflicts,
    resolveConflict: resolveConflict,
    startPresence:   startPresence
  };

}());
