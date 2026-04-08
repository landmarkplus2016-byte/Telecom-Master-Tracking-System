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
//   - Show "● N changes pending sync" / "✓ All synced" indicator
//
// Public API:
//   Offline.init(callback)               — open IDB, load queue count
//   Offline.storeRows(rows)              — bulk-store rows after fetch
//   Offline.getAllRows(callback)          — load all rows from IDB
//   Offline.queueSave(rowData, callback) — route save online/offline
//
// Called by:
//   app.js  — init, storeRows, getAllRows
//   grid.js — queueSave (replaces direct Sheets.writeRow call)
//
// Calls back into grid.js:
//   Grid.updateRowIndex(localId, rowIndex) — patch in-memory _data after
//   a queued new-row save resolves with the real sheet row index
//
// IDB schema (DB: telecom_tracker, v1):
//   rows       — keyPath: _row_index  — full row objects from server
//   sync_queue — keyPath: _queue_key  — pending saves (last-write-wins)
//
// ============================================================

var Offline = (function () {

  // ── Constants ─────────────────────────────────────────────

  var DB_NAME    = 'telecom_tracker';
  var DB_VERSION = 1;
  var STORE_ROWS  = 'rows';
  var STORE_QUEUE = 'sync_queue';

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
  var _syncClearTimer = null;

  // ── IndexedDB ─────────────────────────────────────────────

  function _openDB(cb) {
    var req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_ROWS)) {
        db.createObjectStore(STORE_ROWS, { keyPath: '_row_index' });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: '_queue_key' });
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
   * Open IDB, load the pending queue count, then call cb.
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

      // Load any pre-existing queue count so the indicator is
      // accurate on startup (e.g. pending items from a previous session)
      try {
        var tx  = db.transaction([STORE_QUEUE], 'readonly');
        var req = tx.objectStore(STORE_QUEUE).count();
        req.onsuccess = function (e) {
          _pendingCount = e.target.result || 0;
          _updateIndicator();
          if (cb) cb();
        };
        req.onerror = function () { if (cb) cb(); };
      } catch (e) {
        if (cb) cb();
      }
    });

    window.addEventListener('online',  _onOnline);
    window.addEventListener('offline', _onOffline);
  }

  // ── Public: store rows after first successful fetch ───────

  /**
   * Bulk-write all rows from the initial full fetch into IDB.
   * Only rows with a _row_index (server-assigned key) are stored.
   * Subsequent delta syncs will call this with individual updated rows.
   * Runs asynchronously — no callback needed.
   */
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

  // ── Public: load all rows from IDB (offline startup) ──────

  /**
   * Return all cached rows from the IDB rows store.
   * Used by app.js when the network is unavailable on startup,
   * or as a fallback when fetchAllRows fails.
   *
   * callback(rows[]) — empty array if IDB unavailable or empty
   */
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
  //
  // The sync cursor is the serverTime returned by the last successful
  // getRows call. Stored in localStorage so it survives page reloads.
  // All subsequent fetchDelta calls pass this value as `since`.

  var LS_SYNC_KEY = 'sync_last_modified';

  function getLastSyncTime() {
    var val = localStorage.getItem(LS_SYNC_KEY);
    return val ? Number(val) : 0;
  }

  function setLastSyncTime(ts) {
    if (ts) localStorage.setItem(LS_SYNC_KEY, String(ts));
  }

  // ── Public: pending row index lookup ─────────────────────
  //
  // Returns an object { rowIndex: true } for every sync_queue entry
  // that has a real _row_index (existing rows with pending edits).
  // New rows (only a _local_id, no _row_index) are NOT in the map.
  //
  // Used by the delta sync logic to skip server rows that would
  // overwrite in-flight local edits.
  //
  // callback(pendingMap) where pendingMap is { "42": true, "87": true, ... }

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

  // ── Public: queue or execute a row save ───────────────────

  /**
   * Called by grid.js _saveRow in place of Sheets.writeRow.
   *
   * Online (not mid-drain):
   *   → Calls Sheets.writeRow directly.
   *   → Success: updates IDB rows store + calls cb(result).
   *   → Network failure: queues the save, calls cb with optimistic success.
   *   → Real server error (lock, auth): passes result through to grid.js.
   *
   * Offline OR mid-drain:
   *   → Writes entry to IDB sync_queue (last-write-wins per logical row).
   *   → Calls cb({ success:true, rowIndex: existing _row_index or null }).
   *   → grid.js sees success, no error shown; row syncs on next reconnect.
   *
   * rowData must include:
   *   _row_index — for existing rows (update path)
   *   _local_id  — for new rows (assigned by grid.js _saveRow before this call)
   */
  function queueSave(rowData, cb) {
    if (_isOnline && !_isSyncing) {
      // ── Online path: write immediately ────────────────────
      Sheets.writeRow(rowData, function (result) {
        if (result.success) {
          if (result.rowIndex) {
            _upsertRow(_mergeRowIndex(rowData, result.rowIndex));
          }
          if (cb) cb(result);
          return;
        }

        // Distinguish network dropout from real server rejection
        if (!navigator.onLine || _isNetworkError(result.error)) {
          // Network failure: queue and tell grid.js it succeeded (optimistic)
          _enqueue(rowData);
          if (cb) cb({ success: true, rowIndex: rowData._row_index || null });
        } else {
          // Server rejection (lock, auth, validation): pass through to grid.js
          if (cb) cb(result);
        }
      });
      return;
    }

    // ── Offline / mid-drain path: enqueue ─────────────────
    _enqueue(rowData);
    if (cb) cb({ success: true, rowIndex: rowData._row_index || null });
  }

  // ── Internal: add one entry to the sync queue ─────────────

  function _enqueue(rowData) {
    // Queue key: 'r<sheet_row_index>' for existing rows,
    //            local_id for new rows (assigned by grid.js).
    // IDB put() overwrites on same key → last write wins per logical row,
    // so multiple offline edits to the same row collapse into one save.
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
    // Stop immediately if we went offline mid-drain
    if (!_isOnline) {
      _isSyncing = false;
      _updateIndicator();
      return;
    }

    if (idx >= entries.length) {
      // All entries processed — queue is clear
      _isSyncing    = false;
      _pendingCount = 0;
      _updateIndicator();
      console.log('[offline.js] Queue drained');
      return;
    }

    var entry = entries[idx];

    Sheets.writeRow(entry.rowData, function (result) {
      if (result.success) {
        // ── Success ─────────────────────────────────────────
        _removeFromQueue(entry._queue_key);

        if (result.rowIndex) {
          // Update IDB rows store with the server-assigned row index
          _upsertRow(_mergeRowIndex(entry.rowData, result.rowIndex));

          // Patch grid.js in-memory _data so future saves for this
          // row use the real _row_index (prevents duplicate appends)
          if (entry.rowData._local_id &&
              typeof Grid !== 'undefined' && Grid.updateRowIndex) {
            Grid.updateRowIndex(entry.rowData._local_id, result.rowIndex);
          }
        }

        _pendingCount = Math.max(0, _pendingCount - 1);
        _updateIndicator();
        _drainNext(entries, idx + 1);

      } else {
        // ── Failure ─────────────────────────────────────────
        var attempts = (entry.attempts || 0) + 1;

        if (!_isOnline || attempts >= MAX_ATTEMPTS) {
          // Stop draining — remaining entries stay in the queue
          // for the next reconnect event
          _isSyncing = false;
          _updateIndicator();
          console.warn('[offline.js] Drain stopped after', attempts,
            'attempts on', entry._queue_key, '—', result.error);
          return;
        }

        // Update attempt count in IDB and retry after a short pause
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

  // ── IDB helpers ───────────────────────────────────────────

  function _removeFromQueue(key) {
    if (!_db) return;
    try {
      var tx = _db.transaction([STORE_QUEUE], 'readwrite');
      tx.objectStore(STORE_QUEUE).delete(key);
    } catch (e) { /* non-fatal — entry will be overwritten next sync */ }
  }

  function _upsertRow(row) {
    if (!_db || !row._row_index) return;
    try {
      var tx = _db.transaction([STORE_ROWS], 'readwrite');
      tx.objectStore(STORE_ROWS).put(row);
    } catch (e) { /* non-fatal */ }
  }

  // Build a new object with _row_index merged in (avoids mutating rowData)
  function _mergeRowIndex(rowData, rowIndex) {
    var merged = {};
    var keys = Object.keys(rowData);
    for (var i = 0; i < keys.length; i++) {
      merged[keys[i]] = rowData[keys[i]];
    }
    merged._row_index = rowIndex;
    return merged;
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

  // ── Inject styles ─────────────────────────────────────────

  (function _injectStyles() {
    if (document.getElementById('offline-styles')) return;
    var s = document.createElement('style');
    s.id = 'offline-styles';
    s.textContent = [

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

      // Offline: muted grey dot
      '.sync-dot--offline {',
        'background: var(--text-secondary);',
      '}',

      // Pending: amber pulsing dot
      '.sync-dot--pending {',
        'background: var(--accent);',
        'animation: sync-pulse 1.2s ease-in-out infinite;',
      '}',

      '@keyframes sync-pulse {',
        '0%, 100% { opacity: 1;   transform: scale(1);    }',
        '50%       { opacity: 0.3; transform: scale(0.55); }',
      '}',

      // Synced: green check
      '.sync-check {',
        'font-size: 11px;',
        'color: var(--color-success);',
        'line-height: 1;',
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
    getPendingRowIndexes: getPendingRowIndexes
  };

}());
