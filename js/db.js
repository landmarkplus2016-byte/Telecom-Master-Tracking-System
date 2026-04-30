// ============================================================
// db.js — DuckDB WASM init, schema, and all data operations
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Load and initialise DuckDB WASM with OPFS persistence
//   - Define the database schema (43 business cols + system cols)
//   - Expose all data operations: query, upsert, bulk load, sync
//   - Manage session owner metadata (who is logged in locally)
//
// DuckDB WASM is loaded via the <script> CDN tag in index.html,
// which exposes the global `duckdb` object before this file runs.
//
// OPFS persistence requires cross-origin isolation (COOP + COEP
// headers).  These are injected by service-worker.js on every
// page response.  On the very first load (before the SW is active)
// DuckDB falls back to an in-memory database transparently.
// ============================================================

var Db = (function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────

  var DB_FILE  = 'telecom-tracker.db';   // OPFS file name
  // jsDelivr ESM endpoint — works regardless of whether duckdb-browser.js
  // exposes a global.  Dynamic import() handles ES modules correctly.
  var DUCKDB_CDN = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm';

  // ── Internal state ────────────────────────────────────────

  var _db    = null;    // AsyncDuckDB instance
  var _conn  = null;    // persistent connection (one per session)
  var _ready = false;
  var _opfs  = false;   // true when OPFS persistence is active
  var _duckdbLib = null; // cached module reference (avoids re-import on re-init)

  // ── Schema definition ─────────────────────────────────────
  //
  // ROW_COLUMNS mirrors grid.js COLUMNS exactly (same key names,
  // same order) so data from Apps Script can be passed directly
  // to loadAllRows / upsertRow without transformation.

  var ROW_COLUMNS = [
    // ── Coordinator columns ────────────────────────────────
    { name: 'id',                         type: 'TEXT'   },
    { name: 'job_code',                   type: 'TEXT'   },
    { name: 'tx_rf',                      type: 'TEXT'   },
    { name: 'vendor',                     type: 'TEXT'   },
    { name: 'physical_site_id',           type: 'TEXT'   },
    { name: 'logical_site_id',            type: 'TEXT'   },
    { name: 'site_option',                type: 'TEXT'   },
    { name: 'facing',                     type: 'TEXT'   },
    { name: 'region',                     type: 'TEXT'   },
    { name: 'sub_region',                 type: 'TEXT'   },
    { name: 'distance',                   type: 'TEXT'   },
    { name: 'absolute_quantity',          type: 'DOUBLE' },
    { name: 'actual_quantity',            type: 'DOUBLE' },
    { name: 'general_stream',             type: 'TEXT'   },
    { name: 'task_name',                  type: 'TEXT'   },
    { name: 'contractor',                 type: 'TEXT'   },
    { name: 'engineer_name',              type: 'TEXT'   },
    { name: 'line_item',                  type: 'TEXT'   },
    { name: 'new_price',                  type: 'DOUBLE' },
    { name: 'new_total_price',            type: 'DOUBLE' },
    { name: 'comments',                   type: 'TEXT'   },
    { name: 'status',                     type: 'TEXT'   },
    { name: 'task_date',                  type: 'TEXT'   },
    // Computed client-side for the pricing indicator column; stored
    // locally so the grid can restore it on reload without recalculation.
    { name: '_price_indicator',           type: 'TEXT'   },
    { name: 'vf_task_owner',              type: 'TEXT'   },
    { name: 'prq',                        type: 'TEXT'   },

    // ── Ownership column ───────────────────────────────────
    // Hidden from coordinator role; read-only for invoicing.
    { name: 'coordinator_name',           type: 'TEXT'   },

    // ── Invoicing / Manager columns ────────────────────────
    { name: 'acceptance_status',          type: 'TEXT'   },
    { name: 'fac_date',                   type: 'TEXT'   },
    { name: 'certificate_num',            type: 'TEXT'   },
    { name: 'acceptance_week',            type: 'TEXT'   },
    { name: 'tsr_sub',                    type: 'TEXT'   },
    { name: 'po_status',                  type: 'TEXT'   },
    { name: 'po_number',                  type: 'TEXT'   },
    { name: 'vf_invoice_num',             type: 'TEXT'   },
    { name: 'first_receiving_date',       type: 'TEXT'   },
    { name: 'lmp_portion',               type: 'DOUBLE' },
    { name: 'contractor_portion',         type: 'DOUBLE' },
    { name: 'sent_to_cost_control',       type: 'TEXT'   },
    { name: 'received_from_cc',           type: 'TEXT'   },
    { name: 'contractor_invoice_num',     type: 'TEXT'   },
    { name: 'vf_invoice_submission_date', type: 'TEXT'   },
    { name: 'cash_received_date',         type: 'TEXT'   },
  ];

  // System columns added by db.js — not present in Apps Script payloads.
  // Stored separately so we can easily distinguish them from business data.
  var SYS_COLS = [
    // Primary key — derived from _row_index (server rows) or generated locally
    { name: '_row_id',       ddl: 'TEXT PRIMARY KEY',      type: 'TEXT'    },
    // Mirrors the server last_modified timestamp; used for delta sync
    { name: '_last_modified',ddl: 'TIMESTAMP',             type: 'TS'      },
    // Row is locked (acceptance_status filled) — checked in grid editable cb
    { name: '_is_locked',    ddl: 'BOOLEAN DEFAULT false', type: 'BOOLEAN' },
    // Soft-deleted — hidden from main view, visible in Manager deleted tab
    { name: '_is_deleted',   ddl: 'BOOLEAN DEFAULT false', type: 'BOOLEAN' },
    // Edited offline; sync.js drains this queue on reconnect
    { name: '_pending_sync', ddl: 'BOOLEAN DEFAULT false', type: 'BOOLEAN' },
    // Version mismatch detected during sync — awaiting manager resolution
    { name: '_conflict',     ddl: 'BOOLEAN DEFAULT false', type: 'BOOLEAN' },
  ];

  // ══════════════════════════════════════════════════════════
  // INITIALISATION
  // ══════════════════════════════════════════════════════════

  // ── DuckDB module loader ───────────────────────────────────
  //
  // duckdb-browser.js at v1.29.0 is an ES module, not a UMD bundle.
  // Loading it via <script src> does NOT create window.duckdb.
  // Dynamic import() handles ES modules correctly and is supported in
  // all modern Chrome versions (which is our target browser).
  //
  // We also keep the global fallback so that if someone does add a
  // UMD-compatible script tag in the future, it still works.

  async function _loadDuckDB() {
    if (_duckdbLib) return _duckdbLib;

    // Prefer an already-available global (e.g. older UMD script tag)
    if (typeof duckdb !== 'undefined') {
      _duckdbLib = duckdb;
      return _duckdbLib;
    }

    // Load the ESM bundle via dynamic import — self-contained, no <script> needed
    console.log('[Db] loading DuckDB WASM via dynamic import...');
    _duckdbLib = await import(DUCKDB_CDN);
    return _duckdbLib;
  }

  /**
   * Load DuckDB WASM and open the OPFS-backed database.
   * Idempotent — safe to call multiple times.
   *
   * Falls back to in-memory if OPFS is unavailable (first load before
   * the service worker is active, or browser without OPFS support).
   */
  async function init() {
    if (_ready) return;

    var d = await _loadDuckDB();

    console.log('[Db] init() — selecting bundle...');
    var bundles = d.getJsDelivrBundles();
    var bundle  = await d.selectBundle(bundles);
    console.log('[Db] bundle:', bundle.mainModule);

    // Blob worker: same-origin, sidesteps COEP worker-script restrictions.
    // importScripts() inside the worker fetches the CDN worker; CDN responses
    // go through our SW which stamps CORP headers on them.
    var workerBlob = new Blob(
      ['importScripts("' + bundle.mainWorker + '");'],
      { type: 'text/javascript' }
    );
    var workerUrl = URL.createObjectURL(workerBlob);
    var worker    = new Worker(workerUrl);
    URL.revokeObjectURL(workerUrl);

    // VoidLogger suppresses DuckDB's verbose console output (query echoes,
    // internal warnings).  Real errors still surface via our .catch() handlers.
    var logger = new d.VoidLogger();
    _db = new d.AsyncDuckDB(logger, worker);

    // pthreadWorker is only present in the COI build (SharedArrayBuffer).
    await _db.instantiate(bundle.mainModule, bundle.pthreadWorker);

    // Try OPFS first; fall back to in-memory if not available.
    try {
      await _db.open({
        path:       'opfs://' + DB_FILE,
        accessMode: d.DuckDBAccessMode.READ_WRITE,
      });
      _opfs = true;
      console.log('[Db] OPFS database opened:', DB_FILE);
    } catch (e) {
      console.warn('[Db] OPFS unavailable, using in-memory:', e.message);
      await _db.open({ path: ':memory:' });
      _opfs = false;
    }

    _conn = await _db.connect();
    await _createSchema();

    _ready = true;
    console.log('[Db] ready — persistent:', _opfs);
  }

  // ── Schema creation ────────────────────────────────────────

  async function _createSchema() {
    // rows — all tracking records (business + system columns)
    var colDefs = SYS_COLS.map(function (c) { return c.name + ' ' + c.ddl; })
      .concat(ROW_COLUMNS.map(function (c) { return c.name + ' ' + c.type; }));

    await _conn.query(
      'CREATE TABLE IF NOT EXISTS rows (\n  ' +
      colDefs.join(',\n  ') +
      '\n)'
    );

    // metadata — key/value pairs for session state (owner name, role, etc.)
    await _conn.query(
      'CREATE TABLE IF NOT EXISTS metadata (\n' +
      '  key   TEXT PRIMARY KEY,\n' +
      '  value TEXT\n' +
      ')'
    );
  }

  // ══════════════════════════════════════════════════════════
  // SESSION OWNER
  // ══════════════════════════════════════════════════════════

  /**
   * Returns the currently stored session owner, or null if not set.
   * @returns {Promise<{name: string, role: string}|null>}
   */
  async function getSessionOwner() {
    _assertReady();
    var result = await _conn.query(
      "SELECT key, value FROM metadata WHERE key IN ('owner_name', 'owner_role')"
    );
    var rows = _toObjects(result);
    if (!rows.length) return null;
    var map = {};
    rows.forEach(function (r) { map[r.key] = r.value; });
    return map.owner_name ? { name: map.owner_name, role: map.owner_role || null } : null;
  }

  /**
   * Persist the current session owner to the metadata table.
   * Overwrites any previous value.
   */
  async function setSessionOwner(name, role) {
    _assertReady();
    await _upsertMeta('owner_name', String(name || ''));
    await _upsertMeta('owner_role', String(role || ''));
  }

  async function _upsertMeta(key, value) {
    await _conn.query(
      'INSERT INTO metadata (key, value) VALUES (\'' + _esc(key) + '\', \'' + _esc(value) + '\')' +
      ' ON CONFLICT (key) DO UPDATE SET value = excluded.value'
    );
  }

  // ══════════════════════════════════════════════════════════
  // ROW OPERATIONS
  // ══════════════════════════════════════════════════════════

  /**
   * Delete all rows from the rows table.
   * Called when switching users (different session owner) so stale
   * data from the previous user is never shown.
   */
  async function clearRows() {
    _assertReady();
    await _conn.query('DELETE FROM rows');
    console.log('[Db] clearRows() complete');
  }

  /**
   * Bulk-insert/update an array of row objects from an Apps Script response.
   * Runs inside a transaction for atomicity and speed.
   *
   * Unknown fields in each row object are silently ignored — only fields
   * that match ROW_COLUMNS or SYS_COLS are written to the database.
   */
  async function loadAllRows(rows) {
    _assertReady();
    if (!rows || !rows.length) return;

    await _conn.query('BEGIN');
    try {
      for (var i = 0; i < rows.length; i++) {
        await _upsertRowSQL(rows[i]);
      }
      await _conn.query('COMMIT');
    } catch (e) {
      await _conn.query('ROLLBACK');
      throw e;
    }
    console.log('[Db] loadAllRows() —', rows.length, 'rows');
  }

  /**
   * Insert or update a single row by _row_id.
   * Suitable for incremental writes (delta sync, user edits).
   */
  async function upsertRow(row) {
    _assertReady();
    await _upsertRowSQL(row);
  }

  // ── Core upsert logic ──────────────────────────────────────

  async function _upsertRowSQL(row) {
    var rowId = _rowId(row);

    var names  = [];   // column name list
    var vals   = [];   // SQL literal list (same order)
    var setCls = [];   // "col = excluded.col" list for ON CONFLICT

    // System columns
    SYS_COLS.forEach(function (c) {
      names.push(c.name);
      vals.push(_sysVal(c, row, rowId));
      if (c.name !== '_row_id') {
        setCls.push(c.name + ' = excluded.' + c.name);
      }
    });

    // Business columns
    ROW_COLUMNS.forEach(function (c) {
      names.push(c.name);
      vals.push(_busVal(c, row));
      setCls.push(c.name + ' = excluded.' + c.name);
    });

    var sql =
      'INSERT INTO rows (' + names.join(', ') + ')\n' +
      'VALUES (' + vals.join(', ') + ')\n' +
      'ON CONFLICT (_row_id) DO UPDATE SET\n  ' +
      setCls.join(',\n  ');

    await _conn.query(sql);
  }

  // Build _row_id: prefer an explicit _row_id, then fall back to
  // _row_index (server-assigned sheet row), then generate a local ID.
  function _rowId(row) {
    if (row._row_id)    return String(row._row_id);
    if (row._row_index) return 'row_' + String(row._row_index);
    return 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  // Build SQL literal for a system column
  function _sysVal(col, row, rowId) {
    if (col.name === '_row_id') return _sqlStr(rowId);

    var v = row[col.name];

    if (col.type === 'TS') {
      return (v && v !== '') ? _sqlStr(String(v)) : 'CURRENT_TIMESTAMP';
    }

    if (col.type === 'BOOLEAN') {
      // _is_locked: auto-derive from acceptance_status when not explicitly set.
      // A row is locked the moment acceptance_status is filled — no other trigger.
      if (col.name === '_is_locked') {
        var locked = (v !== undefined && v !== null)
          ? (v === true || v === 'true' || v === 1)
          : !!(row.acceptance_status && String(row.acceptance_status || '').trim());
        return locked ? 'true' : 'false';
      }
      return (v === true || v === 'true' || v === 1) ? 'true' : 'false';
    }

    return (v !== null && v !== undefined && v !== '') ? _sqlStr(String(v)) : 'NULL';
  }

  // Build SQL literal for a business column
  function _busVal(col, row) {
    var v = row[col.name];
    if (v === null || v === undefined || v === '') return 'NULL';

    if (col.type === 'DOUBLE') {
      var n = parseFloat(v);
      return isNaN(n) ? 'NULL' : String(n);
    }
    return _sqlStr(String(v));
  }

  // ══════════════════════════════════════════════════════════
  // QUERY
  // ══════════════════════════════════════════════════════════

  /**
   * Execute a SQL query and return results as an array of plain objects.
   *
   * @param {string} sql          Parameterised SQL (use ? for placeholders)
   * @param {any[]}  [params]     Positional parameter values
   * @returns {Promise<object[]>}
   *
   * Examples:
   *   Db.query('SELECT * FROM rows')
   *   Db.query('SELECT * FROM rows WHERE coordinator_name = ?', ['Ahmed'])
   */
  async function query(sql, params) {
    _assertReady();

    if (!params || params.length === 0) {
      return _toObjects(await _conn.query(sql));
    }

    var stmt = await _conn.prepare(sql);
    try {
      var result = await stmt.query.apply(stmt, params);
      return _toObjects(result);
    } finally {
      await stmt.close();
    }
  }

  // ══════════════════════════════════════════════════════════
  // SYNC HELPERS
  // ══════════════════════════════════════════════════════════

  /**
   * Returns all rows where _pending_sync = true (not yet written to server).
   * Called by sync.js when draining the offline queue.
   */
  async function getPendingRows() {
    _assertReady();
    return query('SELECT * FROM rows WHERE _pending_sync = true AND _is_deleted = false');
  }

  /**
   * Clears the _pending_sync flag after a row has been successfully written
   * to Apps Script.
   */
  async function markSynced(rowId) {
    _assertReady();
    await _conn.query(
      "UPDATE rows SET _pending_sync = false WHERE _row_id = '" + _esc(String(rowId)) + "'"
    );
  }

  // ══════════════════════════════════════════════════════════
  // INTERNAL UTILITIES
  // ══════════════════════════════════════════════════════════

  function _assertReady() {
    if (!_ready || !_conn) {
      throw new Error('[Db] not initialised — call await Db.init() first');
    }
  }

  // Escape single quotes in SQL string literals
  function _esc(val) {
    return String(val === null || val === undefined ? '' : val).replace(/'/g, "''");
  }

  // Wrap a value in SQL single-quoted string literal
  function _sqlStr(val) {
    return "'" + _esc(val) + "'";
  }

  // Convert Apache Arrow Table → array of plain JS objects.
  // DuckDB WASM returns Arrow Tables; each row is an Arrow proxy object
  // with field accessor properties.  BigInt values are coerced to Number.
  function _toObjects(arrowTable) {
    if (!arrowTable || arrowTable.numRows === 0) return [];
    var fields = arrowTable.schema.fields;
    return arrowTable.toArray().map(function (row) {
      var obj = {};
      fields.forEach(function (f) {
        var v = row[f.name];
        if (typeof v === 'bigint') v = Number(v);
        obj[f.name] = v;
      });
      return obj;
    });
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════

  return {
    init:             init,
    getSessionOwner:  getSessionOwner,
    setSessionOwner:  setSessionOwner,
    clearRows:        clearRows,
    loadAllRows:      loadAllRows,
    upsertRow:        upsertRow,
    query:            query,
    getPendingRows:   getPendingRows,
    markSynced:       markSynced,
  };

}());
