// ============================================================
// sync.js — DuckDB-backed sync queue (replaces offline.js)
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Accept row saves from grid.js (queueSave) and queue them in DuckDB
//   - Drain the pending_queue to Apps Script in batches of 50
//   - Online/offline detection and status indicator
//   - Last-sync-time tracking (localStorage + DuckDB metadata)
//   - Stub for conflict count (implemented in Session 7)
//
// Public API:
//   Sync.init()                       — load pending + conflict counts from DuckDB
//   Sync.queueSave(rowData, cb)       — called by grid.js _saveRow()
//   Sync.getLastSyncTime()            — returns epoch-ms (synchronous)
//   Sync.setLastSyncTime(ts)          — persist to localStorage + DuckDB
//   Sync.setServerConflictCount(n)    — reconcile conflict badge from heartbeat
//   Sync.flush()                      — drain queue (called on reconnect)
//
// Replaces:
//   Offline.init / queueSave / getLastSyncTime / setLastSyncTime
//   Offline.getPendingQueue / getPendingRowIndexes / setServerConflictCount
// ============================================================

var Sync = (function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────

  var BATCH_SIZE    = 50;   // rows per flush batch (BUILD_GUIDE requirement)
  var MAX_RETRIES   = 3;    // stop retrying after this many failures
  var RETRY_DELAY   = 2000; // ms between retries on transient errors
  var SYNCED_CLR_MS = 3000; // "All synced" indicator auto-hides after this
  var LS_SYNC_KEY   = 'sync_last_modified'; // same key as old offline.js

  // ── Internal state ────────────────────────────────────────

  var _online        = navigator.onLine;
  var _flushing      = false;
  var _pendingCount  = 0;
  var _conflictCount = 0;    // unresolved conflicts — drives the manager badge
  var _lastSyncTime  = 0;    // epoch-ms, memory cache for synchronous reads
  var _clearTimer    = null;
  var _flushTimer    = null;

  // ══════════════════════════════════════════════════════════
  // PUBLIC: init
  // ══════════════════════════════════════════════════════════

  /**
   * Load the pending count from DuckDB and start a drain if
   * we came back online while edits were queued.
   * Called from app.js after Db.init() succeeds.
   */
  async function init() {
    try {
      var rows = await Db.query('SELECT COUNT(*) AS n FROM pending_queue');
      _pendingCount = Number((rows[0] && rows[0].n) || 0);
      _updateIndicator();
      if (_pendingCount > 0 && _online) _triggerFlush();

      // Restore conflict badge from DuckDB (survives page reload)
      _conflictCount = await Db.countUnresolvedConflicts();
      _updateConflictBadge(_conflictCount);

    } catch (e) {
      // DuckDB not ready yet — indicator stays blank, flush triggered later
    }
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: queueSave
  // ══════════════════════════════════════════════════════════

  /**
   * Called by grid.js _saveRow() instead of the old Offline.queueSave().
   *
   * 1. Derive a stable row_id for the queue (existing row → 'row_N',
   *    new row → the _local_id assigned by grid.js).
   * 2. Upsert the row in DuckDB with _pending_sync = true (optimistic).
   * 3. Add to pending_queue (last-write-wins ON CONFLICT).
   * 4. Call callback immediately — the save is visible in the grid now.
   * 5. Trigger flush if online.
   */
  async function queueSave(rowData, callback) {
    try {
      await Db.init();

      // Row identity: prefer server-assigned index, fall back to local id
      var queueId = rowData._row_id
        || (rowData._row_index ? 'row_' + String(rowData._row_index) : null)
        || rowData._local_id
        || ('new_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));

      // Upsert in rows table with pending flag
      var rowToStore = Object.assign({}, rowData);
      rowToStore._row_id      = rowToStore._row_id || queueId;
      rowToStore._pending_sync = true;
      await Db.upsertRow(rowToStore);

      // Add to pending_queue (ON CONFLICT resets retry to 0 — last edit wins)
      await Db.queuePending(queueId, JSON.stringify(rowData), 'save');

      _pendingCount++;
      _updateIndicator();

      // Callback immediately (optimistic local update already visible)
      if (callback) callback({ success: true, rowIndex: rowData._row_index || null });

      if (_online) _triggerFlush();

    } catch (e) {
      console.error('[Sync] queueSave failed:', e);
      if (callback) callback({ success: false, error: e.message || String(e) });
    }
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: flush (drain pending_queue → Apps Script)
  // ══════════════════════════════════════════════════════════

  /**
   * Process the pending_queue in batches of BATCH_SIZE.
   * For each entry: call Sheets.writeRow (or softDeleteRow for deletes).
   * On success: remove from queue, update DuckDB row.
   * On network error: stop and wait for reconnect.
   * On app error: increment retry_count; give up after MAX_RETRIES.
   */
  async function flush() {
    if (_flushing || !_online) return;
    _flushing = true;
    _updateIndicator();

    try {
      var hasMore = true;
      while (hasMore && _online) {

        var batch = await Db.query(
          'SELECT * FROM pending_queue WHERE retry_count < ? ORDER BY queued_at ASC LIMIT ?',
          [MAX_RETRIES, BATCH_SIZE]
        );

        if (!batch.length) { hasMore = false; break; }

        for (var i = 0; i < batch.length; i++) {
          if (!_online) { hasMore = false; break; }

          var entry   = batch[i];
          var rowData;
          try { rowData = JSON.parse(entry.payload); } catch (_) { rowData = {}; }

          var result = await _sendOne(entry.action, rowData);

          if (result.success) {
            await _onSuccess(entry, rowData, result);
          } else if (result.conflict) {
            // Concurrent edit collision: server detected our write would
            // overwrite someone else's newer change.  Store locally for
            // manager resolution; remove from queue so we don't retry.
            await _onConflict(entry, rowData, result);
          } else if (_isNetworkError(result.error) || !navigator.onLine) {
            // True offline — stop and wait for 'online' event
            _online = false;
            hasMore = false;
            break;
          } else {
            // Transient server error — increment retry count
            await Db.incrementRetryCount(entry.row_id);
            console.warn('[Sync] flush: entry failed (retry ' +
              (entry.retry_count + 1) + '/' + MAX_RETRIES + '):', result.error);
          }
        }

        // Fewer items than batch size → we've processed everything
        if (batch.length < BATCH_SIZE) hasMore = false;
      }

      // Refresh pending count from DB (counts may differ after partial flush)
      var remaining = await Db.query('SELECT COUNT(*) AS n FROM pending_queue');
      _pendingCount = Number((remaining[0] && remaining[0].n) || 0);

      if (_pendingCount === 0 && typeof Backup !== 'undefined') Backup.onSave();

    } catch (e) {
      console.error('[Sync] flush error:', e);
    } finally {
      _flushing = false;
      _updateIndicator();
    }
  }

  // Send one queue entry to Apps Script (returns a Promise<{success, rowIndex, error}>)
  function _sendOne(action, rowData) {
    return new Promise(function (resolve) {
      if (action === 'delete') {
        var rowIndex = rowData._row_index
          || (rowData._row_id && rowData._row_id.match(/^row_(\d+)$/) && Number(rowData._row_id.match(/^row_(\d+)$/)[1]));
        if (!rowIndex) { resolve({ success: true }); return; } // new unsaved row — nothing to delete on server
        Sheets.softDeleteRow(rowIndex, resolve);
      } else {
        Sheets.writeRow(rowData, resolve);
      }
    });
  }

  // Handle a successful flush of one queue entry
  async function _onSuccess(entry, rowData, result) {
    var wasNewRow = !!(rowData._local_id && !rowData._row_index);

    if (result.rowIndex && wasNewRow) {
      // Server assigned a row index to a new row:
      // 1. Remove old DuckDB entry (has local _row_id)
      // 2. Re-insert with server-assigned _row_id
      // 3. Patch the grid row via Grid.updateRowIndex
      var oldRowId = entry.row_id;
      var newRowId = 'row_' + String(result.rowIndex);

      await Db.query("DELETE FROM rows WHERE _row_id = '" +
        oldRowId.replace(/'/g, "''") + "'");

      var updatedRow = Object.assign({}, rowData, {
        _row_id:      newRowId,
        _row_index:   result.rowIndex,
        _pending_sync: false,
      });
      delete updatedRow._local_id;
      await Db.upsertRow(updatedRow);

      if (rowData._local_id && typeof Grid !== 'undefined') {
        Grid.updateRowIndex(rowData._local_id, result.rowIndex);
      }

    } else if (result.rowIndex) {
      // Existing row — mark synced
      await Db.markSynced('row_' + String(result.rowIndex));
    } else {
      await Db.markSynced(entry.row_id);
    }

    await Db.dequeuePending(entry.row_id);
    _pendingCount = Math.max(0, _pendingCount - 1);
    _updateIndicator();
  }

  // Handle a conflict response from Apps Script:
  //   - Store the conflict record in DuckDB
  //   - Remove from pending_queue (no point retrying — needs human resolution)
  //   - Update the manager badge
  async function _onConflict(entry, rowData, result) {
    var serverRow = result.serverRow || result.server_row || null;

    try {
      await Db.storeConflict(
        entry.row_id,
        JSON.stringify(rowData),
        JSON.stringify(serverRow || {}),
        result.conflictSheetRow != null ? result.conflictSheetRow : null,
        result.rowIndex         != null ? result.rowIndex         : null
      );
    } catch (e) {
      console.warn('[Sync] could not store conflict in DuckDB:', e.message || e);
    }

    // Remove from queue — human resolution required, not retry logic
    await Db.dequeuePending(entry.row_id);
    _pendingCount = Math.max(0, _pendingCount - 1);

    _conflictCount++;
    _updateConflictBadge(_conflictCount);
    _updateIndicator();

    console.warn('[Sync] conflict stored — row_id:', entry.row_id,
      '| conflict_sheet_row:', result.conflictSheetRow);
  }

  // ══════════════════════════════════════════════════════════
  // SYNC TIME
  // ══════════════════════════════════════════════════════════

  /**
   * Return the last successful sync timestamp (epoch-ms).
   * Synchronous — reads from memory cache populated on startup.
   * Falls back to localStorage (same key as old offline.js) so the
   * background sync timer works immediately without waiting for DuckDB.
   */
  function getLastSyncTime() {
    if (_lastSyncTime) return _lastSyncTime;
    var ls = Number(localStorage.getItem(LS_SYNC_KEY) || 0);
    if (ls) _lastSyncTime = ls;
    return _lastSyncTime;
  }

  /**
   * Persist the sync timestamp to localStorage (synchronous read on next start)
   * and to DuckDB metadata (authoritative).
   */
  function setLastSyncTime(ts) {
    _lastSyncTime = Number(ts) || 0;
    if (_lastSyncTime) {
      localStorage.setItem(LS_SYNC_KEY, String(_lastSyncTime));
    }
    // Persist to DuckDB asynchronously (best-effort, not blocking)
    Db.init().then(function () {
      return Db.setMeta('last_sync_time', String(_lastSyncTime));
    }).catch(function () {});
  }

  // ══════════════════════════════════════════════════════════
  // CONFLICT COUNT + BADGE
  // ══════════════════════════════════════════════════════════

  /**
   * Called by sheets.js _heartbeatTick() with the server's authoritative
   * unresolved conflict count.  Reconciles the local count so the badge
   * is accurate even after a manager resolves a conflict on another device.
   *
   * Also called with n=0 by delete.js after the last conflict is resolved
   * so the badge disappears immediately without waiting for the next heartbeat.
   */
  function setServerConflictCount(n) {
    var count = Number(n) || 0;
    if (count === _conflictCount) return; // no change — skip DOM update
    _conflictCount = count;
    _updateConflictBadge(_conflictCount);
  }

  /**
   * Show or hide the conflict count badge on the #tb-manager button.
   * The badge is a <span> appended as the button's last child.
   * It is created on demand and reused on subsequent calls.
   */
  function _updateConflictBadge(n) {
    var btn = document.getElementById('tb-manager');
    if (!btn) return;

    var badge = btn.querySelector('.conflict-count-badge');

    if (n <= 0) {
      if (badge) badge.remove();
      btn.classList.remove('has-conflicts');
      return;
    }

    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'conflict-count-badge';
      btn.appendChild(badge);
      _injectBadgeStyles();
    }

    badge.textContent = String(n);
    btn.classList.add('has-conflicts');
  }

  function _injectBadgeStyles() {
    if (document.getElementById('conflict-badge-styles')) return;
    var s = document.createElement('style');
    s.id = 'conflict-badge-styles';
    s.textContent = [
      '.conflict-count-badge {',
        'display: inline-flex;',
        'align-items: center;',
        'justify-content: center;',
        'min-width: 16px;',
        'height: 16px;',
        'padding: 0 4px;',
        'margin-left: 6px;',
        'background: var(--color-conflict, #c8800a);',
        'color: #fff;',
        'font-family: var(--font-mono);',
        'font-size: 9px;',
        'font-weight: 500;',
        'letter-spacing: 0;',
        'border-radius: 2px;',
        'vertical-align: middle;',
        'line-height: 1;',
        'flex-shrink: 0;',
      '}',
      '#tb-manager.has-conflicts {',
        'border-color: rgba(200, 128, 10, 0.55);',
        'color: var(--color-conflict, #c8800a);',
      '}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ══════════════════════════════════════════════════════════
  // ONLINE / OFFLINE
  // ══════════════════════════════════════════════════════════

  window.addEventListener('online', function () {
    _online = true;
    console.log('[Sync] network restored — flushing queue');
    _updateIndicator();
    _triggerFlush();
  });

  window.addEventListener('offline', function () {
    _online = false;
    console.log('[Sync] network lost — saves will queue');
    _updateIndicator();
  });

  // Debounce flush slightly so rapid back-to-back edits batch together
  function _triggerFlush() {
    clearTimeout(_flushTimer);
    _flushTimer = setTimeout(flush, 200);
  }

  function _isNetworkError(msg) {
    if (!msg) return false;
    return /unable to reach|network|connection|failed to fetch|fetch/i.test(msg);
  }

  // ══════════════════════════════════════════════════════════
  // SYNC INDICATOR
  // ══════════════════════════════════════════════════════════

  function _updateIndicator() {
    var el = document.getElementById('sync-indicator');
    if (!el) return;
    clearTimeout(_clearTimer);

    if (!_online) {
      var label = _pendingCount > 0
        ? 'Offline — ' + _pendingCount + ' change' + (_pendingCount === 1 ? '' : 's') + ' queued'
        : 'Offline — changes will be queued';
      el.innerHTML =
        '<span class="sync-dot sync-dot--offline"></span>' +
        '<span class="sync-label">' + label + '</span>';
      return;
    }

    if (_pendingCount > 0 || _flushing) {
      var n = _pendingCount;
      el.innerHTML =
        '<span class="sync-dot sync-dot--pending"></span>' +
        '<span class="sync-label">● ' + n +
        ' change' + (n === 1 ? '' : 's') + ' pending sync</span>';
      return;
    }

    el.innerHTML =
      '<span class="sync-check">✓</span>' +
      '<span class="sync-label">All synced</span>';
    _clearTimer = setTimeout(function () { el.innerHTML = ''; }, SYNCED_CLR_MS);
  }

  // ══════════════════════════════════════════════════════════
  // STYLES
  // ══════════════════════════════════════════════════════════

  (function _injectStyles() {
    if (document.getElementById('sync-styles')) return;
    var s = document.createElement('style');
    s.id = 'sync-styles';
    s.textContent = [
      '#sync-indicator { display:flex; align-items:center; gap:6px; }',
      '.sync-label { font-family:var(--font-mono); font-size:10px; letter-spacing:0.10em; text-transform:uppercase; color:var(--text-secondary); }',
      '.sync-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }',
      '.sync-dot--offline { background:var(--text-secondary); }',
      '.sync-dot--pending { background:var(--accent); animation:sync-pulse 1.2s ease-in-out infinite; }',
      '@keyframes sync-pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.3;transform:scale(0.55)} }',
      '.sync-check { font-size:11px; color:var(--color-success); line-height:1; }',
    ].join('\n');
    document.head.appendChild(s);
  }());

  // ══════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════

  return {
    init:                   init,
    queueSave:              queueSave,
    flush:                  flush,
    getLastSyncTime:        getLastSyncTime,
    setLastSyncTime:        setLastSyncTime,
    setServerConflictCount: setServerConflictCount,
  };

}());
