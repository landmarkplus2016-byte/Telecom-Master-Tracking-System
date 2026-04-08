// ============================================================
// Code.gs — Apps Script Gatekeeper
// Telecom Coordinator Tracking App — Stage 1
// ============================================================
//
// Deploy as Web App:
//   Execute as: Me
//   Who has access: Anyone
//
// All requests must be POST with a JSON body:
//   { action, name, code, ...params }
//
// Actions (Stage 1):
//   ping     — health check, no auth required
//   auth     — authenticate a user, returns role + name
//   getRows  — fetch all rows (role-filtered)
//   writeRow — create or update a single row
//
// ============================================================
// EXPECTED CONFIG TAB LAYOUT
// ============================================================
//
// The Config tab uses section markers in column A.
// A blank cell in column A ends the current section.
//
// Row: [TEAM_MEMBERS]
// Row: Name         | Code      | Role
// Row: Alice        | abc123    | Coordinator
// Row: Bob          | def456    | Invoicing
// Row: Carol        | ghi789    | Manager
// (blank row ends section)
//
// Roles must be one of: Coordinator, Invoicing, Manager
// (case-insensitive on login)
//
// ============================================================


// ── Sheet tab names ──────────────────────────────────────────

var SHEET_DATA     = 'Data';
var SHEET_CONFIG   = 'Config';
var SHEET_DELETED  = 'Deleted';
var SHEET_PRESENCE = 'Presence';
var SHEET_CHANGES  = 'Changes';


// ── Column definitions ────────────────────────────────────────
//
// 43 columns total — matches the original Excel exactly.
//
// Hidden from ALL grid views (sheet only):
//   row_num (index 1) — internal row reference, never shown in UI
//
// Coordinator sees 25 columns (all coordinator cols minus
//   row_num and coordinator_name).
// Invoicing + Manager see 42 columns (all minus row_num).
//
// These keys are used as the header row in the Data tab.
// Display labels are defined in js/grid.js.

var ALL_COLUMNS = [
  // ── Coordinator-side columns (0–26) ──
  'id',                         //  0  ID# (auto-generated)
  'row_num',                    //  1  Row — sheet only, hidden from all grid views
  'job_code',                   //  2  Job Code
  'tx_rf',                      //  3  TX/RF
  'vendor',                     //  4  Vendor
  'physical_site_id',           //  5  Physical Site ID
  'logical_site_id',            //  6  Logical Site ID
  'site_option',                //  7  Site Option
  'facing',                     //  8  Facing
  'region',                     //  9  Region
  'sub_region',                 // 10  Sub Region
  'distance',                   // 11  Distance
  'absolute_quantity',          // 12  Absolute Quantity
  'actual_quantity',            // 13  Actual Quantity
  'general_stream',             // 14  General Stream
  'task_name',                  // 15  Task Name
  'contractor',                 // 16  Contractor
  'engineer_name',              // 17  Engineer's Name
  'line_item',                  // 18  Line Item
  'new_price',                  // 19  New Price
  'new_total_price',            // 20  New Total Price (auto-calc)
  'comments',                   // 21  Comments
  'status',                     // 22  Status
  'task_date',                  // 23  Task Date (drives price version)
  'vf_task_owner',              // 24  VF Task Owner
  'prq',                        // 25  PRQ

  // ── Ownership column (26) ──
  'coordinator_name',           // 26  Coordinator — hidden from coordinator, read-only for invoicing

  // ── Invoicing columns (27–42) ──
  'acceptance_status',          // 27  Acceptance Status ← row lock trigger
  'fac_date',                   // 28  FAC Date
  'certificate_num',            // 29  Certificate #
  'acceptance_week',            // 30  Acceptance Week
  'tsr_sub',                    // 31  TSR Sub#
  'po_status',                  // 32  PO Status
  'po_number',                  // 33  PO Number
  'vf_invoice_num',             // 34  VF Invoice #
  'first_receiving_date',       // 35  1st Receiving Date
  'lmp_portion',                // 36  LMP Portion (auto-calc)
  'contractor_portion',         // 37  Contractor Portion (auto-calc)
  'sent_to_cost_control',       // 38  Sent to Cost Control
  'received_from_cc',           // 39  Received from CC
  'contractor_invoice_num',     // 40  Contractor Invoice #
  'vf_invoice_submission_date', // 41  VF Invoice Submission Date
  'cash_received_date',         // 42  Cash Received Date

  // ── System metadata — hidden from all grid views ──
  // Stored in the sheet but never rendered in the UI.
  // Returned in API responses as _last_modified / _created_date (epoch ms).
  'last_modified',              // 43  Unix ms timestamp — set on every writeRow
  'created_date'                // 44  Unix ms timestamp — set on row creation only
];

// Keys the coordinator role can see in the grid.
// Excludes: row_num (hidden from all) and coordinator_name (hidden from coordinator).
var COORDINATOR_VISIBLE_KEYS = [
  'id', 'job_code', 'tx_rf', 'vendor', 'physical_site_id',
  'logical_site_id', 'site_option', 'facing', 'region', 'sub_region',
  'distance', 'absolute_quantity', 'actual_quantity', 'general_stream',
  'task_name', 'contractor', 'engineer_name', 'line_item', 'new_price',
  'new_total_price', 'comments', 'status', 'task_date', 'vf_task_owner', 'prq'
]; // 25 columns

