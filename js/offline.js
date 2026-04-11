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

  // ── Drain lock (multi-tab safety) ─────────────────────────
  //
  // When multiple tabs are open they each see the same IDB queue.
  // Without a lock, all tabs drain simultaneously → duplicate writes
  // to Google Sheet.
  //
  // Strategy: use localStorage as a cheap mutex. Before draining, check
  // whether another tab set the lock within the last DRAIN_LOCK_TTL ms.
  // If so, skip — that tab owns the drain. Release the lock when done.
  //
  // TTL is set conservatively (30 s) so a crashed tab can't permanently
  // block drains. Normal drains complete well under 30 s.

  var DRAIN_LOCK_KEY = 'telecom_drain_lock';
  var DRAIN_LOCK_TTL = 30 * 1000; // 30 seconds

  function _acquireDrainLock() {
    var now      = Date.now();
    var existing = Number(localStorage.getItem(DRAIN_LOCK_KEY) || 0);
    if (existing && (now - existing) < DRAIN_LOCK_TTL) {
      // Another tab holds the lock and it hasn't expired
      return false;
    }
    localStorage.setItem(DRAIN_LOCK_KEY, String(now));
    return true;
  }

  function _releaseDrainLock() {
    localStorage.removeItem(DRAIN_LOCK_KEY);
  }

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

      // If another tab upgrades the DB to a newer version, this tab's
      // connection receives a versionchange event. Close gracefully so
      // the upgrade can proceed — otherwise the upgrade request blocks
      // indefinitely and every subsequent IDB call throws InvalidStateError.
      _db.onversionchange = function () {
        _db.close();
        _db = null;
        console.warn('[offline.js] IDB version changed — connection closed. ' +
          'Reload this tab to reconnect.');
      };

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

          // If we loaded while already online with queued items, drain now.
          // The 'online' event only fires on the offline→online transition —
          // it does NOT fire on page load when the device is already online.
          // Without this, queued offline edits sit forever after a reload.
          if (_pendingCount > 0 && navigator.onLine) {
            console.log('[offline.js] Init — found', _pendingCount,
              'queued item(s) while online; draining now');
            setTimeout(_processQueue, 500);
          }

          _loadConflictCount(cb); // chain into conflict count load
        };
        req.onerror = function () { _loadConflictCount(cb); };
      } catch (e) {
        _loadConflictCount(cb);
      }
    });

    window.addEventListener('online',  _onOnline);
    window.addEventListener('offline', _onOffline);

    // When another tab finishes draining and releases the lock, the
    // localStorage key is removed → a 'storage' event fires in every
    // other open tab.  If this tab still has pending items, start its
    // own drain now rather than waiting for the next online/offline cycle.
    window.addEventListener('storage', function (e) {
      if (e.key !== DRAIN_LOCK_KEY || e.newValue !== null) return;
      if (_pendingCount > 0 && _isOnline && !_isSyncing) {
        console.log('[offline.js] Drain lock released by another tab — starting drain');
        setTimeout(_processQueue, 300);
      }
    });
  }

  function _loadConflictCount(cb) {
    if (!_db) { if (cb) cb(); return; }
    try {
      var tx  = _db.transaction([STORE_CONFLICTS], 'readonly');
      var req = tx.objectStore(STORE_CONFLICTS).count();
      req.onsuccess = function (e) {
        _conflictCount = e.target.result || 0;
        // Show the current online/offline state immediately on startup.
        // Without this, the status bar is blank until the first save or event.
        _updateIndicator();
        _updateConflictIndicator();
        if (cb) cb();
      };
      req.onerror = function () { if (cb) cb(); };
    } catch (e) {
      if (cb) cb();
    }
  }

  // ── Public: store rows (delta — adds/updates without clearing) ──
  //
  // Used for delta sync: merges incoming changed rows into the existing
  // IDB rows store. Rows not in the incoming set are left untouched.
  // Use replaceAllRows() when you have the full dataset.

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

  // ── Public: clear and replace all rows (full fetch) ──────
  //
  // Used after a full fetch from the server. Clears the entire rows
  // store first so deleted-from-sheet rows don't accumulate as phantoms.
  // Rows that exist in the store but not in the new dataset are removed.
  //
  // callback() — called when the write is complete (optional)

  function replaceAllRows(rows, cb) {
    if (!_db) { if (cb) cb(); return; }
    try {
      // Clear and re-populate in ONE transaction.
      // Two-transaction approach (clear tx1, put tx2 in onsuccess) is wrong:
      // tx1 commits and closes the connection before tx2 opens, causing
      // InvalidStateError: The database connection is closing.
      var tx    = _db.transaction([STORE_ROWS], 'readwrite');
      var store = tx.objectStore(STORE_ROWS);

      store.clear(); // clear request — no onsuccess needed, runs in same tx

      if (rows && rows.length) {
        rows.forEach(function (row) {
          if (row._row_index) store.put(row);
        });
      }

      tx.oncomplete = function () { if (cb) cb(); };
      tx.onerror = function (e) {
        console.error('[offline.js] replaceAllRows failed:', e.target.error);
        if (cb) cb();
      };
    } catch (e) {
      console.error('[offline.js] replaceAllRows error:', e);
      if (cb) cb();
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

  // ── Public: get all queue entries ────────────────────────
  //
  // Returns every entry in the sync_queue store.
  // Used by the grid Refresh and startup paths to re-inject pending
  // new rows (no _row_index) into the display after a server fetch,
  // so they don't vanish from the UI while waiting to sync.

  function getPendingQueue(cb) {
    if (!_db) { cb([]); return; }
    try {
      var tx  = _db.transaction([STORE_QUEUE], 'readonly');
      var req = tx.objectStore(STORE_QUEUE).getAll();
      req.onsuccess = function (e) { cb(e.target.result || []); };
      req.onerror   = function ()  { cb([]); };
    } catch (e) {
      cb([]);
    }
  }

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
    // Use navigator.onLine as ground truth — _isOnline can lag behind
    // when DevTools offline toggle doesn't reliably fire the 'online' event.
    if (navigator.onLine && !_isOnline) {
      _isOnline = true;
    }
    if (!_db || _isSyncing || !_isOnline) return;

    // Prevent multiple open tabs from draining simultaneously.
    // If another tab holds the lock (set within the last 30 s), skip.
    if (!_acquireDrainLock()) {
      console.log('[offline.js] Drain lock held by another tab — skipping this tick');
      return;
    }

    try {
      var tx  = _db.transaction([STORE_QUEUE], 'readonly');
      var req = tx.objectStore(STORE_QUEUE).getAll();

      req.onsuccess = function (e) {
        var entries = e.target.result || [];
        if (!entries.length) {
          _pendingCount = 0;
          _updateIndicator();
          _releaseDrainLock();
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
        _releaseDrainLock();
      };
    } catch (e) {
      console.error('[offline.js] _processQueue failed:', e);
      _releaseDrainLock();
    }
  }

  function _drainNext(entries, idx) {
    if (!_isOnline) {
      _isSyncing = false;
      _updateIndicator();
      _releaseDrainLock();
      return;
    }

    if (idx >= entries.length) {
      _isSyncing    = false;
      _pendingCount = 0;
      _updateIndicator();
      _releaseDrainLock();
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

    console.log('[offline.js] Draining entry', idx + 1, '/', entries.length,
      '— key:', entry._queue_key,
      '| rowIndex:', entry.rowData._row_index || '(new)',
      '| localId:', entry.rowData._local_id || '-');

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

        if (!_isOnline && !navigator.onLine) {
          // Genuinely offline — stop and wait for the 'online' event
          _isSyncing = false;
          _updateIndicator();
          _releaseDrainLock();
          console.warn('[offline.js] Drain paused — device went offline');
          return;
        }

        if (attempts >= MAX_ATTEMPTS) {
          // Server errors (cold-start timeout, Apps Script quota, etc.).
          // Release the lock and schedule a full retry in 30 s rather than
          // giving up permanently — the server may just be warming up.
          _isSyncing = false;
          _releaseDrainLock();
          console.warn('[offline.js] Drain stopped after', attempts,
            'attempts on', entry._queue_key, '—', result.error,
            '— will retry in 30 s');
          setTimeout(function () {
            if (_isOnline || navigator.onLine) _processQueue();
          }, 30 * 1000);
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
    // Update immediately: show "● N pending" or "✓ All synced" rather than
    // leaving the "Offline" label up until the first _processQueue tick.
    _updateIndicator();
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
      var offlineLabel = _pendingCount > 0
        ? 'Offline \u2014 ' + _pendingCount + ' change' + (_pendingCount === 1 ? '' : 's') + ' queued'
        : 'Offline \u2014 changes will be queued';
      el.innerHTML =
        '<span class="sync-dot sync-dot--offline"></span>' +
        '<span class="sync-label">' + offlineLabel + '</span>';
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

  // Called by sheets.js when the presence heartbeat returns a conflictCount.
  // Runs for ALL roles so stale IDB conflict entries on the coordinator's tab
  // are cleared when the manager resolves them server-side.
  function setServerConflictCount(n) {
    if (n === _conflictCount) return;
    _conflictCount = n;
    _updateConflictIndicator();

    // Server says no conflicts remain — purge any stale IDB entries so
    // _loadConflictCount doesn't resurrect the count on next page load.
    if (n === 0 && _db) {
      try {
        var tx = _db.transaction([STORE_CONFLICTS], 'readwrite');
        tx.objectStore(STORE_CONFLICTS).clear();
      } catch (e) { /* non-fatal */ }
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

    var role = (sessionStorage.getItem('app_role') || '').trim().toLowerCase();

    if (role === 'manager') {
      // Manager fetches conflict data from the server (their IDB is separate
      // from the coordinator's tab that detected the conflict).
      _renderConflictPanel([], true); // show loading state immediately
      Sheets.fetchConflicts(function (result) {
        if (!result.success) {
          var body = document.getElementById('cp-body');
          if (body) body.innerHTML =
            '<div class="cp-empty">Error loading conflicts: ' +
            _escHtml(result.error || 'Unknown error') + '</div>';
          return;
        }
        var conflicts = (result.conflicts || []).map(function (c) {
          // Normalise shape to match IDB conflict objects the panel expects
          return {
            id:               c.conflictSheetRow, // used as key for resolve btn
            conflictSheetRow: c.conflictSheetRow,
            liveRowIndex:     c.liveRowIndex,
            offlineData:      c.offlineData  || {},
            serverData:       c.serverData   || {},
            queuedAt:         c.offlineWhen,
            detectedAt:       c.detectedAt,
            _fromServer:      true
          };
        });
        _renderConflictPanel(conflicts, false);
      });
    } else {
      getConflicts(function (conflicts) {
        _renderConflictPanel(conflicts, false);
      });
    }
  }

  function _renderConflictPanel(conflicts, loading) {
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

    if (loading) {
      body.innerHTML = '<div class="cp-empty">Loading conflicts\u2026</div>';
    } else if (!conflicts.length) {
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
    // Server-fetched conflicts carry routing metadata for the resolve path
    if (conflict._fromServer) {
      card.setAttribute('data-from-server', 'true');
      card.setAttribute('data-conflict-sheet-row', String(conflict.conflictSheetRow || ''));
      card.setAttribute('data-live-row-index',     String(conflict.liveRowIndex     || ''));
    }

    var offline  = conflict.offlineData  || {};
    var server   = conflict.serverData   || {};
    var queuedAt = conflict.queuedAt     ? new Date(conflict.queuedAt) : null;
    var detected = conflict.detectedAt   ? new Date(conflict.detectedAt) : null;
    var rowId    = offline.id || server.id || offline._row_index || '(unknown)';
    var who      = conflict.offlineWho   || offline.coordinator_name || '';

    // ── Card header ──
    var ch = document.createElement('div');
    ch.className = 'cp-card-header';
    ch.innerHTML =
      '<span class="cp-card-title">⚠ Conflict — Row ID: ' + _escHtml(String(rowId)) + '</span>' +
      (who      ? '<span class="cp-card-meta">Edited by: <strong>' + _escHtml(who) + '</strong></span>' : '') +
      (queuedAt ? '<span class="cp-card-meta">Went offline: ' + _formatDate(queuedAt) + '</span>' : '') +
      (detected ? '<span class="cp-card-meta">Conflict detected: ' + _formatDate(detected) + '</span>' : '');
    card.appendChild(ch);

    // ── Diff table — only rows that differ are shown ──
    var diffFields = _buildDiff(offline, server);

    // Legend
    var legend = document.createElement('div');
    legend.className = 'cp-legend';
    legend.innerHTML =
      '<span class="cp-legend-item"><span class="cp-legend-swatch" style="background:#dbeafe"></span>Live version (in Google Sheets now)</span>' +
      '<span class="cp-legend-item"><span class="cp-legend-swatch" style="background:#dcfce7"></span>Your offline edit</span>' +
      '<span class="cp-legend-item"><span class="cp-legend-swatch" style="background:#fffbeb;border:1px solid #fde68a"></span>Fields that differ</span>';
    card.appendChild(legend);

    var tbl = document.createElement('table');
    tbl.className = 'cp-diff-table';
    tbl.innerHTML =
      '<thead><tr>' +
      '<th class="cp-th--field">Field</th>' +
      '<th class="cp-th--live">Live Version (online)</th>' +
      '<th class="cp-th--offline">Your Offline Edit</th>' +
      '</tr></thead>';

    var tbody = document.createElement('tbody');

    if (!diffFields.length) {
      var trNone = document.createElement('tr');
      trNone.innerHTML =
        '<td colspan="3" class="cp-no-diff">No field differences detected — timestamps differ but values are the same.</td>';
      tbody.appendChild(trNone);
    } else {
      diffFields.forEach(function (d) {
        var tr = document.createElement('tr');
        tr.className = 'cp-row--changed';
        tr.innerHTML =
          '<td class="cp-field-name">' + _escHtml(d.key) + '</td>' +
          '<td class="cp-val cp-val--live">'    + _escHtml(String(d.live    || '—')) + '</td>' +
          '<td class="cp-val cp-val--offline">' + _escHtml(String(d.offline || '—')) + '</td>';
        tbody.appendChild(tr);
      });
    }

    tbl.appendChild(tbody);
    card.appendChild(tbl);

    // ── Action buttons ──
    var actions = document.createElement('div');
    actions.className = 'cp-actions';

    var keepLiveBtn = document.createElement('button');
    keepLiveBtn.className = 'cp-btn cp-btn--secondary';
    keepLiveBtn.textContent = '\uD83D\uDCBB Keep Live Version';
    keepLiveBtn.title = 'Discard the offline edit. Keep what is currently in Google Sheets.';
    keepLiveBtn.onclick = function () {
      _resolveFromPanel(conflict.id, 'online', null, card);
    };

    var keepOfflineBtn = document.createElement('button');
    keepOfflineBtn.className = 'cp-btn cp-btn--primary';
    keepOfflineBtn.textContent = '\u270F Keep Offline Edit';
    keepOfflineBtn.title = 'Overwrite the live row with the offline edit.';
    keepOfflineBtn.onclick = function () {
      _resolveFromPanel(conflict.id, 'offline', offline, card);
    };

    var mergeBtn = document.createElement('button');
    mergeBtn.className = 'cp-btn cp-btn--ghost';
    mergeBtn.textContent = 'Merge Manually\u2026';
    mergeBtn.title = 'Choose field-by-field which value to keep.';
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

  // Build the manual merge form.
  // Shows ONLY the fields that differ — 4 columns: Field | Live | Offline | Your Choice.
  // Non-conflicting fields are automatically carried over from the offline version.
  function _buildMergeForm(conflict) {
    var offline    = conflict.offlineData || {};
    var server     = conflict.serverData  || {};
    var diffFields = _buildDiff(offline, server);

    var form = document.createElement('div');
    form.className = 'cp-merge-form';

    var heading = document.createElement('div');
    heading.className = 'cp-merge-heading';
    heading.textContent = 'Choose the value to keep for each conflicting field, then click Save Merge.';
    form.appendChild(heading);

    var inputMap = {}; // key → input element

    if (!diffFields.length) {
      var noConflict = document.createElement('p');
      noConflict.style.cssText = 'color:#555;font-size:12px;margin:0 0 12px';
      noConflict.textContent = 'No field differences — either version is safe to keep.';
      form.appendChild(noConflict);
    } else {
      // 4-column grid header
      var grid = document.createElement('div');
      grid.className = 'cp-merge-cols';

      ['Field', 'Live Version', 'Your Offline Edit', 'Your Choice'].forEach(function (h, i) {
        var hdr = document.createElement('div');
        hdr.className = 'cp-merge-col-hdr ' +
          ['hdr-field', 'hdr-live', 'hdr-offline', 'hdr-merged'][i];
        hdr.textContent = h;
        grid.appendChild(hdr);
      });

      diffFields.forEach(function (d) {
        // Field name cell
        var fCell = document.createElement('div');
        fCell.className = 'cp-merge-cell cell-field';
        fCell.textContent = d.key;
        grid.appendChild(fCell);

        // Live value cell (click to copy)
        var lCell = document.createElement('div');
        lCell.className = 'cp-merge-cell cell-live';
        lCell.textContent = d.live || '—';
        lCell.title = 'Click to use this value';
        lCell.style.cursor = 'pointer';
        grid.appendChild(lCell);

        // Offline value cell (click to copy)
        var oCell = document.createElement('div');
        oCell.className = 'cp-merge-cell cell-offline';
        oCell.textContent = d.offline || '—';
        oCell.title = 'Click to use this value';
        oCell.style.cursor = 'pointer';
        grid.appendChild(oCell);

        // Editable choice cell — pre-filled with offline value
        var mCell = document.createElement('div');
        mCell.className = 'cp-merge-cell';
        mCell.style.padding = '3px 6px';

        var input = document.createElement('input');
        input.type      = 'text';
        input.className = 'cp-merge-input';
        input.value     = d.offline || '';
        input.setAttribute('data-key', d.key);
        inputMap[d.key] = input;

        // Click live / offline cell to auto-fill the input
        lCell.onclick = function () { input.value = d.live    || ''; input.focus(); };
        oCell.onclick = function () { input.value = d.offline || ''; input.focus(); };

        mCell.appendChild(input);
        grid.appendChild(mCell);
      });

      form.appendChild(grid);

      var hint = document.createElement('p');
      hint.style.cssText = 'color:#666;font-size:11px;margin:4px 0 12px';
      hint.textContent = 'Tip: click any Live or Offline value to copy it into the Your Choice box.';
      form.appendChild(hint);
    }

    var saveBtn = document.createElement('button');
    saveBtn.className   = 'cp-btn cp-btn--primary';
    saveBtn.textContent = 'Save Merge';
    saveBtn.onclick = function () {
      // Start from the offline version, then override with the manager's choices
      var mergedData = _shallowCopy(offline);
      Object.keys(inputMap).forEach(function (k) {
        mergedData[k] = inputMap[k].value;
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
    var actions   = card.querySelector('.cp-actions');
    var mergeForm = card.querySelector('.cp-merge-form');
    if (actions)   actions.innerHTML = '<span class="cp-resolving">Resolving\u2026</span>';
    if (mergeForm) mergeForm.setAttribute('hidden', '');

    var fromServer       = card.getAttribute('data-from-server') === 'true';
    var conflictSheetRow = Number(card.getAttribute('data-conflict-sheet-row')) || null;
    var liveRowIndex     = Number(card.getAttribute('data-live-row-index'))     || null;

    function _onResolved(result) {
      if (result.success) {
        _conflictCount = Math.max(0, _conflictCount - 1);
        _updateConflictIndicator();
        card.style.opacity    = '0.4';
        card.style.transition = 'opacity 0.3s';
        setTimeout(function () {
          if (card.parentNode) card.parentNode.removeChild(card);
          var body = document.getElementById('cp-body');
          if (body && !body.querySelector('.cp-card')) {
            body.innerHTML =
              '<div class="cp-empty">All conflicts resolved. No more pending.</div>';
          }
          if (_conflictCount === 0) setTimeout(_closeConflictPanel, 600);
        }, 300);
      } else {
        if (actions) {
          actions.innerHTML = '';
          var errEl = document.createElement('span');
          errEl.className  = 'cp-resolve-error';
          errEl.textContent = 'Error: ' + (result.error || 'Unknown error');
          actions.appendChild(errEl);
        }
      }
    }

    if (fromServer) {
      // Manager tab fetched conflicts from the server — resolve directly
      // via Sheets without touching local IDB (which is empty in this tab).
      Sheets.resolveConflict(
        conflictSheetRow,
        liveRowIndex,
        keepVersion,
        keepVersion === 'online' ? null : mergedData,
        _onResolved
      );
    } else {
      // Coordinator tab: conflict is in local IDB — use the full IDB path
      resolveConflict(conflictId, keepVersion, mergedData, _onResolved);
    }
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
      // Uses explicit light-theme colors throughout so the panel is
      // always readable regardless of the app's dark CSS variables.

      '#conflict-panel-overlay {',
        'position: fixed;',
        'inset: 0;',
        'background: rgba(0,0,0,0.6);',
        'z-index: 10000;',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        'padding: 24px;',
      '}',

      '#conflict-panel {',
        'background: #ffffff;',
        'border: 1px solid #d0d7de;',
        'border-radius: 6px;',
        'width: 100%;',
        'max-width: 900px;',
        'max-height: 85vh;',
        'display: flex;',
        'flex-direction: column;',
        'overflow: hidden;',
        'box-shadow: 0 20px 60px rgba(0,0,0,0.4);',
      '}',

      '.cp-header {',
        'display: flex;',
        'align-items: center;',
        'justify-content: space-between;',
        'padding: 14px 20px;',
        'background: #fff8ee;',
        'border-bottom: 2px solid #e8a030;',
        'flex-shrink: 0;',
      '}',

      '.cp-title {',
        'font-family: var(--font-display, sans-serif);',
        'font-weight: 700;',
        'font-size: 13px;',
        'letter-spacing: 0.06em;',
        'text-transform: uppercase;',
        'color: #b87a10;',
      '}',

      '.cp-close {',
        'background: transparent;',
        'border: none;',
        'color: #555;',
        'font-size: 22px;',
        'line-height: 1;',
        'cursor: pointer;',
        'padding: 0 4px;',
        'transition: color 0.15s;',
      '}',

      '.cp-close:hover { color: #111; }',

      '.cp-body {',
        'overflow-y: auto;',
        'padding: 16px 20px;',
        'display: flex;',
        'flex-direction: column;',
        'gap: 20px;',
        'flex: 1;',
        'background: #f6f8fa;',
      '}',

      '.cp-empty {',
        'font-size: 13px;',
        'color: #555;',
        'text-align: center;',
        'padding: 36px 0;',
      '}',

      // ── Conflict card ──────────────────────────────────────

      '.cp-card {',
        'background: #ffffff;',
        'border: 1px solid #d0d7de;',
        'border-radius: 5px;',
        'padding: 16px;',
        'box-shadow: 0 1px 4px rgba(0,0,0,0.06);',
      '}',

      '.cp-card-header {',
        'display: flex;',
        'align-items: baseline;',
        'gap: 16px;',
        'margin-bottom: 12px;',
        'flex-wrap: wrap;',
        'padding-bottom: 10px;',
        'border-bottom: 1px solid #e8ecf0;',
      '}',

      '.cp-card-title {',
        'font-weight: 700;',
        'font-size: 13px;',
        'color: #111;',
      '}',

      '.cp-card-meta {',
        'font-size: 11px;',
        'color: #666;',
      '}',

      // ── Diff table ────────────────────────────────────────

      '.cp-diff-table {',
        'width: 100%;',
        'border-collapse: collapse;',
        'font-size: 12px;',
        'margin-bottom: 14px;',
        'border: 1px solid #d0d7de;',
        'border-radius: 4px;',
        'overflow: hidden;',
      '}',

      '.cp-diff-table th {',
        'font-size: 10px;',
        'font-weight: 700;',
        'letter-spacing: 0.08em;',
        'text-transform: uppercase;',
        'text-align: left;',
        'padding: 7px 10px;',
        'border-bottom: 2px solid #d0d7de;',
        'color: #333;',
      '}',

      // Column header colour coding
      '.cp-th--live    { background: #dbeafe; color: #1e40af; }',
      '.cp-th--offline { background: #dcfce7; color: #166534; }',
      '.cp-th--field   { background: #f3f4f6; color: #374151; }',

      '.cp-diff-table td {',
        'padding: 6px 10px;',
        'border-bottom: 1px solid #e8ecf0;',
        'vertical-align: top;',
        'color: #111;',
        'font-size: 12px;',
      '}',

      '.cp-diff-table tr:last-child td { border-bottom: none; }',

      // Highlight the entire row where values differ
      '.cp-diff-table tr.cp-row--changed { background: #fffbeb; }',
      '.cp-diff-table tr.cp-row--changed td { border-bottom-color: #fde68a; }',

      '.cp-field-name {',
        'font-family: var(--font-mono, monospace);',
        'font-size: 11px;',
        'font-weight: 600;',
        'color: #374151;',
        'white-space: nowrap;',
      '}',

      '.cp-val--live {',
        'background: #eff6ff;',
        'color: #1e3a5f;',
      '}',

      '.cp-val--offline {',
        'background: #f0fdf4;',
        'color: #14532d;',
        'font-weight: 600;',
      '}',

      '.cp-no-diff {',
        'color: #666;',
        'font-style: italic;',
        'text-align: center;',
        'padding: 12px;',
      '}',

      // Legend below the table
      '.cp-legend {',
        'display: flex;',
        'gap: 16px;',
        'margin-bottom: 12px;',
        'font-size: 11px;',
      '}',

      '.cp-legend-item {',
        'display: flex;',
        'align-items: center;',
        'gap: 5px;',
        'color: #444;',
      '}',

      '.cp-legend-swatch {',
        'width: 12px;',
        'height: 12px;',
        'border-radius: 2px;',
        'flex-shrink: 0;',
      '}',

      // ── Action buttons ────────────────────────────────────

      '.cp-actions {',
        'display: flex;',
        'gap: 8px;',
        'align-items: center;',
        'flex-wrap: wrap;',
        'padding-top: 4px;',
      '}',

      '.cp-btn {',
        'height: 30px;',
        'padding: 0 16px;',
        'font-weight: 600;',
        'font-size: 11px;',
        'letter-spacing: 0.04em;',
        'cursor: pointer;',
        'border: 1px solid;',
        'border-radius: 4px;',
        'transition: background 0.15s, opacity 0.15s;',
        'white-space: nowrap;',
      '}',

      // Keep Live — neutral blue
      '.cp-btn--secondary {',
        'background: #eff6ff;',
        'border-color: #93c5fd;',
        'color: #1e40af;',
      '}',
      '.cp-btn--secondary:hover { background: #dbeafe; }',

      // Keep Offline — green
      '.cp-btn--primary {',
        'background: #16a34a;',
        'border-color: #15803d;',
        'color: #fff;',
      '}',
      '.cp-btn--primary:hover { background: #15803d; }',

      // Merge Manually — ghost
      '.cp-btn--ghost {',
        'background: transparent;',
        'border-color: #d0d7de;',
        'color: #555;',
        'font-weight: 400;',
      '}',
      '.cp-btn--ghost:hover { background: #f3f4f6; color: #111; }',

      '.cp-resolving {',
        'font-size: 11px;',
        'color: #666;',
        'font-style: italic;',
      '}',

      '.cp-resolve-error {',
        'font-size: 11px;',
        'color: #dc2626;',
        'font-weight: 600;',
      '}',

      // ── Merge form ────────────────────────────────────────

      '.cp-merge-form {',
        'margin-top: 14px;',
        'padding: 14px;',
        'background: #f9fafb;',
        'border: 1px solid #e5e7eb;',
        'border-radius: 4px;',
      '}',

      '.cp-merge-heading {',
        'font-size: 11px;',
        'font-weight: 700;',
        'letter-spacing: 0.06em;',
        'text-transform: uppercase;',
        'color: #374151;',
        'margin-bottom: 12px;',
      '}',

      '.cp-merge-cols {',
        'display: grid;',
        'grid-template-columns: 160px 1fr 1fr 1fr;',
        'gap: 0;',
        'border: 1px solid #d0d7de;',
        'border-radius: 4px;',
        'overflow: hidden;',
        'margin-bottom: 12px;',
        'font-size: 12px;',
      '}',

      '.cp-merge-col-hdr {',
        'font-size: 10px;',
        'font-weight: 700;',
        'letter-spacing: 0.08em;',
        'text-transform: uppercase;',
        'padding: 6px 8px;',
        'border-bottom: 2px solid #d0d7de;',
        'color: #333;',
      '}',

      '.cp-merge-col-hdr.hdr-field   { background: #f3f4f6; color: #374151; }',
      '.cp-merge-col-hdr.hdr-live    { background: #dbeafe; color: #1e40af; }',
      '.cp-merge-col-hdr.hdr-offline { background: #dcfce7; color: #166534; }',
      '.cp-merge-col-hdr.hdr-merged  { background: #fef9ee; color: #92400e; }',

      '.cp-merge-cell {',
        'padding: 5px 8px;',
        'border-bottom: 1px solid #e8ecf0;',
        'border-right: 1px solid #e8ecf0;',
        'color: #111;',
        'vertical-align: middle;',
      '}',

      '.cp-merge-cell:last-child { border-right: none; }',

      '.cp-merge-cell.cell-field {',
        'background: #f9fafb;',
        'font-family: var(--font-mono, monospace);',
        'font-size: 11px;',
        'font-weight: 600;',
        'color: #374151;',
      '}',

      '.cp-merge-cell.cell-live    { background: #eff6ff; color: #1e3a5f; }',
      '.cp-merge-cell.cell-offline { background: #f0fdf4; color: #14532d; font-weight: 600; }',

      '.cp-merge-input {',
        'width: 100%;',
        'height: 24px;',
        'padding: 0 6px;',
        'background: #fff;',
        'border: 1px solid #d0d7de;',
        'border-radius: 3px;',
        'color: #111;',
        'font-size: 12px;',
        'box-sizing: border-box;',
      '}',

      '.cp-merge-input:focus {',
        'outline: none;',
        'border-color: #c9973a;',
        'box-shadow: 0 0 0 2px rgba(201,151,58,0.2);',
      '}',

    ].join('\n');
    document.head.appendChild(s);
  }());

  // ── Expose ────────────────────────────────────────────────

  return {
    init:                 init,
    storeRows:            storeRows,
    replaceAllRows:       replaceAllRows,
    getAllRows:            getAllRows,
    queueSave:            queueSave,
    getLastSyncTime:      getLastSyncTime,
    setLastSyncTime:      setLastSyncTime,
    getPendingQueue:      getPendingQueue,
    getPendingRowIndexes: getPendingRowIndexes,
    getConflicts:          getConflicts,
    resolveConflict:       resolveConflict,
    setServerConflictCount: setServerConflictCount
  };

}());
