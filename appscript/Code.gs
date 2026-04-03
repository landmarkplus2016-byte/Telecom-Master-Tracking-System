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
// 43 columns total:
//   indices  0–25  → 26 coordinator-visible columns
//   index    26    → coordinator_name (ownership column)
//   indices 27–42  → 16 invoicing-only columns
//
// These keys are used as the header row in the Data tab.
// Display labels for the grid are defined in js/grid.js.

var ALL_COLUMNS = [
  // ── Coordinator columns (0–25) ──
  'id',                 //  0  ID# (auto-generated)
  'logical_site_id',    //  1  Logical Site ID
  'site_name',          //  2  Site Name
  'region',             //  3  Region
  'job_code',           //  4  Job Code (JC)
  'job_type',           //  5  Job Type
  'vendor',             //  6  Vendor
  'contractor',         //  7  Contractor
  'task_date',          //  8  Task Date (drives price version)
  'task_description',   //  9  Task Description
  'scope_of_work',      // 10  Scope of Work
  'actual_quantity',    // 11  Actual Quantity
  'unit',               // 12  Unit
  'new_price',          // 13  New Price (version-driven)
  'new_total_price',    // 14  New Total Price (auto-calc)
  'lmp_portion',        // 15  LMP Portion (auto-calc)
  'contractor_portion', // 16  Contractor Portion (auto-calc)
  'po_status',          // 17  PO Status
  'tsr_sub',            // 18  TSR Sub#
  'notes',              // 19  Notes
  'created_date',       // 20  Created Date
  'last_modified',      // 21  Last Modified (delta sync anchor)
  'work_order',         // 22  Work Order #
  'priority',           // 23  Priority
  'status',             // 24  Status
  'comments',           // 25  Comments

  // ── Ownership column (26) ──
  'coordinator_name',   // 26  Coordinator (hidden from coordinator role)

  // ── Invoicing columns (27–42) ──
  'invoice_number',     // 27  Invoice #
  'invoice_date',       // 28  Invoice Date
  'invoice_amount',     // 29  Invoice Amount
  'invoice_status',     // 30  Invoice Status
  'acceptance_status',  // 31  Acceptance Status ← lock trigger
  'acceptance_date',    // 32  Acceptance Date
  'acceptance_notes',   // 33  Acceptance Notes
  'po_number',          // 34  PO Number
  'po_date',            // 35  PO Date
  'payment_status',     // 36  Payment Status
  'payment_date',       // 37  Payment Date
  'payment_amount',     // 38  Payment Amount
  'billing_code',       // 39  Billing Code
  'gl_code',            // 40  GL Code
  'cost_center',        // 41  Cost Center
  'finance_notes'       // 42  Finance Notes
];

// Keys visible to coordinator role (indices 0–25 only)
var COORDINATOR_VISIBLE_KEYS = ALL_COLUMNS.slice(0, 26);

// Keys stripped from coordinator responses: coordinator_name + all invoicing columns
// Built as a plain object for fast key lookup (no Set required)
var COORDINATOR_STRIPPED_KEYS = (function () {
  var stripped = {};
  var hidden = ALL_COLUMNS.slice(26); // indices 26–42
  for (var i = 0; i < hidden.length; i++) {
    stripped[hidden[i]] = true;
  }
  return stripped;
}());


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
        return jsonResponse(getRows(authResult.role, authResult.name));

      case 'writeRow':
        return jsonResponse(writeRow(params.row, authResult.role, authResult.name));

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