// Keys stripped from coordinator API responses:
//   row_num + coordinator_name + all 16 invoicing columns
var COORDINATOR_STRIPPED_KEYS = (function () {
  var stripped = {};
  // Everything not in COORDINATOR_VISIBLE_KEYS gets stripped
  var visible = {};
  for (var v = 0; v < COORDINATOR_VISIBLE_KEYS.length; v++) {
    visible[COORDINATOR_VISIBLE_KEYS[v]] = true;
  }
  for (var a = 0; a < ALL_COLUMNS.length; a++) {
    if (!visible[ALL_COLUMNS[a]]) stripped[ALL_COLUMNS[a]] = true;
  }
  return stripped;
}());

// Keys visible to invoicing + manager: all except row_num and system metadata.
// last_modified / created_date are returned separately as _last_modified / _created_date.
var INVOICING_MANAGER_VISIBLE_KEYS = ALL_COLUMNS.filter(function (k) {
  return k !== 'row_num' && k !== 'last_modified' && k !== 'created_date';
});


// ── Entry points ──────────────────────────────────────────────

function doGet(e) {
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}


// ── Request router ────────────────────────────────────────────

function handleRequest(e) {
  try {
    var params = parseParams(e);

    // Health check — no auth required
    if (!params.action || params.action === 'ping') {
      return jsonResponse({ success: true, message: 'Tracking App API is running.' });
    }

    // All other actions require authentication
    var authResult = authenticate(params.name, params.code);
    if (!authResult.success) {
      return jsonResponse({ success: false, error: authResult.error });
    }

    switch (params.action) {

      case 'auth':
        return jsonResponse(authResult);

      case 'getRows':
        // params.since — optional epoch-ms number; when set, only rows modified after it are returned
        return jsonResponse(getRows(authResult.role, authResult.name, params.since));

      case 'writeRow':
        return jsonResponse(writeRow(params.row, authResult.role, authResult.name));

      case 'writeBatch':
        return jsonResponse(writeBatch(params.rows, authResult.role, authResult.name));

      case 'getConfig':
        return jsonResponse(getConfigData());

      default:
        return jsonResponse({ success: false, error: 'Unknown action: ' + params.action });
    }

  } catch (err) {
    return jsonResponse({ success: false, error: 'Server error: ' + err.message });
  }
}


// ── Parameter parsing ─────────────────────────────────────────

function parseParams(e) {
  // POST with JSON body takes priority
  if (e && e.postData && e.postData.contents) {
    try {
      return JSON.parse(e.postData.contents);
    } catch (_) {
      // fall through to URL params
    }
  }
  // GET query parameters (or empty object for bare URL hits)
  return (e && e.parameter) ? e.parameter : {};
}


// ── Authentication ────────────────────────────────────────────

function authenticate(name, code) {
  if (!name || !code) {
    return { success: false, error: 'Name and access code are required.' };
  }

  var members = getTeamMembers();
  if (!members.length) {
    return { success: false, error: 'No team members found in Config tab. Check [TEAM_MEMBERS] section.' };
  }

  var normalizedName = name.trim().toLowerCase();
  var normalizedCode = code.trim();

  for (var i = 0; i < members.length; i++) {
    var m = members[i];
    if (m.name.toLowerCase() === normalizedName && m.code === normalizedCode) {
      return {
        success:     true,
        name:        m.name,
        role:        m.role.toLowerCase(),
        displayName: m.name
      };
    }
  }

  return { success: false, error: 'Invalid name or access code.' };
}


// ── Config tab — team members ─────────────────────────────────

function getTeamMembers() {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var config = ss.getSheetByName(SHEET_CONFIG);
  if (!config) throw new Error('Config tab not found.');

  var data       = config.getDataRange().getValues();
  var members    = [];
  var inSection  = false;
  var headerSeen = false;
  var nameIdx    = -1;
  var codeIdx    = -1;
  var roleIdx    = -1;

  for (var i = 0; i < data.length; i++) {
    var rowLabel = String(data[i][0]).trim();

    // Section start marker
    if (rowLabel === '[TEAM_MEMBERS]') {
      inSection  = true;
      headerSeen = false;
      continue;
    }

    if (!inSection) continue;

    // Blank first cell ends the section
    if (rowLabel === '') break;

    // First non-blank row after marker is the header
    if (!headerSeen) {
      headerSeen = true;
      var headers = data[i].map(function (h) { return String(h).trim().toLowerCase(); });
      nameIdx = headers.indexOf('name');
      codeIdx = headers.indexOf('code');
      roleIdx = headers.indexOf('role');

      if (nameIdx === -1 || codeIdx === -1 || roleIdx === -1) {
        throw new Error('Config [TEAM_MEMBERS] section must have Name, Code, and Role columns.');
      }
      continue;
    }

    // Data rows
    var memberName = String(data[i][nameIdx] || '').trim();
    var memberCode = String(data[i][codeIdx] || '').trim();
    var memberRole = String(data[i][roleIdx] || '').trim();

    if (memberName && memberCode && memberRole) {
      members.push({ name: memberName, code: memberCode, role: memberRole });
    }
  }

  return members;
}


