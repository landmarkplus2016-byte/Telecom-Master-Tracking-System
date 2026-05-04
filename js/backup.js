// ============================================================
// backup.js — File System Access API backup system
// Telecom Coordinator Tracking App — Stage 5
// ============================================================
//
// Responsibilities (this file only):
//   - First-launch folder picker — chosen once, persisted in IDB
//   - Per-save backup: silently overwrite backup_latest.json
//   - Scheduled backup: 8:00 AM + 3:00 PM daily, auto-named
//     backup_YYYY-MM-DD_HHhmm.json; missed slots run on next open
//   - Manual: "Backup Now" toolbar button (all roles)
//   - Rolling: keep 14 named backups, delete oldest on 15th write
//   - Role-scoped contents:
//       Coordinator — own rows only (IDB is already filtered)
//       Invoicing   — all rows, all 43 columns
//       Manager     — all rows, all 43 columns + deleted records
//
// Public API:
//   Backup.init(role, name)  — call from app.js after Grid.init()
//   Backup.onSave()          — call from offline.js after every
//                              successful row write (per-save backup)
//   Backup.now(callback)     — manual backup from toolbar button
//
// Requires:
//   js/db.js       — Db.query() for reading rows from DuckDB
//   js/sheets.js   — Sheets.getDeletedRows(callback) [manager only]
//
// ⚠ Browser support: Chrome and Edge only.
//   File System Access API is NOT supported in Firefox or Safari.
//   See docs/setup.md for details.
// ============================================================

