// ============================================================
// offline.js — IndexedDB management and sync queue
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Open and manage an IndexedDB database for all row data
//   - Store all rows on first fetch (called by app.js)
//   - Return all cached rows for offline startup (called by app.js)
//   - Intercept saves from grid.js: write immediately when online,
//     queue in IDB when offline or mid-drain
//   - Drain the queue silently in the background on reconnect
//   - Detect conflicts when the server row was modified while user was offline
//   - Show sync + conflict indicators in the status bar
//
// Public API:
//   Offline.init(callback)               — open IDB, load queue + conflict counts
//   Offline.storeRows(rows)              — bulk-store rows after fetch
//   Offline.getAllRows(callback)          — load all rows from IDB
//   Offline.queueSave(rowData, callback) — route save online/offline
//   Offline.getConflicts(callback)       — return all stored conflict objects
//   Offline.resolveConflict(id, keepVersion, mergedData, callback)
//
// IDB schema (DB: telecom_tracker, v2):
//   rows       — keyPath: _row_index  — full row objects from server
//   sync_queue — keyPath: _queue_key  — pending saves (last-write-wins)
//   conflicts  — keyPath: id (auto)   — conflict copies pending manager review
//
// Conflict flow:
//   1. User edits a row while offline (queued with queuedAt timestamp).
//   2. On reconnect, _drainNext sends _queued_at to the server with each write.
//   3. Server compares _queued_at to the row's current last_modified.
//      If last_modified > _queued_at → conflict: someone else edited the live
//      row after the user went offline. Server saves offline version to the
//      Conflicts sheet tab and returns { success:false, conflict:true, ... }.
//   4. Client stores both versions in IDB conflicts store.
//   5. Manager sees "⚠ N conflict(s)" indicator. Clicking opens the panel.
//   6. Manager picks Keep Live, Keep Offline, or manual merge → resolves.
//
// ============================================================