// ── Read rows ─────────────────────────────────────────────────
//
// since — optional epoch-ms number (Number or numeric string).
//   When provided: only return rows where _last_modified > since.
//   Rows with no last_modified value (legacy rows) are ALWAYS returned
//   so that existing data is never silently hidden during the migration
//   period before all rows have been stamped.
// serverTime is always returned so the client can save it as the new
// sync cursor after a successful fetch.

function getRows(role, coordinatorName, since) {
  var sinceMs   = since ? Number(since) : 0;
  var serverTime = Date.now();

  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var dataSheet = ss.getSheetByName(SHEET_DATA);

  if (!dataSheet) {
    return {
      success:    true,
      rows:       [],
      columns:    getVisibleColumns(role),
      serverTime: serverTime
    };
  }

  var values = dataSheet.getDataRange().getValues();

  if (values.length < 2) {
    return {
      success:    true,
      rows:       [],
      columns:    getVisibleColumns(role),
      serverTime: serverTime
    };
  }

  var headers     = values[0].map(function (h) { return String(h).trim(); });
  var colIndexMap = buildColumnIndexMap(headers);
  var rows        = [];

  for (var i = 1; i < values.length; i++) {
    var rawRow = values[i];

    // Skip entirely empty rows
    var isEmpty = true;
    for (var c = 0; c < rawRow.length; c++) {
      if (rawRow[c] !== '' && rawRow[c] !== null && rawRow[c] !== undefined) {
        isEmpty = false;
        break;
      }
    }
    if (isEmpty) continue;

    // Build a keyed object from all known columns
    var rowObj = {};
    for (var k = 0; k < ALL_COLUMNS.length; k++) {
      var key = ALL_COLUMNS[k];
      var idx = colIndexMap[key];
      rowObj[key] = (idx !== undefined) ? formatCell(rawRow[idx]) : '';
    }

    // Include the 1-based sheet row number so the client can pass it back on updates
    rowObj._row_index = i + 1;

    // ── Metadata: read last_modified / created_date as epoch-ms numbers ──
    // Exposed as _last_modified / _created_date so they survive the
    // coordinator strip loop below (which only strips ALL_COLUMNS keys).
    var lmIdx = colIndexMap['last_modified'];
    rowObj._last_modified = lmIdx !== undefined ? _toEpochMs(rawRow[lmIdx]) : 0;

    var cdIdx = colIndexMap['created_date'];
    rowObj._created_date = cdIdx !== undefined ? _toEpochMs(rawRow[cdIdx]) : 0;

    // Remove the raw string versions — only the _prefixed ones are sent to clients
    delete rowObj['last_modified'];
    delete rowObj['created_date'];

    // ── Delta filter ─────────────────────────────────────────────
    // Skip rows not changed since the client's last sync.
    // Rows without a timestamp (legacy rows before delta sync was added)
    // always pass through so existing data is never lost.
    if (sinceMs && rowObj._last_modified && rowObj._last_modified <= sinceMs) continue;

    // ── Role-based row and column filtering ───────────────────

    if (role === 'coordinator') {
      var owner = String(rowObj.coordinator_name || '').trim().toLowerCase();
      var self  = String(coordinatorName || '').trim().toLowerCase();
      if (owner !== self) continue;

      // Stamp _locked BEFORE stripping invoicing columns so the coordinator
      // client knows this row is read-only without ever seeing acceptance_status.
      rowObj._locked = (String(rowObj.acceptance_status || '').trim() !== '');

      for (var stripped in COORDINATOR_STRIPPED_KEYS) {
        delete rowObj[stripped];
      }
    }

    // Invoicing and Manager receive all rows and all columns.
    // Invoicing read-only on coordinator_name is enforced in writeRow.

    rows.push(rowObj);
  }

  return {
    success:    true,
    rows:       rows,
    columns:    getVisibleColumns(role),
    serverTime: serverTime
  };
}

function getVisibleColumns(role) {
  return (role === 'coordinator') ? COORDINATOR_VISIBLE_KEYS : INVOICING_MANAGER_VISIBLE_KEYS;
}

function buildColumnIndexMap(headers) {
  var map = {};
  for (var k = 0; k < ALL_COLUMNS.length; k++) {
    var key = ALL_COLUMNS[k];
    var idx = headers.indexOf(key);
    if (idx !== -1) map[key] = idx;
  }
  return map;
}