var Backup = (function () {

  // ── Constants ─────────────────────────────────────────────

  // Separate IDB database — no interference with offline.js's telecom_tracker
  var DB_NAME    = 'telecom_backup';
  var DB_VERSION = 1;
  var STORE_META = 'meta';

  // Maximum number of rolling named backups (backup_latest.json not counted)
  var MAX_ROLLING = 14;

  // Schedule hours in 24-hour format
  var SCHEDULE_HOURS = [8, 15]; // 8:00 AM + 3:00 PM

  // localStorage key: slot key of the last scheduled backup that ran
  // Format: "YYYY-MM-DD_HH"  (e.g. "2026-04-12_08")
  var LS_LAST_SLOT = 'backup_last_slot';

  // ── State ─────────────────────────────────────────────────

  var _role          = null;
  var _name          = null;
  var _db            = null;

  // FileSystemDirectoryHandle | null — set when folder is ready + permitted
  var _dirHandle     = null;
  var _hasFolder     = false;

  // setInterval handle for the 30-second schedule checker
  var _scheduleTimer = null;


  // ── Public: init ──────────────────────────────────────────
  //
  // Called once from app.js after Grid.init(), once the user is
  // authenticated and the toolbar is in the DOM.

  function init(role, name) {
    _role = role;
    _name = name;

    _injectStyles();
    _injectButton();

    _openDb(function () {
      _restoreHandle(function () {
        // Run missed scheduled backup (app was closed at slot time)
        _checkMissedSchedule();
        // Start 30-second schedule ticker
        _startScheduleTimer();
      });
    });
  }


  // ── Public: onSave — per-save silent backup ───────────────
  //
  // Called from offline.js after every successful row write.
  // Overwrites backup_latest.json — no UI feedback, no rolling.

  function onSave() {
    if (!_hasFolder) return;
    _buildPayload(function (json) {
      _writeFile('backup_latest.json', json, null);
    });
  }


  // ── Public: now — manual backup ───────────────────────────
  //
  // Called from the "Backup Now" toolbar button.
  // If no folder is configured yet, shows the folder picker first.
  //
  // callback({ success, filename })  — optional
  // callback({ success:false, error })

  function now(callback) {
    _ensureFolder(function (ok) {
      if (!ok) {
        if (callback) callback({ success: false, error: 'No backup folder selected.' });
        return;
      }
      _writeNamedBackup(callback);
    });
  }


  // ── IDB helpers ───────────────────────────────────────────

  function _openDb(callback) {
    if (!window.indexedDB) {
      if (callback) callback();
      return;
    }

    var req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };

    req.onsuccess = function (e) {
      _db = e.target.result;
      if (callback) callback();
    };

    req.onerror = function () {
      console.error('[backup.js] Failed to open IDB.');
      if (callback) callback();
    };
  }

  function _dbGet(key, callback) {
    if (!_db) { callback(null); return; }
    try {
      var tx  = _db.transaction(STORE_META, 'readonly');
      var req = tx.objectStore(STORE_META).get(key);
      req.onsuccess = function () { callback(req.result ? req.result.value : null); };
      req.onerror   = function () { callback(null); };
    } catch (e) { callback(null); }
  }

  function _dbSet(key, value, callback) {
    if (!_db) { if (callback) callback(); return; }
    try {
      var tx  = _db.transaction(STORE_META, 'readwrite');
      var req = tx.objectStore(STORE_META).put({ key: key, value: value });
      req.onsuccess = function () { if (callback) callback(); };
      req.onerror   = function () { if (callback) callback(); };
    } catch (e) { if (callback) callback(); }
  }


  // ── Directory handle persistence ──────────────────────────
  //
  // FileSystemDirectoryHandle objects are structured-clone-serializable
  // and can be stored in IndexedDB. Chrome / Edge support this natively.

  function _restoreHandle(callback) {
    if (!window.showDirectoryPicker) {
      // API not available — silently disable automatic backup
      console.info('[backup.js] File System Access API not supported. ' +
        'Use Chrome or Edge for local backup.');
      if (callback) callback();
      return;
    }

    _dbGet('dir_handle', function (handle) {
      if (!handle) {
        // Folder never configured — backup waits for first "Backup Now" click
        if (callback) callback();
        return;
      }

      // queryPermission does NOT require a user gesture
      _queryPermission(handle, function (state) {
        if (state === 'granted') {
          _dirHandle = handle;
          _hasFolder = true;
          console.log('[backup.js] Backup folder ready:', handle.name);
        } else {
          // Keep the handle so requestPermission can be called on next
          // user gesture (the "Backup Now" button click)
          _dirHandle = handle;
          _hasFolder = false;
          console.info('[backup.js] Backup folder permission needs re-authorization.');
        }
        if (callback) callback();
      });
    });
  }

  // queryPermission — no user gesture required
  function _queryPermission(handle, callback) {
    if (!handle || !handle.queryPermission) { callback('prompt'); return; }
    handle.queryPermission({ mode: 'readwrite' })
      .then(function (state) { callback(state); })
      .catch(function ()     { callback('prompt'); });
  }

  // requestPermission — MUST be called from inside a user-gesture handler
  function _requestPermission(handle, callback) {
    if (!handle || !handle.requestPermission) { callback(false); return; }
    handle.requestPermission({ mode: 'readwrite' })
      .then(function (state) { callback(state === 'granted'); })
      .catch(function ()     { callback(false); });
  }

  // Ensure a folder is ready — request permission or show picker as needed.
  // MUST be called from a user-gesture handler (e.g. button click).
  function _ensureFolder(callback) {
    if (!window.showDirectoryPicker) {
      callback(false);
      return;
    }

    // Already fully ready
    if (_dirHandle && _hasFolder) {
      callback(true);
      return;
    }

    // Have handle but need permission re-grant
    if (_dirHandle && !_hasFolder) {
      _requestPermission(_dirHandle, function (granted) {
        if (granted) {
          _hasFolder = true;
          callback(true);
        } else {
          // Permission permanently denied — show picker to re-select
          _pickFolder(callback);
        }
      });
      return;
    }

    // No handle — show folder picker for the first time
    _pickFolder(callback);
  }

  function _pickFolder(callback) {
    window.showDirectoryPicker({ mode: 'readwrite' })
      .then(function (handle) {
        _dirHandle = handle;
        _hasFolder = true;
        _dbSet('dir_handle', handle, null);
        console.log('[backup.js] Backup folder configured:', handle.name);
        callback(true);
      })
      .catch(function (err) {
        // User dismissed the picker — not an error, just don't backup
        console.info('[backup.js] Folder picker dismissed:', err.message);
        callback(false);
      });
  }


  // ── Schedule logic ────────────────────────────────────────

  function _startScheduleTimer() {
    if (_scheduleTimer) clearInterval(_scheduleTimer);
    // Check every 30 seconds — fires within ≤30 s of any schedule hour
    _scheduleTimer = setInterval(_checkSchedule, 30 * 1000);
  }

  // Runs every 30 s from the timer.
  // Triggers a named backup when we enter a schedule slot for the first time.
  function _checkSchedule() {
    if (!_hasFolder) return;

    var now = new Date();
    var h   = now.getHours();
    var m   = now.getMinutes();

    // Only act during the first minute of a schedule hour
    if (SCHEDULE_HOURS.indexOf(h) === -1 || m > 0) return;

    var slotKey = _slotKey(now, h);
    if (localStorage.getItem(LS_LAST_SLOT) === slotKey) return; // already ran

    // Claim slot before async write — prevents double-fire from rapid ticks
    localStorage.setItem(LS_LAST_SLOT, slotKey);
    console.log('[backup.js] Running scheduled backup for slot:', slotKey);
    _writeNamedBackup(null);
  }

  // Called in init() — catches any slot that passed while the app was closed.
  function _checkMissedSchedule() {
    if (!_hasFolder) return;

    var missed = _mostRecentSlotKey();
    if (!missed) return;
    if (localStorage.getItem(LS_LAST_SLOT) === missed) return; // up to date

    localStorage.setItem(LS_LAST_SLOT, missed);
    console.log('[backup.js] Running missed scheduled backup for slot:', missed);
    _writeNamedBackup(null);
  }

  // Returns the slot key for the most recent schedule slot that has passed.
  function _mostRecentSlotKey() {
    var now   = new Date();
    var today = _dateStr(now);

    // Check today's slots descending — return the first that has passed
    var sorted = SCHEDULE_HOURS.slice().sort(function (a, b) { return b - a; });
    for (var i = 0; i < sorted.length; i++) {
      if (now.getHours() >= sorted[i]) {
        return today + '_' + _pad(sorted[i]);
      }
    }

    // Nothing has passed today — return yesterday's latest slot
    var yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    var lastHour  = Math.max.apply(null, SCHEDULE_HOURS);
    return _dateStr(yesterday) + '_' + _pad(lastHour);
  }

  // Stable, sortable slot key: "YYYY-MM-DD_HH"
  function _slotKey(date, hour) {
    return _dateStr(date) + '_' + _pad(hour);
  }


  // ── Named backup (scheduled + manual) ────────────────────

  function _writeNamedBackup(callback) {
    var filename = 'backup_' + _dateStr(new Date()) + '_' +
                   _timeStr(new Date()) + '.json';

    _buildPayload(function (json) {
      _writeFile(filename, json, function (ok) {
        if (ok) {
          _pruneOldBackups(null);
          console.log('[backup.js] Named backup written:', filename);
        }
        if (callback) callback({ success: ok, filename: filename });
      });
    });
  }


  // ── Backup payload builder ────────────────────────────────
  //
  // Reads rows from DuckDB — role-filtered for coordinator by the SQL WHERE
  // clause that grid.js uses (coordinator only sees their own rows in DuckDB).
  // Manager additionally fetches deleted records from the server (online only).

  function _buildPayload(callback) {
    var ts = new Date().toISOString();

    if (typeof Db === 'undefined') {
      callback(_serialize({
        exported_at: ts, role: _role, name: _name,
        row_count: 0, rows: [], error: 'DuckDB not initialised'
      }));
      return;
    }

    // Coordinator: only their own rows (DuckDB holds the filtered set already).
    // Invoicing / Manager: all non-deleted rows.
    var sql = _role === 'coordinator'
      ? "SELECT * FROM rows WHERE _is_deleted = false AND coordinator_name = '" +
          (_name || '').replace(/'/g, "''") + "'"
      : 'SELECT * FROM rows WHERE _is_deleted = false';

    Db.query(sql).then(function (rows) {
      // Strip DuckDB system columns — backup file should be clean business data
      var cleanRows = rows.map(function (row) {
        var clean = {};
        Object.keys(row).forEach(function (k) {
          if (k.charAt(0) !== '_') clean[k] = row[k];
        });
        return clean;
      });

      var payload = {
        exported_at: ts,
        role:        _role,
        name:        _name,
        row_count:   cleanRows.length,
        rows:        cleanRows
      };

      if (_role === 'manager' && navigator.onLine &&
          typeof Sheets !== 'undefined' && Sheets.getDeletedRows) {
        Sheets.getDeletedRows(function (result) {
          if (result.success && result.rows && result.rows.length) {
            payload.deleted_rows      = result.rows;
            payload.deleted_row_count = result.rows.length;
          }
          callback(_serialize(payload));
        });
      } else {
        callback(_serialize(payload));
      }

    }).catch(function (e) {
      console.warn('[backup.js] DuckDB read failed:', e.message || e);
      callback(_serialize({
        exported_at: ts, role: _role, name: _name,
        row_count: 0, rows: [], error: String(e.message || e)
      }));
    });
  }

  function _serialize(obj) {
    try   { return JSON.stringify(obj, null, 2); }
    catch (e) { return '{"error":"Serialization failed"}'; }
  }


  // ── File I/O ──────────────────────────────────────────────

  function _writeFile(filename, content, callback) {
    if (!_dirHandle) {
      if (callback) callback(false);
      return;
    }

    _dirHandle.getFileHandle(filename, { create: true })
      .then(function (fh)       { return fh.createWritable(); })
      .then(function (writable) {
        return writable.write(content).then(function () {
          return writable.close();
        });
      })
      .then(function ()  { if (callback) callback(true); })
      .catch(function (err) {
        console.error('[backup.js] Write failed (' + filename + '):', err.message);
        if (callback) callback(false);
      });
  }


  // ── Rolling backup pruner ─────────────────────────────────
  //
  // Lists all backup_YYYY-MM-DD_HHhmm.json files, sorts oldest first
  // (filename prefix is lexicographically date-sorted), deletes surplus.

  var _ROLLING_RE = /^backup_\d{4}-\d{2}-\d{2}_\d{2}h\d{2}\.json$/;

  function _pruneOldBackups(callback) {
    if (!_dirHandle) {
      if (callback) callback();
      return;
    }

    var files = [];
    var iter  = _dirHandle.values();

    (function _collect() {
      iter.next()
        .then(function (result) {
          if (result.done) {
            _deleteOldest(files, callback);
            return;
          }
          var entry = result.value;
          if (entry.kind === 'file' && _ROLLING_RE.test(entry.name)) {
            files.push(entry.name);
          }
          _collect();
        })
        .catch(function () { if (callback) callback(); });
    }());
  }

  function _deleteOldest(files, callback) {
    files.sort(); // lexicographic = oldest first
    var surplus  = files.length - MAX_ROLLING;

    if (surplus <= 0) {
      if (callback) callback();
      return;
    }

    var toDelete = files.slice(0, surplus);
    var idx = 0;

    (function _next() {
      if (idx >= toDelete.length) {
        if (callback) callback();
        return;
      }
      var fname = toDelete[idx++];
      _dirHandle.removeEntry(fname)
        .then(_next)
        .catch(function () { _next(); }); // skip if already gone
    }());
  }


  // ── Toolbar button ────────────────────────────────────────

  function _injectButton() {
    var toolbar = document.getElementById('toolbar-actions');
    if (!toolbar || document.getElementById('backup-now-btn')) return;

    var btn       = document.createElement('button');
    btn.id        = 'backup-now-btn';
    btn.className = 'toolbar-btn';
    btn.title     = 'Save a backup of all data to your local folder';
    btn.textContent = 'Backup Now';

    btn.addEventListener('click', function () {
      btn.disabled    = true;
      btn.textContent = 'Saving\u2026';

      now(function (result) {
        btn.disabled = false;

        if (result && result.success) {
          btn.textContent = '\u2713 Saved';
          _showSavedToast();
          setTimeout(function () { btn.textContent = 'Backup Now'; }, 2000);
        } else {
          btn.textContent = 'Backup Now';
          if (result && result.error &&
              result.error !== 'No backup folder selected.') {
            console.warn('[backup.js] Manual backup failed:', result.error);
          }
        }
      });
    });

    toolbar.appendChild(btn);
  }


  // ── "✓ Backup saved" toast ────────────────────────────────

  function _showSavedToast() {
    var toast       = document.createElement('div');
    toast.className = 'backup-toast';
    toast.textContent = '\u2713 Backup saved';
    document.body.appendChild(toast);

    // Two rAF calls ensure the element is in the DOM before the
    // CSS class transition begins, avoiding a zero-duration flash.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        toast.classList.add('backup-toast--visible');
      });
    });

    setTimeout(function () {
      toast.classList.remove('backup-toast--visible');
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 2000);
  }


  // ── Styles ────────────────────────────────────────────────

  function _injectStyles() {
    if (document.getElementById('backup-styles')) return;

    var s       = document.createElement('style');
    s.id        = 'backup-styles';
    s.textContent = [

      // Toolbar button — matches logout-btn style from app.js
      '#backup-now-btn {',
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
        'flex-shrink: 0;',
      '}',
      '#backup-now-btn:hover:not(:disabled) {',
        'background: rgba(255,255,255,0.08);',
        'color: var(--text-on-navy);',
      '}',
      '#backup-now-btn:disabled {',
        'opacity: 0.5;',
        'cursor: default;',
      '}',

      // ── "✓ Backup saved" toast ─────────────────────────────
      '.backup-toast {',
        'position: fixed;',
        'bottom: 48px;',
        'right: 20px;',
        'background: var(--color-success, #2a7a4a);',
        'color: #fff;',
        'font-family: var(--font-mono);',
        'font-size: 11px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'padding: 8px 16px;',
        'opacity: 0;',
        'transform: translateY(8px);',
        'transition: opacity 0.2s ease, transform 0.2s ease;',
        'pointer-events: none;',
        'z-index: 9999;',
      '}',
      '.backup-toast--visible {',
        'opacity: 1;',
        'transform: translateY(0);',
      '}',

    ].join('\n');

    document.head.appendChild(s);
  }


  // ── Date/time helpers ─────────────────────────────────────

  // Returns "YYYY-MM-DD"
  function _dateStr(d) {
    return d.getFullYear() + '-' +
      _pad(d.getMonth() + 1) + '-' +
      _pad(d.getDate());
  }

  // Returns "HHhmm" — e.g. "08h00", "15h32"
  function _timeStr(d) {
    return _pad(d.getHours()) + 'h' + _pad(d.getMinutes());
  }

  function _pad(n) {
    return String(n).padStart(2, '0');
  }


  // ── Expose ────────────────────────────────────────────────

  return {
    init:   init,
    onSave: onSave,
    now:    now
  };

}());
