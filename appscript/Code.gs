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
  'cash_received_date'          // 42  Cash Received Date
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

// Keys visible to invoicing + manager: all except row_num
var INVOICING_MANAGER_VISIBLE_KEYS = ALL_COLUMNS.filter(function (k) {
  return k !== 'row_num';
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
  Logger.log('Col count : ' + result.columns.length + '  (expect 25)');
  Logger.log('Columns   : ' + JSON.stringify(result.columns));
  // Verify: row_num, coordinator_name, acceptance_status etc must NOT appear
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