// Convert any value to an epoch-ms number for last_modified / created_date.
// Handles: JS Date objects (from Sheets), numeric strings, ISO strings.
// Returns 0 if the value cannot be parsed.
function _toEpochMs(value) {
  if (!value && value !== 0) return 0;
  if (value instanceof Date) return value.getTime();
  var n = Number(value);
  if (!isNaN(n) && n > 0) return n;
  // ISO string fallback (old rows stored as ISO before epoch-ms migration)
  var d = new Date(value);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// Ensure every column in ALL_COLUMNS exists as a header in the Data sheet.
// Adds any missing columns to the right of the existing headers.
// Called at the start of writeRow so new system columns (last_modified etc.)
// are added automatically without manual sheet migration.
function ensureColumns(dataSheet, headerRow) {
  var missing = [];
  for (var k = 0; k < ALL_COLUMNS.length; k++) {
    if (headerRow.indexOf(ALL_COLUMNS[k]) === -1) {
      missing.push(ALL_COLUMNS[k]);
    }
  }
  if (!missing.length) return;
  var nextCol = headerRow.length + 1;
  dataSheet.getRange(1, nextCol, 1, missing.length).setValues([missing]);
}

function formatCell(value) {
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();

  // Google Sheets Date object → format in sheet's timezone
  if (value instanceof Date) {
    return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  }

  // ISO datetime strings stored by old code (e.g. "2026-04-20T22:00:00.000Z")
  // Parse and reformat in the sheet's timezone so there is no off-by-one-day error.
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    try {
      return Utilities.formatDate(new Date(value), tz, 'yyyy-MM-dd');
    } catch (e) {
      return value.slice(0, 10); // fallback: strip time part
    }
  }

  if (value === null || value === undefined) return '';
  return value;
}


// ── Write row ─────────────────────────────────────────────────

function writeRow(rowData, role, coordinatorName) {
  if (!rowData) {
    return { success: false, error: 'No row data provided.' };
  }

  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var dataSheet = ss.getSheetByName(SHEET_DATA);
  if (!dataSheet) {
    return { success: false, error: 'Data tab not found.' };
  }

  var nowMs = Date.now(); // epoch-ms — safe to store as a number in Sheets

  // ── Coordinator cannot set Acceptance Status ──
  if (role === 'coordinator' &&
      'acceptance_status' in rowData &&
      rowData.acceptance_status !== '') {
    return { success: false, error: 'Coordinators cannot set Acceptance Status.' };
  }

  // ── Auto-stamp coordinator name on coordinator writes ──
  if (role === 'coordinator') {
    rowData.coordinator_name = coordinatorName;
  }

  // Always stamp last_modified; stamp created_date on new rows only
  rowData.last_modified = nowMs;
  if (!rowData._row_index && !rowData.created_date) {
    rowData.created_date = nowMs;
  }

  // ── Ensure Data tab has a header row ──
  var allValues = dataSheet.getDataRange().getValues();
  var headerRow = (allValues.length > 0)
    ? allValues[0].map(function (h) { return String(h).trim(); })
    : [];

  if (headerRow.length === 0 || headerRow[0] === '') {
    dataSheet.appendRow(ALL_COLUMNS);
    allValues = dataSheet.getDataRange().getValues();
    headerRow = allValues[0].map(function (h) { return String(h).trim(); });
  } else {
    // Add any missing columns (e.g. last_modified, created_date on existing sheets)
    ensureColumns(dataSheet, headerRow);
    // Re-read headers if columns were added
    headerRow = dataSheet.getRange(1, 1, 1, dataSheet.getLastColumn()).getValues()[0]
                  .map(function (h) { return String(h).trim(); });
  }

  var colIndexMap = buildColumnIndexMap(headerRow);

  // ── JC uniqueness check ────────────────────────────────────────────
  // If a job_code is being written, scan all existing rows to ensure
  // no other row already uses that JC on a different Logical Site ID.
  if (rowData.job_code) {
    var jcLower     = String(rowData.job_code).trim().toLowerCase();
    var ownSite     = String(rowData.logical_site_id || '').trim().toLowerCase();
    var ownRowIndex = rowData._row_index || null; // null for new rows
    var jcIdx       = colIndexMap['job_code'];
    var siteIdx     = colIndexMap['logical_site_id'];

    if (jcIdx !== undefined) {
      for (var r = 1; r < allValues.length; r++) {
        var sheetRowNum = r + 1; // 1-based
        if (ownRowIndex && sheetRowNum === ownRowIndex) continue; // skip self

        var rowJC   = String(allValues[r][jcIdx] || '').trim().toLowerCase();
        if (rowJC !== jcLower) continue;

        var rowSite = siteIdx !== undefined ? String(allValues[r][siteIdx] || '').trim().toLowerCase() : '';
        if (rowSite !== ownSite) {
          var conflictSite = siteIdx !== undefined ? String(allValues[r][siteIdx] || '').trim() : '';
          return {
            success: false,
            error:   'Job Code "' + rowData.job_code.trim() + '" is already assigned to site ' +
                     (conflictSite || '(no site)') + '. A Job Code can only belong to one site.'
          };
        }
      }
    }
  }

  var rowIndex = rowData._row_index; // 1-based sheet row; absent for new rows

  if (rowIndex && rowIndex > 1) {
    // ── Update existing row ──────────────────────────────────

    var totalCols  = headerRow.length;
    var sheetRange = dataSheet.getRange(rowIndex, 1, 1, totalCols);
    var existing   = sheetRange.getValues()[0];

    // Row lock: coordinator cannot edit a row where Acceptance Status is filled
    var acceptanceIdx = colIndexMap['acceptance_status'];
    if (role === 'coordinator' && acceptanceIdx !== undefined) {
      var acceptanceValue = existing[acceptanceIdx];
      if (acceptanceValue !== '' && acceptanceValue !== null && acceptanceValue !== undefined) {
        return {
          success: false,
          error:   'This record is locked because acceptance is in progress. Contact the invoicing team for changes.'
        };
      }
    }

    // Coordinator ownership: coordinator can only edit rows they own
    if (role === 'coordinator') {
      var ownerIdx = colIndexMap['coordinator_name'];
      if (ownerIdx !== undefined) {
        var rowOwner = String(existing[ownerIdx] || '').trim().toLowerCase();
        var self     = String(coordinatorName || '').trim().toLowerCase();
        if (rowOwner !== '' && rowOwner !== self) {
          return { success: false, error: 'You can only edit your own rows.' };
        }
      }
    }

    // Build updated row, preserving cells this role may not overwrite
    var updatedRow = existing.slice();

    for (var k = 0; k < ALL_COLUMNS.length; k++) {
      var key = ALL_COLUMNS[k];
      if (!(key in rowData)) continue;

      var idx = colIndexMap[key];
      if (idx === undefined) continue;

      // Coordinator: cannot write invoicing columns.
      // coordinator_name IS allowed — it was auto-stamped above and must be persisted.
      if (role === 'coordinator' && COORDINATOR_STRIPPED_KEYS[key] && key !== 'coordinator_name') continue;

      // Invoicing: coordinator_name is read-only
      if (role === 'invoicing' && key === 'coordinator_name') continue;

      updatedRow[idx] = rowData[key];
    }

    sheetRange.setValues([updatedRow]);
    return { success: true, rowIndex: rowIndex, serverTime: nowMs };

  } else {
    // ── Append new row ───────────────────────────────────────

    var newRow = new Array(headerRow.length).fill('');

    for (var k = 0; k < ALL_COLUMNS.length; k++) {
      var key = ALL_COLUMNS[k];
      if (!(key in rowData)) continue;

      var idx = colIndexMap[key];
      if (idx === undefined) continue;

      if (role === 'coordinator' && COORDINATOR_STRIPPED_KEYS[key] && key !== 'coordinator_name') continue;
      if (role === 'invoicing'   && key === 'coordinator_name')      continue;

      newRow[idx] = rowData[key];
    }

    dataSheet.appendRow(newRow);
    var newRowIndex = dataSheet.getLastRow();
    return { success: true, rowIndex: newRowIndex, serverTime: nowMs };
  }
}