var Offline = (function () {

  // ── Constants ─────────────────────────────────────────────

  var DB_NAME         = 'telecom_tracker';
  var DB_VERSION      = 2;           // v2 adds the conflicts store
  var STORE_ROWS      = 'rows';
  var STORE_QUEUE     = 'sync_queue';
  var STORE_CONFLICTS = 'conflicts';

  // Delay between drain retries when a save fails mid-queue
  var RETRY_DELAY_MS = 2000;

  // Max attempts per queue entry before stopping until next reconnect
  var MAX_ATTEMPTS = 3;

  // "✓ All synced" disappears after this delay (ms)
  var SYNCED_CLEAR_MS = 3000;

  // ── Internal state ────────────────────────────────────────

  var _db             = null;
  var _isOnline       = navigator.onLine;
  var _isSyncing      = false;
  var _pendingCount   = 0;
  var _conflictCount  = 0;
  var _syncClearTimer = null;

  // ── IndexedDB ─────────────────────────────────────────────

  function _openDB(cb) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = function (e) {
      var db       = e.target.result;
      var oldVer   = e.oldVersion; // 0 on first open, 1 on v1→v2 upgrade

      // ── v1 stores — create if missing ──
      if (!db.objectStoreNames.contains(STORE_ROWS)) {
        db.createObjectStore(STORE_ROWS, { keyPath: '_row_index' });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: '_queue_key' });
      }

      // ── v2 addition — conflicts store ──
      if (!db.objectStoreNames.contains(STORE_CONFLICTS)) {
        db.createObjectStore(STORE_CONFLICTS, { keyPath: 'id', autoIncrement: true });
      }
    };

    req.onsuccess = function (e) {
      _db = e.target.result;
      cb(_db);
    };

    req.onerror = function (e) {
      console.error('[offline.js] IndexedDB open failed:', e.target.error);
      cb(null);
    };
  }

  // ── Public: init ─────────────────────────────────────────

  /**
   * Open IDB, load the pending queue + conflict counts, then call cb.
   * Also registers the online/offline listeners.
   * Called once by app.js before fetching row data.
   */
  function init(cb) {
    _openDB(function (db) {
      if (!db) {
        console.warn('[offline.js] IDB unavailable — offline caching disabled');
        if (cb) cb();
        return;
      }

      // Load pending queue count (accurate indicator on startup / reload)
      try {
        var tx  = db.transaction([STORE_QUEUE], 'readonly');
        var req = tx.objectStore(STORE_QUEUE).count();
        req.onsuccess = function (e) {
          _pendingCount = e.target.result || 0;
          _updateIndicator();
          _loadConflictCount(cb); // chain into conflict count load
        };
        req.onerror = function () { _loadConflictCount(cb); };
      } catch (e) {
        _loadConflictCount(cb);
      }
    });

    window.addEventListener('online',  _onOnline);
    window.addEventListener('offline', _onOffline);
  }

  function _loadConflictCount(cb) {
    if (!_db) { if (cb) cb(); return; }
    try {
      var tx  = _db.transaction([STORE_CONFLICTS], 'readonly');
      var req = tx.objectStore(STORE_CONFLICTS).count();
      req.onsuccess = function (e) {
        _conflictCount = e.target.result || 0;
        _updateConflictIndicator();
        if (cb) cb();
      };
      req.onerror = function () { if (cb) cb(); };
    } catch (e) {
      if (cb) cb();
    }
  }

  // ── Public: store rows after first successful fetch ───────

  function storeRows(rows) {
    if (!_db || !rows || !rows.length) return;
    try {
      var tx    = _db.transaction([STORE_ROWS], 'readwrite');
      var store = tx.objectStore(STORE_ROWS);
      rows.forEach(function (row) {
        if (row._row_index) store.put(row);
      });
      tx.onerror = function (e) {
        console.error('[offline.js] storeRows tx failed:', e.target.error);
      };
    } catch (e) {
      console.error('[offline.js] storeRows failed:', e);
    }
  }

  // ── Public: load all rows from IDB ───────────────────────

  function getAllRows(cb) {
    if (!_db) { cb([]); return; }
    try {
      var tx  = _db.transaction([STORE_ROWS], 'readonly');
      var req = tx.objectStore(STORE_ROWS).getAll();
      req.onsuccess = function (e) { cb(e.target.result || []); };
      req.onerror   = function ()  { cb([]); };
    } catch (e) {
      cb([]);
    }
  }

  // ── Public: sync timestamp ───────────────────────────────

  var LS_SYNC_KEY = 'sync_last_modified';

  function getLastSyncTime() {
    var val = localStorage.getItem(LS_SYNC_KEY);
    return val ? Number(val) : 0;
  }

  function setLastSyncTime(ts) {
    if (ts) localStorage.setItem(LS_SYNC_KEY, String(ts));
  }

  // ── Public: pending row index lookup ─────────────────────

  function getPendingRowIndexes(cb) {
    if (!_db) { cb({}); return; }
    try {
      var tx  = _db.transaction([STORE_QUEUE], 'readonly');
      var req = tx.objectStore(STORE_QUEUE).getAll();
      req.onsuccess = function (e) {
        var entries = e.target.result || [];
        var map = {};
        entries.forEach(function (entry) {
          var ri = entry.rowData && entry.rowData._row_index;
          if (ri) map[String(ri)] = true;
        });
        cb(map);
      };
      req.onerror = function () { cb({}); };
    } catch (e) {
      cb({});
    }
  }

  // ── Public: get all conflicts ─────────────────────────────

  /**
   * Return all conflict objects stored in the conflicts IDB store.
   * Each object shape:
   *   { id, offlineData, serverData, liveRowIndex, conflictSheetRow,
   *     queuedAt, detectedAt }
   *
   * callback(conflicts[])
   */
  function getConflicts(cb) {
    if (!_db) { cb([]); return; }
    try {
      var tx  = _db.transaction([STORE_CONFLICTS], 'readonly');
      var req = tx.objectStore(STORE_CONFLICTS).getAll();
      req.onsuccess = function (e) { cb(e.target.result || []); };
      req.onerror   = function ()  { cb([]); };
    } catch (e) {
      cb([]);
    }
  }

  // ── Public: resolve a conflict ────────────────────────────

  /**
   * Resolve a conflict by ID (IDB auto key).
   *
   * conflictId   — the `id` field of the conflict object
   * keepVersion  — 'online' | 'offline' | 'merge'
   * mergedData   — row data object to write when keepVersion === 'offline'
   *                or 'merge'; null for 'online' (live row stays unchanged)
   * callback({ success, error })
   *
   * Steps:
   *   1. Calls Sheets.resolveConflict to delete the conflict copy from Sheets
   *      and optionally write merged data to the live row.
   *   2. Removes the conflict entry from IDB.
   *   3. Decrements _conflictCount and updates the indicator.
   */
  function resolveConflict(conflictId, keepVersion, mergedData, cb) {
    if (!_db) { if (cb) cb({ success: false, error: 'IDB unavailable' }); return; }

    // Load the conflict entry first
    try {
      var tx  = _db.transaction([STORE_CONFLICTS], 'readonly');
      var req = tx.objectStore(STORE_CONFLICTS).get(conflictId);
      req.onsuccess = function (e) {
        var conflict = e.target.result;
        if (!conflict) {
          if (cb) cb({ success: false, error: 'Conflict not found.' });
          return;
        }

        var dataToWrite = (keepVersion === 'online') ? null : mergedData;

        Sheets.resolveConflict(
          conflict.conflictSheetRow,
          conflict.liveRowIndex,
          keepVersion,
          dataToWrite,
          function (result) {
            if (!result.success) {
              if (cb) cb(result);
              return;
            }
            // Remove from IDB
            _removeConflict(conflictId, function () {
              _conflictCount = Math.max(0, _conflictCount - 1);
              _updateConflictIndicator();
              if (cb) cb({ success: true });
            });
          }
        );
      };
      req.onerror = function () {
        if (cb) cb({ success: false, error: 'Failed to read conflict from IDB.' });
      };
    } catch (e) {
      if (cb) cb({ success: false, error: String(e) });
    }
  }

  // ── Public: queue or execute a row save ───────────────────

  function queueSave(rowData, cb) {
    if (_isOnline && !_isSyncing) {
      Sheets.writeRow(rowData, function (result) {
        if (result.success) {
          if (result.rowIndex) {
            _upsertRow(_mergeRowIndex(rowData, result.rowIndex));
          }
          if (cb) cb(result);
          return;
        }

        if (!navigator.onLine || _isNetworkError(result.error)) {
          _enqueue(rowData);
          if (cb) cb({ success: true, rowIndex: rowData._row_index || null });
        } else {
          if (cb) cb(result);
        }
      });
      return;
    }

    _enqueue(rowData);
    if (cb) cb({ success: true, rowIndex: rowData._row_index || null });
  }

  // ── Internal: add one entry to the sync queue ─────────────

  function _enqueue(rowData) {
    var queueKey = rowData._row_index
      ? 'r' + rowData._row_index
      : (rowData._local_id ||
         ('n' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)));

    var entry = {
      _queue_key: queueKey,
      rowData:    rowData,
      queuedAt:   Date.now(),
      attempts:   0
    };

    if (_db) {
      try {
        var tx = _db.transaction([STORE_QUEUE], 'readwrite');
        tx.objectStore(STORE_QUEUE).put(entry);
        tx.onerror = function (e) {
          console.error('[offline.js] _enqueue IDB write failed:', e.target.error);
        };
      } catch (e) {
        console.error('[offline.js] _enqueue failed:', e);
      }
    }

    _pendingCount++;
    _updateIndicator();
    console.log('[offline.js] Queued save — key:', queueKey, 'pending:', _pendingCount);
  }

  // ── Internal: drain the sync queue on reconnect ───────────

  function _processQueue() {
    if (!_db || _isSyncing || !_isOnline) return;

    try {
      var tx  = _db.transaction([STORE_QUEUE], 'readonly');
      var req = tx.objectStore(STORE_QUEUE).getAll();

      req.onsuccess = function (e) {
        var entries = e.target.result || [];
        if (!entries.length) {
          _pendingCount = 0;
          _updateIndicator();
          return;
        }

        _isSyncing    = true;
        _pendingCount = entries.length;
        _updateIndicator();
        console.log('[offline.js] Draining queue —', entries.length, 'entries');
        _drainNext(entries, 0);
      };

      req.onerror = function (e) {
        console.error('[offline.js] _processQueue getAll failed:', e.target.error);
      };
    } catch (e) {
      console.error('[offline.js] _processQueue failed:', e);
    }
  }

  function _drainNext(entries, idx) {
    if (!_isOnline) {
      _isSyncing = false;
      _updateIndicator();
      return;
    }

    if (idx >= entries.length) {
      _isSyncing    = false;
      _pendingCount = 0;
      _updateIndicator();
      console.log('[offline.js] Queue drained');
      return;
    }

    var entry = entries[idx];

    // Attach the queue timestamp so the server can detect conflicts.
    // _queued_at tells the server when this offline edit was made.
    // If the live row's last_modified is newer, someone else edited it
    // while this user was offline → conflict.
    var rowDataWithMeta = _shallowCopy(entry.rowData);
    rowDataWithMeta._queued_at = entry.queuedAt;

    Sheets.writeRow(rowDataWithMeta, function (result) {
      if (result.success) {
        // ── Success ─────────────────────────────────────────
        _removeFromQueue(entry._queue_key);

        if (result.rowIndex) {
          _upsertRow(_mergeRowIndex(entry.rowData, result.rowIndex));

          if (entry.rowData._local_id &&
              typeof Grid !== 'undefined' && Grid.updateRowIndex) {
            Grid.updateRowIndex(entry.rowData._local_id, result.rowIndex);
          }
        }

        _pendingCount = Math.max(0, _pendingCount - 1);
        _updateIndicator();
        _drainNext(entries, idx + 1);

      } else if (result.conflict === true) {
        // ── Conflict detected ────────────────────────────────
        // Server found that the live row was modified after this user
        // went offline. The offline version has been saved as a conflict
        // copy in the Conflicts sheet tab. We store the conflict locally
        // so the manager can review it, and continue draining.
        console.warn('[offline.js] Conflict detected for queue key:', entry._queue_key);

        _removeFromQueue(entry._queue_key);

        _storeConflict({
          offlineData:      entry.rowData,
          serverData:       result.serverRow || {},
          liveRowIndex:     entry.rowData._row_index || null,
          conflictSheetRow: result.conflictSheetRow || null,
          queuedAt:         entry.queuedAt,
          detectedAt:       Date.now()
        });

        _pendingCount = Math.max(0, _pendingCount - 1);
        _updateIndicator();
        _drainNext(entries, idx + 1);

      } else {
        // ── Regular failure ──────────────────────────────────
        var attempts = (entry.attempts || 0) + 1;

        if (!_isOnline || attempts >= MAX_ATTEMPTS) {
          _isSyncing = false;
          _updateIndicator();
          console.warn('[offline.js] Drain stopped after', attempts,
            'attempts on', entry._queue_key, '—', result.error);
          return;
        }

        entry.attempts = attempts;
        if (_db) {
          try {
            var tx2 = _db.transaction([STORE_QUEUE], 'readwrite');
            tx2.objectStore(STORE_QUEUE).put(entry);
          } catch (e2) { /* non-fatal */ }
        }

        setTimeout(function () {
          _drainNext(entries, idx);
        }, RETRY_DELAY_MS);
      }
    });
  }

  // ── Internal: store a conflict in IDB ────────────────────

  function _storeConflict(data) {
    if (!_db) return;
    try {
      var tx  = _db.transaction([STORE_CONFLICTS], 'readwrite');
      var req = tx.objectStore(STORE_CONFLICTS).add(data);
      req.onsuccess = function () {
        _conflictCount++;
        _updateConflictIndicator();
      };
      tx.onerror = function (e) {
        console.error('[offline.js] _storeConflict failed:', e.target.error);
      };
    } catch (e) {
      console.error('[offline.js] _storeConflict error:', e);
    }
  }

  function _removeConflict(id, cb) {
    if (!_db) { if (cb) cb(); return; }
    try {
      var tx  = _db.transaction([STORE_CONFLICTS], 'readwrite');
      var req = tx.objectStore(STORE_CONFLICTS).delete(id);
      req.onsuccess = function () { if (cb) cb(); };
      req.onerror   = function () { if (cb) cb(); };
    } catch (e) {
      if (cb) cb();
    }
  }

  // ── IDB helpers ───────────────────────────────────────────

  function _removeFromQueue(key) {
    if (!_db) return;
    try {
      var tx = _db.transaction([STORE_QUEUE], 'readwrite');
      tx.objectStore(STORE_QUEUE).delete(key);
    } catch (e) { /* non-fatal */ }
  }

  function _upsertRow(row) {
    if (!_db || !row._row_index) return;
    try {
      var tx = _db.transaction([STORE_ROWS], 'readwrite');
      tx.objectStore(STORE_ROWS).put(row);
    } catch (e) { /* non-fatal */ }
  }

  function _mergeRowIndex(rowData, rowIndex) {
    var merged = _shallowCopy(rowData);
    merged._row_index = rowIndex;
    return merged;
  }

  function _shallowCopy(obj) {
    var copy = {};
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      copy[keys[i]] = obj[keys[i]];
    }
    return copy;
  }

  // ── Network helpers ───────────────────────────────────────

  function _isNetworkError(msg) {
    if (!msg) return false;
    return /unable to reach|network|connection|failed to fetch/i.test(msg);
  }

  // ── Online / offline event handlers ──────────────────────

  function _onOnline() {
    _isOnline = true;
    console.log('[offline.js] Network restored — processing queue');
    _processQueue();
  }

  function _onOffline() {
    _isOnline = false;
    console.log('[offline.js] Network lost — saves will be queued');
    _updateIndicator();
  }

  // ── Sync indicator ────────────────────────────────────────

  function _updateIndicator() {
    var el = document.getElementById('sync-indicator');
    if (!el) return;

    clearTimeout(_syncClearTimer);

    if (!_isOnline) {
      el.innerHTML =
        '<span class="sync-dot sync-dot--offline"></span>' +
        '<span class="sync-label">Offline \u2014 changes queued</span>';
      return;
    }

    if (_pendingCount > 0 || _isSyncing) {
      var n = _pendingCount;
      el.innerHTML =
        '<span class="sync-dot sync-dot--pending"></span>' +
        '<span class="sync-label">\u25cf ' + n +
        ' change' + (n === 1 ? '' : 's') + ' pending sync</span>';
      return;
    }

    // All clear — show "✓ All synced" briefly, then hide
    el.innerHTML =
      '<span class="sync-check">\u2713</span>' +
      '<span class="sync-label">All synced</span>';
    _syncClearTimer = setTimeout(function () {
      el.innerHTML = '';
    }, SYNCED_CLEAR_MS);
  }

  // ── Conflict indicator ────────────────────────────────────
  //
  // A separate indicator rendered next to #sync-indicator in the
  // status bar. Only managers see the panel — all roles see the count.
  // The indicator is lazily created so it can appear in any status bar.

  function _updateConflictIndicator() {
    var statusbar = document.getElementById('app-statusbar');
    if (!statusbar) return;

    var el = document.getElementById('conflict-indicator');

    if (_conflictCount === 0) {
      if (el) el.setAttribute('hidden', '');
      return;
    }

    if (!el) {
      el = document.createElement('div');
      el.id = 'conflict-indicator';
      // Insert after sync-indicator if present, otherwise append
      var syncEl = document.getElementById('sync-indicator');
      if (syncEl && syncEl.nextSibling) {
        statusbar.insertBefore(el, syncEl.nextSibling);
      } else {
        statusbar.appendChild(el);
      }
    }

    el.removeAttribute('hidden');

    var role = (sessionStorage.getItem('app_role') || '').trim().toLowerCase();
    var label = '\u26a0 ' + _conflictCount +
                ' conflict' + (_conflictCount === 1 ? '' : 's') +
                ' need' + (_conflictCount === 1 ? 's' : '') + ' review';

    if (role === 'manager') {
      el.innerHTML =
        '<button class="conflict-btn" id="conflict-open-btn">' + label + '</button>';
      var btn = el.querySelector('#conflict-open-btn');
      if (btn) {
        btn.onclick = function () { _openConflictPanel(); };
      }
    } else {
      el.innerHTML = '<span class="conflict-label">' + label + '</span>';
    }
  }

  // ── Conflict panel (manager only) ─────────────────────────
  //
  // Side-by-side view of each conflict:
  //   - Field diff table (live version vs offline version)
  //   - Keep Live / Keep Offline / Merge Manually options
  //   - Merge Manually expands editable inputs for all fields

  function _openConflictPanel() {
    if (document.getElementById('conflict-panel-overlay')) return;

    getConflicts(function (conflicts) {
      _renderConflictPanel(conflicts);
    });
  }

  function _renderConflictPanel(conflicts) {
    // Remove any stale overlay
    var old = document.getElementById('conflict-panel-overlay');
    if (old) old.parentNode.removeChild(old);

    var overlay = document.createElement('div');
    overlay.id = 'conflict-panel-overlay';

    var panel = document.createElement('div');
    panel.id = 'conflict-panel';

    // ── Header ──
    var header = document.createElement('div');
    header.className = 'cp-header';
    header.innerHTML =
      '<span class="cp-title">\u26a0 Conflicts Need Review' +
      (conflicts.length ? ' (' + conflicts.length + ')' : '') + '</span>' +
      '<button class="cp-close" id="cp-close-btn" title="Close">\u00d7</button>';
    panel.appendChild(header);

    // ── Body ──
    var body = document.createElement('div');
    body.id = 'cp-body';
    body.className = 'cp-body';

    if (!conflicts.length) {
      body.innerHTML =
        '<div class="cp-empty">No conflicts pending. All caught up.</div>';
    } else {
      conflicts.forEach(function (conflict) {
        body.appendChild(_buildConflictCard(conflict));
      });
    }

    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Close on overlay click or ×
    document.getElementById('cp-close-btn').addEventListener('click', _closeConflictPanel);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) _closeConflictPanel();
    });
  }

  function _buildConflictCard(conflict) {
    var card = document.createElement('div');
    card.className = 'cp-card';
    card.setAttribute('data-conflict-id', String(conflict.id));

    var offline  = conflict.offlineData  || {};
    var server   = conflict.serverData   || {};
    var queuedAt = conflict.queuedAt     ? new Date(conflict.queuedAt) : null;
    var detected = conflict.detectedAt   ? new Date(conflict.detectedAt) : null;
    var rowId    = offline.id || offline._row_index || server.id || '(unknown)';

    // ── Card header ──
    var ch = document.createElement('div');
    ch.className = 'cp-card-header';
    ch.innerHTML =
      '<span class="cp-card-title">Row ' + _escHtml(String(rowId)) + '</span>' +
      (queuedAt ? '<span class="cp-card-meta">Offline edit: ' +
        _formatDate(queuedAt) + '</span>' : '') +
      (detected ? '<span class="cp-card-meta">Detected: ' +
        _formatDate(detected) + '</span>' : '');
    card.appendChild(ch);

    // ── Diff table ──
    var diffFields = _buildDiff(offline, server);

    var tbl = document.createElement('table');
    tbl.className = 'cp-diff-table';
    tbl.innerHTML =
      '<thead><tr>' +
      '<th>Field</th>' +
      '<th>Live Version</th>' +
      '<th>Your Offline Edit</th>' +
      '</tr></thead>';

    var tbody = document.createElement('tbody');
    diffFields.forEach(function (d) {
      var tr = document.createElement('tr');
      tr.innerHTML =
        '<td class="cp-field-name">' + _escHtml(d.key) + '</td>' +
        '<td class="cp-val cp-val--live">'    + _escHtml(String(d.live    || '')) + '</td>' +
        '<td class="cp-val cp-val--offline">' + _escHtml(String(d.offline || '')) + '</td>';
      tbody.appendChild(tr);
    });

    if (!diffFields.length) {
      var trNone = document.createElement('tr');
      trNone.innerHTML =
        '<td colspan="3" class="cp-no-diff">No field differences detected.</td>';
      tbody.appendChild(trNone);
    }

    tbl.appendChild(tbody);
    card.appendChild(tbl);

    // ── Action buttons ──
    var actions = document.createElement('div');
    actions.className = 'cp-actions';

    var keepLiveBtn = document.createElement('button');
    keepLiveBtn.className = 'cp-btn cp-btn--secondary';
    keepLiveBtn.textContent = 'Keep Live Version';
    keepLiveBtn.title = 'Discard your offline edit. The live row stays as-is.';
    keepLiveBtn.onclick = function () {
      _resolveFromPanel(conflict.id, 'online', null, card);
    };

    var keepOfflineBtn = document.createElement('button');
    keepOfflineBtn.className = 'cp-btn cp-btn--primary';
    keepOfflineBtn.textContent = 'Keep Offline Version';
    keepOfflineBtn.title = 'Apply your offline edit to the live row.';
    keepOfflineBtn.onclick = function () {
      _resolveFromPanel(conflict.id, 'offline', offline, card);
    };

    var mergeBtn = document.createElement('button');
    mergeBtn.className = 'cp-btn cp-btn--ghost';
    mergeBtn.textContent = 'Merge Manually\u2026';
    mergeBtn.onclick = function () {
      _expandMergeForm(conflict, card);
      mergeBtn.setAttribute('hidden', '');
    };

    actions.appendChild(keepLiveBtn);
    actions.appendChild(keepOfflineBtn);
    actions.appendChild(mergeBtn);
    card.appendChild(actions);

    // ── Merge form (hidden until Merge Manually is clicked) ──
    var mergeForm = _buildMergeForm(conflict);
    mergeForm.setAttribute('hidden', '');
    card.appendChild(mergeForm);

    return card;
  }

  // Build the list of fields that differ between live and offline versions.
  // Skips internal/system fields (_row_index, _last_modified, etc.).
  function _buildDiff(offline, server) {
    var SKIP = { _row_index: 1, _last_modified: 1, _created_date: 1,
                 _local_id: 1, _locked: 1, _queued_at: 1 };
    var allKeys = {};
    Object.keys(offline).forEach(function (k) { allKeys[k] = 1; });
    Object.keys(server).forEach(function (k) { allKeys[k] = 1; });

    var diffs = [];
    Object.keys(allKeys).forEach(function (k) {
      if (SKIP[k]) return;
      var a = String(offline[k] != null ? offline[k] : '');
      var b = String(server[k]  != null ? server[k]  : '');
      if (a !== b) {
        diffs.push({ key: k, offline: a, live: b });
      }
    });
    diffs.sort(function (a, b) { return a.key < b.key ? -1 : 1; });
    return diffs;
  }

  // Build the manual merge form: editable inputs for every non-system field.
  // Pre-filled with the offline version's values so the manager adjusts only
  // what needs changing.
  function _buildMergeForm(conflict) {
    var offline = conflict.offlineData || {};
    var server  = conflict.serverData  || {};
    var SKIP = { _row_index: 1, _last_modified: 1, _created_date: 1,
                 _local_id: 1, _locked: 1, _queued_at: 1 };

    var form = document.createElement('div');
    form.className = 'cp-merge-form';

    var heading = document.createElement('div');
    heading.className = 'cp-merge-heading';
    heading.textContent = 'Edit fields below, then click Save Merge.';
    form.appendChild(heading);

    // Show all fields that appear in either version
    var allKeys = {};
    Object.keys(offline).forEach(function (k) { allKeys[k] = 1; });
    Object.keys(server).forEach(function (k)  { allKeys[k] = 1; });
    var sortedKeys = Object.keys(allKeys).filter(function (k) { return !SKIP[k]; });
    sortedKeys.sort();

    var inputMap = {};

    sortedKeys.forEach(function (k) {
      var row = document.createElement('div');
      row.className = 'cp-merge-row';

      var label = document.createElement('label');
      label.className = 'cp-merge-label';
      label.textContent = k;

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'cp-merge-input';
      input.value = String(offline[k] != null ? offline[k] : '');
      input.setAttribute('data-key', k);
      input.title =
        'Live: ' + String(server[k] != null ? server[k] : '') +
        ' | Offline: ' + String(offline[k] != null ? offline[k] : '');

      // Highlight fields that differ from the live version
      var liveVal = String(server[k] != null ? server[k] : '');
      if (input.value !== liveVal) {
        input.classList.add('cp-merge-input--changed');
      }

      inputMap[k] = input;
      row.appendChild(label);
      row.appendChild(input);
      form.appendChild(row);
    });

    var saveBtn = document.createElement('button');
    saveBtn.className = 'cp-btn cp-btn--primary';
    saveBtn.textContent = 'Save Merge';
    saveBtn.style.marginTop = '12px';
    saveBtn.onclick = function () {
      var mergedData = _shallowCopy(offline);
      sortedKeys.forEach(function (k) {
        if (inputMap[k]) mergedData[k] = inputMap[k].value;
      });
      var card = form.closest('.cp-card');
      _resolveFromPanel(conflict.id, 'merge', mergedData, card);
    };

    form.appendChild(saveBtn);
    return form;
  }

  function _expandMergeForm(conflict, card) {
    var form = card.querySelector('.cp-merge-form');
    if (form) form.removeAttribute('hidden');
  }

  function _resolveFromPanel(conflictId, keepVersion, mergedData, card) {
    // Show spinner on the card while waiting
    var actions = card.querySelector('.cp-actions');
    var mergeForm = card.querySelector('.cp-merge-form');
    if (actions) actions.innerHTML = '<span class="cp-resolving">Resolving\u2026</span>';
    if (mergeForm) mergeForm.setAttribute('hidden', '');

    resolveConflict(conflictId, keepVersion, mergedData, function (result) {
      if (result.success) {
        // Fade out and remove the card
        card.style.opacity = '0.4';
        card.style.transition = 'opacity 0.3s';
        setTimeout(function () {
          if (card.parentNode) card.parentNode.removeChild(card);

          // If no more conflicts, show empty state
          var body = document.getElementById('cp-body');
          if (body && !body.querySelector('.cp-card')) {
            body.innerHTML =
              '<div class="cp-empty">All conflicts resolved. No more pending.</div>';
          }

          // Close panel if empty
          if (_conflictCount === 0) {
            setTimeout(_closeConflictPanel, 600);
          }
        }, 300);
      } else {
        if (actions) {
          actions.innerHTML = '';
          var errEl = document.createElement('span');
          errEl.className = 'cp-resolve-error';
          errEl.textContent = 'Error: ' + (result.error || 'Unknown error');
          actions.appendChild(errEl);
        }
      }
    });
  }

  function _closeConflictPanel() {
    var overlay = document.getElementById('conflict-panel-overlay');
    if (overlay) overlay.parentNode.removeChild(overlay);
  }

  // ── Formatting helpers ────────────────────────────────────

  function _formatDate(d) {
    if (!(d instanceof Date) || isNaN(d)) return '';
    var months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[d.getMonth()] + ' ' + d.getDate() + ', ' +
           d.getFullYear() + ' at ' +
           String(d.getHours()).padStart(2, '0') + ':' +
           String(d.getMinutes()).padStart(2, '0');
  }

  function _escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Inject styles ─────────────────────────────────────────

  (function _injectStyles() {
    if (document.getElementById('offline-styles')) return;
    var s = document.createElement('style');
    s.id = 'offline-styles';
    s.textContent = [

      // ── Sync indicator ────────────────────────────────────

      '#sync-indicator {',
        'display: flex;',
        'align-items: center;',
        'gap: 6px;',
      '}',

      '.sync-label {',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'letter-spacing: 0.10em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
      '}',

      '.sync-dot {',
        'width: 6px;',
        'height: 6px;',
        'border-radius: 50%;',
        'flex-shrink: 0;',
      '}',

      '.sync-dot--offline {',
        'background: var(--text-secondary);',
      '}',

      '.sync-dot--pending {',
        'background: var(--accent);',
        'animation: sync-pulse 1.2s ease-in-out infinite;',
      '}',

      '@keyframes sync-pulse {',
        '0%, 100% { opacity: 1;   transform: scale(1);    }',
        '50%       { opacity: 0.3; transform: scale(0.55); }',
      '}',

      '.sync-check {',
        'font-size: 11px;',
        'color: var(--color-success);',
        'line-height: 1;',
      '}',

      // ── Conflict indicator ─────────────────────────────────

      '#conflict-indicator {',
        'display: flex;',
        'align-items: center;',
      '}',

      '.conflict-label {',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'letter-spacing: 0.10em;',
        'text-transform: uppercase;',
        'color: #e8a030;',
      '}',

      '.conflict-btn {',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'letter-spacing: 0.10em;',
        'text-transform: uppercase;',
        'color: #e8a030;',
        'background: rgba(232,160,48,0.08);',
        'border: 1px solid rgba(232,160,48,0.35);',
        'padding: 2px 8px;',
        'cursor: pointer;',
        'transition: background 0.15s;',
        'white-space: nowrap;',
      '}',

      '.conflict-btn:hover {',
        'background: rgba(232,160,48,0.18);',
      '}',

      // ── Conflict panel overlay ────────────────────────────

      '#conflict-panel-overlay {',
        'position: fixed;',
        'inset: 0;',
        'background: rgba(0,0,0,0.55);',
        'z-index: 10000;',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        'padding: 24px;',
      '}',

      '#conflict-panel {',
        'background: var(--bg-surface, #1a2535);',
        'border: 1px solid var(--border, #2a3a50);',
        'width: 100%;',
        'max-width: 860px;',
        'max-height: 80vh;',
        'display: flex;',
        'flex-direction: column;',
        'overflow: hidden;',
        'box-shadow: 0 16px 48px rgba(0,0,0,0.5);',
      '}',

      '.cp-header {',
        'display: flex;',
        'align-items: center;',
        'justify-content: space-between;',
        'padding: 14px 20px;',
        'border-bottom: 1px solid var(--border, #2a3a50);',
        'flex-shrink: 0;',
      '}',

      '.cp-title {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 13px;',
        'letter-spacing: 0.08em;',
        'text-transform: uppercase;',
        'color: #e8a030;',
      '}',

      '.cp-close {',
        'background: transparent;',
        'border: none;',
        'color: var(--text-secondary);',
        'font-size: 20px;',
        'line-height: 1;',
        'cursor: pointer;',
        'padding: 0 4px;',
        'transition: color 0.15s;',
      '}',

      '.cp-close:hover { color: var(--text-on-navy); }',

      '.cp-body {',
        'overflow-y: auto;',
        'padding: 16px 20px;',
        'display: flex;',
        'flex-direction: column;',
        'gap: 20px;',
        'flex: 1;',
      '}',

      '.cp-empty {',
        'font-family: var(--font-body);',
        'font-size: 13px;',
        'color: var(--text-secondary);',
        'text-align: center;',
        'padding: 32px 0;',
      '}',

      // ── Conflict card ──────────────────────────────────────

      '.cp-card {',
        'border: 1px solid var(--border, #2a3a50);',
        'padding: 14px 16px 12px;',
      '}',

      '.cp-card-header {',
        'display: flex;',
        'align-items: baseline;',
        'gap: 16px;',
        'margin-bottom: 10px;',
        'flex-wrap: wrap;',
      '}',

      '.cp-card-title {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 12px;',
        'letter-spacing: 0.06em;',
        'text-transform: uppercase;',
        'color: var(--text-on-navy);',
      '}',

      '.cp-card-meta {',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'color: var(--text-secondary);',
        'letter-spacing: 0.06em;',
      '}',

      // ── Diff table ────────────────────────────────────────

      '.cp-diff-table {',
        'width: 100%;',
        'border-collapse: collapse;',
        'font-family: var(--font-body);',
        'font-size: 12px;',
        'margin-bottom: 10px;',
      '}',

      '.cp-diff-table th {',
        'font-family: var(--font-mono);',
        'font-size: 9px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
        'text-align: left;',
        'padding: 4px 8px;',
        'border-bottom: 1px solid var(--border);',
      '}',

      '.cp-diff-table td {',
        'padding: 4px 8px;',
        'border-bottom: 1px solid rgba(42,58,80,0.5);',
        'vertical-align: top;',
        'color: var(--text-on-navy);',
      '}',

      '.cp-field-name {',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'color: var(--text-secondary);',
        'white-space: nowrap;',
      '}',

      '.cp-val--live {',
        'color: var(--text-secondary);',
      '}',

      '.cp-val--offline {',
        'color: #7ec8a0;',
      '}',

      '.cp-no-diff {',
        'color: var(--text-secondary);',
        'font-style: italic;',
        'text-align: center;',
        'padding: 8px;',
      '}',

      // ── Action buttons ────────────────────────────────────

      '.cp-actions {',
        'display: flex;',
        'gap: 8px;',
        'align-items: center;',
        'flex-wrap: wrap;',
      '}',

      '.cp-btn {',
        'height: 28px;',
        'padding: 0 14px;',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 10px;',
        'letter-spacing: 0.10em;',
        'text-transform: uppercase;',
        'cursor: pointer;',
        'border: 1px solid;',
        'transition: background 0.15s, color 0.15s;',
        'white-space: nowrap;',
      '}',

      '.cp-btn--primary {',
        'background: var(--accent, #c9973a);',
        'border-color: var(--accent, #c9973a);',
        'color: var(--bg-navy, #0f1e30);',
      '}',

      '.cp-btn--primary:hover {',
        'background: var(--accent-bright, #e8b04a);',
        'border-color: var(--accent-bright, #e8b04a);',
      '}',

      '.cp-btn--secondary {',
        'background: transparent;',
        'border-color: var(--border-navy, #2a3a50);',
        'color: var(--text-muted-navy, #8fa5bf);',
      '}',

      '.cp-btn--secondary:hover {',
        'background: rgba(255,255,255,0.06);',
        'color: var(--text-on-navy);',
      '}',

      '.cp-btn--ghost {',
        'background: transparent;',
        'border-color: transparent;',
        'color: var(--text-secondary);',
        'font-weight: 400;',
        'text-decoration: underline;',
        'padding: 0 4px;',
      '}',

      '.cp-btn--ghost:hover { color: var(--text-on-navy); }',

      '.cp-resolving {',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'color: var(--text-secondary);',
        'letter-spacing: 0.10em;',
        'text-transform: uppercase;',
      '}',

      '.cp-resolve-error {',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'color: #c0392b;',
        'letter-spacing: 0.08em;',
      '}',

      // ── Merge form ────────────────────────────────────────

      '.cp-merge-form {',
        'margin-top: 12px;',
        'padding-top: 12px;',
        'border-top: 1px solid var(--border, #2a3a50);',
      '}',

      '.cp-merge-heading {',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'letter-spacing: 0.10em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
        'margin-bottom: 10px;',
      '}',

      '.cp-merge-row {',
        'display: flex;',
        'align-items: center;',
        'gap: 10px;',
        'margin-bottom: 6px;',
      '}',

      '.cp-merge-label {',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'color: var(--text-secondary);',
        'width: 180px;',
        'flex-shrink: 0;',
        'letter-spacing: 0.04em;',
      '}',

      '.cp-merge-input {',
        'flex: 1;',
        'height: 26px;',
        'padding: 0 8px;',
        'background: var(--bg-navy, #0f1e30);',
        'border: 1px solid var(--border-navy, #2a3a50);',
        'color: var(--text-on-navy, #e8edf3);',
        'font-family: var(--font-body);',
        'font-size: 12px;',
      '}',

      '.cp-merge-input--changed {',
        'border-color: rgba(201,151,58,0.5);',
        'background: rgba(201,151,58,0.04);',
      '}',

      '.cp-merge-input:focus {',
        'outline: none;',
        'border-color: var(--accent, #c9973a);',
      '}',

    ].join('\n');
    document.head.appendChild(s);
  }());

  // ── Expose ────────────────────────────────────────────────

  return {
    init:                 init,
    storeRows:            storeRows,
    getAllRows:            getAllRows,
    queueSave:            queueSave,
    getLastSyncTime:      getLastSyncTime,
    setLastSyncTime:      setLastSyncTime,
    getPendingRowIndexes: getPendingRowIndexes,
    getConflicts:         getConflicts,
    resolveConflict:      resolveConflict
  };

}());