function getRows(role, coordinatorName) {
  var ss        = SpreadsheetApp.getActiveSpreadsheet();
  var dataSheet = ss.getSheetByName(SHEET_DATA);

  if (!dataSheet) {
    return {
      success:   true,
      rows:      [],
      columns:   getVisibleColumns(role),
      timestamp: new Date().toISOString()
    };
  }

  var values = dataSheet.getDataRange().getValues();

  // Sheet is empty or header-only with no data rows
  if (values.length < 2) {
    return {
      success:   true,
      rows:      [],
      columns:   getVisibleColumns(role),
      timestamp: new Date().toISOString()
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

    // ── Role-based row and column filtering ───────────────────

    if (role === 'coordinator') {
      // Only rows owned by this coordinator
      var owner = String(rowObj.coordinator_name || '').trim().toLowerCase();
      var self  = String(coordinatorName || '').trim().toLowerCase();
      if (owner !== self) continue;

      // Strip coordinator_name + all invoicing columns from response
      for (var stripped in COORDINATOR_STRIPPED_KEYS) {
        delete rowObj[stripped];
      }
    }

    // Invoicing and Manager receive all rows and all columns.
    // Invoicing read-only on coordinator_name is enforced in writeRow.

    rows.push(rowObj);
  }

  return {
    success:   true,
    rows:      rows,
    columns:   getVisibleColumns(role),
    timestamp: new Date().toISOString()
  };
}

function getVisibleColumns(role) {
  return (role === 'coordinator') ? COORDINATOR_VISIBLE_KEYS : ALL_COLUMNS;
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

function formatCell(value) {
  if (value instanceof Date) return value.toISOString();
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

  var now = new Date().toISOString();

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

  // Always refresh last_modified
  rowData.last_modified = now;

  // ── Ensure Data tab has a header row ──
  var allValues = dataSheet.getDataRange().getValues();
  var headerRow = (allValues.length > 0)
    ? allValues[0].map(function (h) { return String(h).trim(); })
    : [];

  if (headerRow.length === 0 || headerRow[0] === '') {
    dataSheet.appendRow(ALL_COLUMNS);
    allValues = dataSheet.getDataRange().getValues();
    headerRow = allValues[0].map(function (h) { return String(h).trim(); });
  }

  var colIndexMap = buildColumnIndexMap(headerRow);
  var rowIndex    = rowData._row_index; // 1-based sheet row; absent for new rows

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

      // Coordinator: cannot write coordinator_name or any invoicing column
      if (role === 'coordinator' && COORDINATOR_STRIPPED_KEYS[key]) continue;

      // Invoicing: coordinator_name is read-only
      if (role === 'invoicing' && key === 'coordinator_name') continue;

      updatedRow[idx] = rowData[key];
    }

    sheetRange.setValues([updatedRow]);
    return { success: true, rowIndex: rowIndex, timestamp: now };

  } else {
    // ── Append new row ───────────────────────────────────────

    var newRow = new Array(headerRow.length).fill('');

    for (var k = 0; k < ALL_COLUMNS.length; k++) {
      var key = ALL_COLUMNS[k];
      if (!(key in rowData)) continue;

      var idx = colIndexMap[key];
      if (idx === undefined) continue;

      if (role === 'coordinator' && COORDINATOR_STRIPPED_KEYS[key]) continue;
      if (role === 'invoicing'   && key === 'coordinator_name')      continue;

      newRow[idx] = rowData[key];
    }

    dataSheet.appendRow(newRow);
    var newRowIndex = dataSheet.getLastRow();
    return { success: true, rowIndex: newRowIndex, timestamp: now };
  }
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
  Logger.log('Col count : ' + result.columns.length + '  (expect 26)');
  Logger.log('Columns   : ' + JSON.stringify(result.columns));
  // Verify: coordinator_name, invoice_*, acceptance_* must NOT appear in columns
}

function testGetRowsAsInvoicing() {
  var result = getRows('invoicing', 'Bob');
  Logger.log('Row count : ' + result.rows.length);
  Logger.log('Col count : ' + result.columns.length + '  (expect 43)');
}

function testGetRowsAsManager() {
  var result = getRows('manager', 'Carol');
  Logger.log('Row count : ' + result.rows.length);
  Logger.log('Col count : ' + result.columns.length + '  (expect 43)');
}