// ── Batch write ───────────────────────────────────────────────
//
// Writes an array of rows in a single Apps Script execution.
// Each row goes through the full writeRow validation (lock checks,
// JC uniqueness, coordinator ownership).
//
// Returns { success: true, results: [ { index, success, rowIndex, error } ] }
// Execution continues even when individual rows fail — the caller
// checks results for per-row failures.
//
// Batches are sent from the client in groups of 50 to stay within
// the 30-second Apps Script execution limit.

function writeBatch(rowsData, role, coordinatorName) {
  if (!rowsData || !rowsData.length) {
    return { success: false, error: 'No rows provided to writeBatch.' };
  }

  var results = [];
  for (var i = 0; i < rowsData.length; i++) {
    var result = writeRow(rowsData[i], role, coordinatorName);
    results.push({
      index:    i,
      success:  result.success,
      rowIndex: result.rowIndex || null,
      error:    result.error   || null
    });
  }

  return { success: true, results: results };
}


// ── Config tab — price data + dropdowns ───────────────────────
//
// Price data (versions + price list) is parsed by _parsePriceData(),
// which scans the ENTIRE sheet for the "N-Price Versions" table format —
// tables can be at any column, not just column A.
//
// Price table format (as shown in Config tab — no changes needed):
//
//   ┌──────────────────────────┐
//   │ 3-Price Versions         │  ← section title (any column)
//   │ Version  │ Effective From│  ← header row
//   │ 2025     │ 1-Apr-2025    │
//   │ 2026     │               │  ← no date yet: ignored for version resolution
//   └──────────────────────────┘
//
//   ┌──────────────────────────┬────────────┬────────────┐
//   │ 3-Price Versions         │            │            │
//   │ Line Item   │ 2025 Price │ 2026 Price │            │
//   │ RF01 - ...  │ 28750      │            │            │
//   │ TX01 - ...  │ 10250      │ 11000      │            │
//   └─────────────┴────────────┴────────────┘
//   Versions are COLUMNS ("2025 Price" → version "2025").
//
// Row-based col-A sections (add anywhere in column A):
//
//   [CONTRACTOR_SPLITS]
//   Contractor | LMP_Pct | Contractor_Pct
//   In-House   | 100     | 0
//
//   [DISTANCE_MULTIPLIERS]
//   Distance        | Multiplier
//   0Km - 100Km     | 1
//   > 800Km         | 1.25
//
//   2-Dropdown Lists  (or [DROPDOWNS])
//   TX/RF  | Vendor | Region | ...   ← field display names as column headers
//   TX     | Nokia  | Delta  | ...   ← options, one per cell per column

function getConfigData() {
  var ss     = SpreadsheetApp.getActiveSpreadsheet();
  var config = ss.getSheetByName(SHEET_CONFIG);
  if (!config) {
    return { success: true, versions: [], priceList: [], contractorSplits: [],
             distanceMultipliers: [], dropdowns: {} };
  }

  var data = config.getDataRange().getValues();

  // ── Pass 1: Price versions + price list ───────────────────
  // Scans entire sheet for "N-Price Versions" tables at any column.
  var priceResult = _parsePriceData(data);

  // ── Pass 2: Contractor splits, distance multipliers, dropdowns ──
  // Scans ALL cells in each row for section markers (not just col A).
  // Needed because the Config tab may have these sections at any column
  // (e.g. "4-Contractor Split Percentages" at column O on the same rows
  //  as the price version tables in columns J-M).
  var contractorSplits    = [];
  var distanceMultipliers = [];
  var dropdowns           = {};

  var section       = null;
  var sectionCol    = 0;     // column where section header was found
  var sectionEndCol = 0;     // rightmost column used by this section (for blank detection)
  var headerSeen    = false;
  var colMap        = {};

  for (var i = 0; i < data.length; i++) {

    // ── Scan ALL cells in this row for a section title ────────
    var newSectionFound = false;
    for (var sc = 0; sc < data[i].length; sc++) {
      var cell = String(data[i][sc]).trim();
      if (!cell) continue;

      var detected = null;
      if      (cell === '[CONTRACTOR_SPLITS]'    || /contractor.?split/i.test(cell))  detected = '[CONTRACTOR_SPLITS]';
      else if (cell === '[DISTANCE_MULTIPLIERS]' || /distance.?mult/i.test(cell))     detected = '[DISTANCE_MULTIPLIERS]';
      else if (cell === '[DROPDOWNS]'            || /^\d+-dropdown/i.test(cell)
                                                 || cell.toLowerCase() === 'dropdowns'
                                                 || /\bdropdown\s+list/i.test(cell))  detected = '[DROPDOWNS]';

      if (detected) {
        section       = detected;
        sectionCol    = sc;
        sectionEndCol = sc;
        headerSeen    = false;
        colMap        = {};
        newSectionFound = true;
        break;
      }
    }
    if (newSectionFound) continue;

    if (!section) continue;

    // ── [DROPDOWNS] — columnar: header row = field display names ──
    if (section === '[DROPDOWNS]') {
      if (!headerSeen) {
        headerSeen = true;
        for (var d = sectionCol; d < data[i].length; d++) {
          var dlabel = String(data[i][d]).trim();
          if (!dlabel) continue; // skip empty cells within header row
          var fk = dlabel.toLowerCase()
            .replace(/[\s\/]+/g, '_').replace(/[^a-z0-9_]/g, '');
          if (fk) {
            colMap[d] = fk;
            sectionEndCol = d;
            if (!dropdowns[fk]) dropdowns[fk] = [];
          }
        }
      } else {
        // End dropdown section when the entire section column range is blank
        var ddBlank = true;
        for (var db = sectionCol; db <= sectionEndCol; db++) {
          if (data[i][db] !== '' && data[i][db] !== null) { ddBlank = false; break; }
        }
        if (ddBlank) { section = null; continue; }

        for (var d = sectionCol; d <= sectionEndCol; d++) {
          if (colMap[d] === undefined) continue;
          var opt = String(data[i][d]).trim();
          if (opt) dropdowns[colMap[d]].push(opt);
        }
      }
      continue;
    }

    // ── [CONTRACTOR_SPLITS] and [DISTANCE_MULTIPLIERS] ────────
    if (!headerSeen) {
      headerSeen = true;
      // Scan headers from sectionCol only, stopping at the first empty cell.
      // This prevents picking up column headers from adjacent tables in the same row.
      for (var h = sectionCol; h < data[i].length; h++) {
        var hdrVal = String(data[i][h]).trim();
        if (!hdrVal && h > sectionCol) break; // first empty after start = table boundary
        var hdrKey = hdrVal.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        if (hdrKey) {
          colMap[hdrKey] = h;
          sectionEndCol  = h;
        }
      }
      continue;
    }

    // End section when all cells in the section's column range are blank
    var secBlank = true;
    for (var bc = sectionCol; bc <= sectionEndCol; bc++) {
      if (data[i][bc] !== '' && data[i][bc] !== null) { secBlank = false; break; }
    }
    if (secBlank) { section = null; continue; }

    var row = data[i];

    if (section === '[CONTRACTOR_SPLITS]') {
      var cConIdx = colMap['contractor'] !== undefined ? colMap['contractor'] : sectionCol;
      // Accept "lmp_%", "lmp_pct", "lmp" as the LMP column header
      var cLmpIdx = colMap['lmp_']      !== undefined ? colMap['lmp_']
                  : colMap['lmp_pct']   !== undefined ? colMap['lmp_pct']
                  : colMap['lmp']       !== undefined ? colMap['lmp']      : sectionCol + 1;
      // Accept "contractor_%", "contractor_pct" as the contractor % header
      var cPctIdx = colMap['contractor_']   !== undefined ? colMap['contractor_']
                  : colMap['contractor_pct']!== undefined ? colMap['contractor_pct'] : sectionCol + 2;

      var cName   = String(row[cConIdx] || '').trim();
      var cLmp    = Number(row[cLmpIdx]) || 0;
      var cConPct = Number(row[cPctIdx]) || 0;

      // Normalise: if values look like decimals (e.g. 0.3 instead of 30),
      // convert to whole-number percentages (Google Sheets % format stores 30% as 0.3).
      if ((cLmp > 0 && cLmp <= 1) || (cConPct > 0 && cConPct <= 1)) {
        cLmp    = Math.round(cLmp    * 100);
        cConPct = Math.round(cConPct * 100);
      }

      if (cName) contractorSplits.push({ contractor: cName, lmpPct: cLmp, contractorPct: cConPct });

    } else if (section === '[DISTANCE_MULTIPLIERS]') {
      var distIdx = colMap['distance']   !== undefined ? colMap['distance']
                  : colMap['range']      !== undefined ? colMap['range']      : sectionCol;
      var multIdx = colMap['multiplier'] !== undefined ? colMap['multiplier']
                  : colMap['factor']     !== undefined ? colMap['factor']     : sectionCol + 1;
      var dRange  = String(row[distIdx] || '').trim();
      var dMult   = Number(row[multIdx]) || 0;
      if (dRange && dMult) distanceMultipliers.push({ range: dRange, multiplier: dMult });
    }
  }

  return {
    success:             true,
    versions:            priceResult.versions,
    priceList:           priceResult.priceList,
    contractorSplits:    contractorSplits,
    distanceMultipliers: distanceMultipliers,
    dropdowns:           dropdowns
  };
}


// ── _parsePriceData — scans entire sheet for price tables ─────
//
// Finds all tables whose section header matches "N-Price Versions"
// (e.g. "3-Price Versions"). Two table types auto-detected by header:
//
//   Type 1 — first header cell starts with "Version":
//     → parsed as version table (version name + effective date)
//
//   Type 2 — first header cell contains "Line Item":
//     → parsed as price list (line item rows × version columns)
//     → version name extracted from column header: "2025 Price" → "2025"
//
// Version 2026 with no effective date is silently skipped — it becomes
// active automatically once the Manager adds its effective date.

function _parsePriceData(data) {
  var versions    = [];
  var priceList   = [];

  var state       = null;   // null | 'finding_header' | 'versions' | 'pricelist'
  var sectionCol  = 0;      // column where current section starts
  var colMap      = {};     // versions table: header_key → absolute col index
  var versionCols = {};     // price list: absolute col index → version name

  for (var i = 0; i < data.length; i++) {

    // ── Scan entire row for a price section title ─────────────
    // Matches "3-Price Versions", "1-Price Version", etc.
    var foundCol = -1;
    for (var c = 0; c < data[i].length; c++) {
      var cell = String(data[i][c]).trim();
      if (cell && /^\d+-price\s+versions?$/i.test(cell)) {
        foundCol = c;
        break;
      }
    }

    if (foundCol !== -1) {
      state       = 'finding_header';
      sectionCol  = foundCol;
      colMap      = {};
      versionCols = {};
      continue;
    }

    if (!state) continue;

    // ── Read the header row to determine table type ───────────
    if (state === 'finding_header') {
      var firstHdr = String(data[i][sectionCol] || '').trim();

      if (/^version/i.test(firstHdr)) {
        // Version table — scan headers from sectionCol and STOP at the first empty cell.
        // Without this stop, headers from adjacent tables on the same row (e.g. a
        // contractor splits table) would bleed into colMap and corrupt the effectiveDate
        // lookup (overwriting colMap['effective_from'] with the wrong column index).
        state = 'versions';
        for (var h = sectionCol; h < data[i].length; h++) {
          var hdrVal = String(data[i][h]).trim();
          if (!hdrVal && h > sectionCol) break; // first empty after start = table boundary
          var hdr = hdrVal.toLowerCase().replace(/[\s\/]+/g, '_').replace(/[^a-z0-9_]/g, '');
          if (hdr) colMap[hdr] = h;
        }

      } else if (/line.?item/i.test(firstHdr)) {
        // Price list table — versions are columns
        state = 'pricelist';
        for (var h = sectionCol + 1; h < data[i].length; h++) {
          var hdr = String(data[i][h] || '').trim();
          if (!hdr) continue;
          // "2025 Price" → "2025",  "2026" → "2026"
          var vm = hdr.match(/^(\S+)/);
          if (vm) versionCols[h] = vm[1];
        }

      } else {
        state = null; // unrecognized header
      }
      continue;
    }

    // ── Parse data rows ───────────────────────────────────────

    if (state === 'versions') {
      var ver = String(data[i][sectionCol] || '').trim();
      if (!ver) continue; // blank version name — skip row

      // "Effective From" or "Effective_Date" — whichever header was found
      var effIdx = colMap['effective_from'] !== undefined ? colMap['effective_from']
                 : colMap['effective_date'] !== undefined ? colMap['effective_date']
                 : sectionCol + 1;
      var effDate = data[i][effIdx];
      if (effDate) {
        // Only add versions that have an effective date set.
        // Undated future versions are skipped until the date is entered.
        versions.push({ version: ver, effectiveDate: formatCell(effDate) });
      }

    } else if (state === 'pricelist') {
      var lineItem = String(data[i][sectionCol] || '').trim();
      if (!lineItem) continue; // blank line item — skip row

      for (var col in versionCols) {
        var price = Number(data[i][col]) || 0;
        if (price > 0) {
          priceList.push({
            version:   versionCols[col],
            lineItem:  lineItem,
            unitPrice: price
          });
        }
      }
    }
  }

  return { versions: versions, priceList: priceList };
}


// ── JSON response helper ──────────────────────────────────────

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ============================================================
// Manual test helpers
// Run these directly in the Apps Script editor to verify setup.
// Replace names/codes with real values from your Config tab.
// ============================================================

function testPing() {
  var result = handleRequest({ parameter: {} });
  Logger.log(result.getContent());
}

function testAuthValid() {
  var result = authenticate('Alice', 'abc123');
  Logger.log(JSON.stringify(result));
  // Expected: { success: true, name: 'Alice', role: 'coordinator', ... }
}

function testAuthInvalid() {
  var result = authenticate('Alice', 'wrongcode');
  Logger.log(JSON.stringify(result));
  // Expected: { success: false, error: 'Invalid name or access code.' }
}

function testGetRowsAsCoordinator() {
  var result = getRows('coordinator', 'Alice');
  Logger.log('Row count : ' + result.rows.length);
  Logger.log('Col count : ' + result.columns.length + '  (expect 25)');
  Logger.log('Columns   : ' + JSON.stringify(result.columns));
  // Verify: row_num, coordinator_name, acceptance_status etc must NOT appear
}

// ── Diagnostic: verify coordinator_name is written correctly ──
// Run this directly in the Apps Script editor.
// Replace 'Alice' / 'abc123' with a real coordinator name + code from Config tab.
// Then check the Data tab — the new row should have the coordinator name filled in.
function testWriteRowAsCoordinator() {
  // Step 1: Authenticate to get the real coordinatorName from Config
  var authResult = authenticate('Alice', 'abc123');
  Logger.log('Auth result: ' + JSON.stringify(authResult));
  if (!authResult.success) {
    Logger.log('AUTH FAILED — check name/code in Config tab');
    return;
  }

  // Step 2: Simulate what the client sends (coordinator never sends coordinator_name)
  var fakeRowData = {
    job_code: 'TEST-DEBUG',
    tx_rf:    'TX',
    vendor:   'Test Vendor',
    task_name: 'Debug write test'
    // _row_index intentionally absent → triggers append path
    // coordinator_name intentionally absent — server must auto-stamp it
  };

  Logger.log('rowData BEFORE writeRow: ' + JSON.stringify(fakeRowData));

  // Step 3: Call writeRow exactly as the server would
  var writeResult = writeRow(fakeRowData, 'coordinator', authResult.name);
  Logger.log('writeRow result: ' + JSON.stringify(writeResult));

  // Step 4: Read back that row and check coordinator_name
  if (writeResult.success && writeResult.rowIndex) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var dataSheet = ss.getSheetByName(SHEET_DATA);
    var headers = dataSheet.getRange(1, 1, 1, dataSheet.getLastColumn()).getValues()[0];
    var row = dataSheet.getRange(writeResult.rowIndex, 1, 1, dataSheet.getLastColumn()).getValues()[0];
    var obj = {};
    for (var i = 0; i < headers.length; i++) {
      obj[headers[i]] = row[i];
    }
    Logger.log('coordinator_name in sheet: "' + obj['coordinator_name'] + '"');
    Logger.log('PASS: ' + (obj['coordinator_name'] === authResult.name
      ? 'coordinator_name was written correctly'
      : 'FAIL — coordinator_name is empty or wrong. Expected: "' + authResult.name + '"'));
  }
}

function testGetRowsAsInvoicing() {
  var result = getRows('invoicing', 'Bob');
  Logger.log('Row count : ' + result.rows.length);
  Logger.log('Col count : ' + result.columns.length + '  (expect 42)');
}

function testGetRowsAsManager() {
  var result = getRows('manager', 'Carol');
  Logger.log('Row count : ' + result.rows.length);
  Logger.log('Col count : ' + result.columns.length + '  (expect 42)');
}

function testGetConfig() {
  var result = getConfigData();
  Logger.log('success              : ' + result.success);
  Logger.log('versions             : ' + result.versions.length);
  Logger.log('priceList entries    : ' + result.priceList.length);
  Logger.log('contractorSplits     : ' + result.contractorSplits.length);
  Logger.log('distanceMultipliers  : ' + result.distanceMultipliers.length);
  Logger.log('--- versions ---');
  result.versions.forEach(function (v) {
    Logger.log('  ' + v.version + '  effective: ' + v.effectiveDate);
  });
  Logger.log('--- priceList sample (first 5) ---');
  result.priceList.slice(0, 5).forEach(function (p) {
    Logger.log('  [' + p.version + '] ' + p.lineItem + '  →  ' + p.unitPrice);
  });
  Logger.log('--- dropdown fields ---');
  Object.keys(result.dropdowns).forEach(function (key) {
    Logger.log('  ' + key + ': ' + result.dropdowns[key].length + ' options → ' +
      result.dropdowns[key].slice(0, 3).join(', '));
  });
}
