// ============================================================
// grid.js — Handsontable init and ALL column definitions
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Define all 43 columns (key, label, width, type)
//   - Filter visible columns by role
//   - Init and render the Handsontable instance
//   - Handle row saves on cell edit (calls Sheets.writeRow)
//   - Update status bar row count
//   - Expose Grid.init(role, name) and Grid.loadData(rows)
//
// No business logic here:
//   - No price calculations  → js/pricing.js (Stage 2)
//   - No row locking         → js/grid.js update (Stage 2)
//   - No JC validation       → js/grid.js update (Stage 2)
//   - No delta sync          → js/offline.js (Stage 3)
//   - No filters             → js/filters.js (Stage 4)
// ============================================================

var Grid = (function () {

  // ── Column master list ────────────────────────────────────
  // Single source of truth for display labels and widths.
  // Keys match Code.gs ALL_COLUMNS exactly.
  // role: which roles can SEE this column (all = everyone)
  // readOnly: array of roles for which the column is read-only

  // row_num is intentionally absent — it lives in the sheet only,
  // never rendered in the grid for any role.
  var COLUMNS = [
    // ── Coordinator columns (visible to all roles) ─────────
    { key: 'id',                         label: 'ID #',                      width: 180, type: 'text',    readOnly: ['coordinator', 'invoicing', 'manager'] },
    { key: 'job_code',                   label: 'Job Code',                  width: 120, type: 'text'    },
    { key: 'tx_rf',                      label: 'TX/RF',                     width:  80, type: 'text'    },
    { key: 'vendor',                     label: 'Vendor',                    width: 130, type: 'text'    },
    { key: 'physical_site_id',           label: 'Physical Site ID',          width: 130, type: 'text'    },
    { key: 'logical_site_id',            label: 'Logical Site ID',           width: 130, type: 'text'    },
    { key: 'site_option',                label: 'Site Option',               width: 100, type: 'text'    },
    { key: 'facing',                     label: 'Facing',                    width:  90, type: 'text'    },
    { key: 'region',                     label: 'Region',                    width: 100, type: 'text'    },
    { key: 'sub_region',                 label: 'Sub Region',                width: 110, type: 'text'    },
    { key: 'distance',                   label: 'Distance',                  width:  90, type: 'numeric' },
    { key: 'absolute_quantity',          label: 'Absolute Quantity',         width: 130, type: 'numeric' },
    { key: 'actual_quantity',            label: 'Actual Quantity',           width: 120, type: 'numeric' },
    { key: 'general_stream',             label: 'General Stream',            width: 130, type: 'text'    },
    { key: 'task_name',                  label: 'Task Name',                 width: 200, type: 'text'    },
    { key: 'contractor',                 label: 'Contractor',                width: 130, type: 'text'    },
    { key: 'engineer_name',              label: "Engineer's Name",           width: 140, type: 'text'    },
    { key: 'line_item',                  label: 'Line Item',                 width: 110, type: 'text'    },
    { key: 'new_price',                  label: 'New Price',                 width: 110, type: 'numeric', numericFormat: { pattern: '$0,0.00' } },
    { key: 'new_total_price',            label: 'New Total Price',           width: 130, type: 'numeric', numericFormat: { pattern: '$0,0.00' }, readOnly: ['coordinator', 'invoicing', 'manager'] },
    { key: 'comments',                   label: 'Comments',                  width: 200, type: 'text'    },
    { key: 'status',                     label: 'Status',                    width: 110, type: 'text'    },
    { key: 'task_date',                  label: 'Task Date',                 width: 110, type: 'date',   dateFormat: 'DD-MMM-YYYY' },
    { key: 'vf_task_owner',              label: 'VF Task Owner',             width: 130, type: 'text'    },
    { key: 'prq',                        label: 'PRQ',                       width:  90, type: 'text'    },

    // ── Ownership column — role-gated ─────────────────────
    { key: 'coordinator_name',           label: 'Coordinator',               width: 130, type: 'text',
      roles:    ['invoicing', 'manager'],   // coordinator never sees this column
      readOnly: ['invoicing']               // invoicing can see but not edit
    },

    // ── Invoicing columns — invoicing + manager only ───────
    { key: 'acceptance_status',          label: 'Acceptance Status',         width: 145, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'fac_date',                   label: 'FAC Date',                  width: 110, type: 'date',   dateFormat: 'DD-MMM-YYYY', roles: ['invoicing', 'manager'] },
    { key: 'certificate_num',            label: 'Certificate #',             width: 120, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'acceptance_week',            label: 'Acceptance Week',           width: 135, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'tsr_sub',                    label: 'TSR Sub#',                  width: 100, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'po_status',                  label: 'PO Status',                 width: 110, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'po_number',                  label: 'PO Number',                 width: 115, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'vf_invoice_num',             label: 'VF Invoice #',              width: 120, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'first_receiving_date',       label: '1st Receiving Date',        width: 145, type: 'date',   dateFormat: 'DD-MMM-YYYY', roles: ['invoicing', 'manager'] },
    { key: 'lmp_portion',                label: 'LMP Portion',               width: 115, type: 'numeric', numericFormat: { pattern: '$0,0.00' }, readOnly: ['coordinator', 'invoicing', 'manager'], roles: ['invoicing', 'manager'] },
    { key: 'contractor_portion',         label: 'Contractor Portion',        width: 145, type: 'numeric', numericFormat: { pattern: '$0,0.00' }, readOnly: ['coordinator', 'invoicing', 'manager'], roles: ['invoicing', 'manager'] },
    { key: 'sent_to_cost_control',       label: 'Sent to Cost Control',      width: 155, type: 'date',   dateFormat: 'DD-MMM-YYYY', correctFormat: true, roles: ['invoicing', 'manager'] },
    { key: 'received_from_cc',           label: 'Received from CC',          width: 145, type: 'date',   dateFormat: 'DD-MMM-YYYY', correctFormat: true, roles: ['invoicing', 'manager'] },
    { key: 'contractor_invoice_num',     label: 'Contractor Invoice #',      width: 155, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'vf_invoice_submission_date', label: 'VF Invoice Submission Date',width: 200, type: 'date',   dateFormat: 'DD-MMM-YYYY', roles: ['invoicing', 'manager'] },
    { key: 'cash_received_date',         label: 'Cash Received Date',        width: 155, type: 'date',   dateFormat: 'DD-MMM-YYYY', roles: ['invoicing', 'manager'] },
  ];

  // ── Internal state ────────────────────────────────────────

  var _hot       = null;   // Handsontable instance
  var _role      = null;
  var _userName  = null;
  var _visibleCols = [];   // filtered COLUMNS for current role
  var _data      = [];     // current grid data (array of row objects)
  var _savePending = {};   // rowIdx → setTimeout handle (debounce per row)

  // ── Public API ────────────────────────────────────────────

  /**
   * Initialise the grid for a given role.
   * Called by app.js after login. Does NOT fetch data —
   * app.js calls Sheets.fetchAllRows then Grid.loadData().
   */
  function init(role, userName) {
    console.log('[grid.js] init() — role:', role);
    _role     = role;
    _userName = userName;
    _visibleCols = _getVisibleColumns(role);

    _renderToolbar(role);
    _initHot();
    _fitContainer();
    _updateRowCount(0);

    window.addEventListener('resize', _fitContainer);
  }

  /**
   * Load rows into the grid.
   * rows: array of row objects keyed by column key.
   */
  function loadData(rows) {
    console.log('[grid.js] loadData() — rows:', rows.length);
    _data = rows || [];

    // Normalize all date column values to DD-MMM-YYYY before HOT sees them.
    // HOT's correctFormat only fires on user edits, not on loadData, so raw
    // ISO strings (e.g. "2026-04-12T22:00:00.000Z") would display unformatted.
    var dateKeys = {};
    _visibleCols.forEach(function (col) {
      if (col.type === 'date') dateKeys[col.key] = true;
    });
    _data.forEach(function (row) {
      Object.keys(dateKeys).forEach(function (key) {
        if (row[key]) row[key] = _normalizeDate(row[key]);
      });
    });

    if (!_hot) return;

    // HOT columns are configured with data:'key' — pass objects directly.
    // Converting to arrays causes empty cells because HOT uses the key
    // mapping, not array index, when columns[i].data is set.
    _hot.loadData(_data);
    _updateRowCount(_data.length);
  }

  // Convert any date string (YYYY-MM-DD or ISO datetime) to DD-MMM-YYYY.
  // Used only for display normalisation on load — storage format is unchanged.
  function _normalizeDate(val) {
    if (!val) return val;
    var s = String(val).trim();

    // ISO datetime: "2026-04-12T22:00:00.000Z" → strip time, keep date
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
      s = s.slice(0, 10); // gives "YYYY-MM-DD" (UTC date; good enough for display)
    }

    // YYYY-MM-DD → DD-MMM-YYYY
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var mon = months[parseInt(m[2], 10) - 1];
      if (mon) return m[3] + '-' + mon + '-' + m[1];
    }

    return val; // already formatted or unparseable — leave as-is
  }

  // ── Column filtering by role ──────────────────────────────

  function _getVisibleColumns(role) {
    return COLUMNS.filter(function (col) {
      // No roles restriction = visible to everyone
      if (!col.roles) return true;
      return col.roles.indexOf(role) !== -1;
    });
  }

  function _isColReadOnly(col, role) {
    if (!col.readOnly) return false;
    return col.readOnly.indexOf(role) !== -1;
  }

  // ── Toolbar ───────────────────────────────────────────────

  function _renderToolbar(role) {
    var el = document.getElementById('toolbar-actions');
    if (!el) return;

    var buttons = [];

    // Add Row — all roles
    buttons.push('<button class="tb-btn tb-btn--primary" id="tb-add-row">+ New Row</button>');

    // Refresh — all roles (replaced by delta sync in Stage 3)
    buttons.push('<button class="tb-btn" id="tb-refresh">&#8635; Refresh</button>');

    // Export — all roles (Stage 4, wired as stub)
    buttons.push('<button class="tb-btn" id="tb-export">Export</button>');

    // Reconcile — invoicing + manager only
    if (role === 'invoicing' || role === 'manager') {
      buttons.push('<button class="tb-btn" id="tb-reconcile">Reconcile</button>');
    }

    // Manager panel — manager only
    if (role === 'manager') {
      buttons.push('<button class="tb-btn tb-btn--danger" id="tb-manager">&#9881; Manager</button>');
    }

    el.innerHTML = buttons.join('');

    // Add Row handler
    var addBtn = document.getElementById('tb-add-row');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        _hot.alter('insert_row_below', _hot.countRows());
        _hot.selectCell(_hot.countRows() - 1, 0);
      });
    }

    // Refresh handler — re-fetches all rows from Apps Script
    var refreshBtn = document.getElementById('tb-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        _refreshData(refreshBtn);
      });
    }
  }

  // ── Manual data refresh ───────────────────────────────────
  // Fetches all rows fresh from Apps Script and reloads the grid.
  // Replaced by delta sync (last_modified polling) in Stage 3.

  function _refreshData(btn) {
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Refreshing\u2026';
    }
    Sheets.fetchAllRows(function (result) {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '&#8635; Refresh';
      }
      if (!result.success) {
        console.error('[grid.js] refresh failed:', result.error);
        _showSaveError('Refresh failed: ' + result.error);
        return;
      }
      console.log('[grid.js] refresh — rows received:', result.rows.length);
      loadData(result.rows);
    });
  }

  // ── Handsontable init ─────────────────────────────────────

  function _initHot() {
    var container = document.getElementById('grid-container');
    if (!container) {
      console.error('[grid.js] #grid-container not found');
      return;
    }

    var colHeaders = _visibleCols.map(function (c) { return c.label; });
    var columns    = _visibleCols.map(function (col) {
      var cfg = {
        data:     col.key,
        type:     col.type || 'text',
        readOnly: _isColReadOnly(col, _role),
        width:    col.width || 120,
      };
      if (col.numericFormat) cfg.numericFormat = col.numericFormat;
      if (col.type === 'date') {
        cfg.dateFormat         = col.dateFormat || 'YYYY-MM-DD';
        cfg.correctFormat      = true;
      }
      return cfg;
    });

    _hot = new Handsontable(container, {
      data:               [],
      colHeaders:         colHeaders,
      columns:            columns,
      rowHeaders:         true,
      // width/height must be explicit numbers or '100%' — HOT does
      // not honour CSS flex sizing on its own.
      width:              '100%',
      height:             '100%',
      stretchH:           'all',
      manualColumnResize: true,
      manualRowResize:    false,
      columnSorting:      true,
      contextMenu:        _contextMenu(),
      outsideClickDeselects: false,
      selectionMode:      'multiple',
      autoWrapRow:        false,
      autoWrapCol:        false,
      licenseKey:         'non-commercial-and-evaluation',

      // Freeze first 2 columns (ID + Logical Site ID)
      fixedColumnsLeft:   2,

      // After a cell is edited, save the row to Apps Script.
      // Debounced per row — prevents duplicate appends when the user
      // edits multiple cells before the first save callback returns.
      afterChange: function (changes, source) {
        if (!changes || source === 'loadData') return;

        var self     = this; // HOT instance
        var dirtyRows = {};

        changes.forEach(function (change) {
          var rowIdx = change[0];
          var colKey = change[1]; // property name when columns use data:'key'
          dirtyRows[rowIdx] = true;

          // Auto-generate ID when job_code is entered and id is still empty.
          // ID.tryGenerate returns null if conditions aren't met (guards itself).
          if (colKey === 'job_code' && typeof ID !== 'undefined') {
            var sourceRow = self.getSourceDataAtRow(rowIdx) || {};
            var newId     = ID.tryGenerate(sourceRow, rowIdx);
            if (newId) {
              // 'id_autofill' source: afterChange fires again for the id cell,
              // which is fine — the debounce will bundle it with job_code save.
              self.setDataAtRowProp(rowIdx, 'id', newId, 'id_autofill');
            }
          }
        });

        Object.keys(dirtyRows).forEach(function (rowIdx) {
          _scheduleSave(parseInt(rowIdx, 10));
        });
      },

      afterCreateRow: function (index) {
        _updateRowCount(_hot.countRows());
      },

      afterRemoveRow: function () {
        _updateRowCount(_hot.countRows());
      },

      // Visual: mark read-only cells with a subtle class
      cells: function (row, col) {
        var colDef = _visibleCols[col];
        if (!colDef) return {};
        if (_isColReadOnly(colDef, _role)) {
          return { className: 'cell-readonly' };
        }
        return {};
      },
    });
  }

  // ── Container sizing ─────────────────────────────────────
  // HOT requires an explicit pixel height on its mount element.
  // Calculate it from the viewport minus header and status bar.

  function _fitContainer() {
    var container  = document.getElementById('grid-container');
    var header     = document.getElementById('app-header');
    var statusbar  = document.getElementById('app-statusbar');
    if (!container) return;

    var usedHeight = (header    ? header.offsetHeight    : 48)
                   + (statusbar ? statusbar.offsetHeight : 28);
    var h = window.innerHeight - usedHeight;
    container.style.height = h + 'px';

    if (_hot) _hot.render();
  }

  // ── Row save ──────────────────────────────────────────────

  // Debounce saves per row (500 ms).
  // Problem this solves: when a coordinator creates a new row and
  // edits several cells in quick succession, each cell commit fires
  // afterChange before the first writeRow callback returns with
  // _row_index. Without debounce every save hits the "append" path,
  // creating duplicate sheet rows. With debounce, only one save fires
  // after the user pauses, so _row_index is set correctly for all
  // subsequent edits to the same row.
  function _scheduleSave(rowIdx) {
    clearTimeout(_savePending[rowIdx]);
    _savePending[rowIdx] = setTimeout(function () {
      delete _savePending[rowIdx];
      _saveRow(rowIdx);
    }, 500);
  }

  function _saveRow(rowIdx) {
    if (!_hot) return;

    // HOT data source is objects — read directly from the source row.
    // getSourceDataAtRow returns the live object HOT is bound to.
    var sourceRow = _hot.getSourceDataAtRow(rowIdx) || {};

    var rowData = {};
    _visibleCols.forEach(function (col) {
      rowData[col.key] = sourceRow[col.key] !== undefined ? sourceRow[col.key] : '';
    });

    // Attach the sheet row index so Apps Script knows whether
    // this is an update or a new row
    var originalRow = _data[rowIdx];
    if (originalRow && originalRow._row_index) {
      rowData._row_index = originalRow._row_index;
    }

    // Set created_date on new rows
    if (!rowData._row_index && !rowData.created_date) {
      rowData.created_date = new Date().toISOString().slice(0, 10);
    }

    Sheets.writeRow(rowData, function (result) {
      if (!result.success) {
        console.error('[grid.js] writeRow failed:', result.error);
        _showSaveError(result.error);
        return;
      }

      // Update the in-memory _row_index for future edits
      if (!_data[rowIdx]) _data[rowIdx] = {};
      _data[rowIdx]._row_index = result.rowIndex;

      console.log('[grid.js] Row saved — sheet row:', result.rowIndex);
    });
  }

  // ── Context menu ──────────────────────────────────────────

  function _contextMenu() {
    var items = {
      'row_above':  { name: 'Insert row above' },
      'row_below':  { name: 'Insert row below' },
      'separator1': Handsontable.plugins.ContextMenu.SEPARATOR,
      'copy':       {},
      'cut':        {},
    };

    // Delete only for coordinator (own rows) and manager
    if (_role === 'coordinator' || _role === 'manager') {
      items['separator2'] = Handsontable.plugins.ContextMenu.SEPARATOR;
      items['remove_row'] = { name: 'Delete row' };
    }

    return { items: items };
  }

  // ── Status bar ────────────────────────────────────────────

  function _updateRowCount(count) {
    var el = document.getElementById('row-count');
    if (el) el.textContent = count + (count === 1 ? ' row' : ' rows');
  }

  // ── Error toast ───────────────────────────────────────────

  function _showSaveError(msg) {
    var existing = document.getElementById('grid-save-error');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.id = 'grid-save-error';
    toast.textContent = 'Save failed: ' + (msg || 'Unknown error');
    document.body.appendChild(toast);

    setTimeout(function () { toast.remove(); }, 5000);
  }

  // ── Styles ────────────────────────────────────────────────

  (function _injectStyles() {
    if (document.getElementById('grid-styles')) return;
    var s = document.createElement('style');
    s.id = 'grid-styles';
    s.textContent = [

      // ── Toolbar ─────────────────────────────────────────────
      '#toolbar-actions {',
        'display: flex;',
        'align-items: center;',
        'gap: 6px;',
        'margin-left: auto;',          // push to the right of header
        'padding-right: 4px;',
      '}',

      '.tb-btn {',
        'height: 30px;',
        'padding: 0 14px;',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 11px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'background: rgba(255,255,255,0.08);',
        'color: var(--text-on-navy);',
        'border: 1px solid rgba(255,255,255,0.15);',
        'cursor: pointer;',
        'transition: background 0.15s, border-color 0.15s;',
        'white-space: nowrap;',
      '}',

      '.tb-btn:hover {',
        'background: rgba(255,255,255,0.16);',
        'border-color: rgba(255,255,255,0.28);',
      '}',

      '.tb-btn--primary {',
        'background: var(--accent);',
        'color: #fff;',
        'border-color: var(--accent);',
      '}',

      '.tb-btn--primary:hover {',
        'background: var(--accent-bright);',
        'border-color: var(--accent-bright);',
      '}',

      '.tb-btn--danger {',
        'background: rgba(192,57,43,0.15);',
        'border-color: rgba(192,57,43,0.35);',
        'color: #f08070;',
      '}',

      '.tb-btn--danger:hover {',
        'background: rgba(192,57,43,0.28);',
      '}',

      // ── Grid container fills body ────────────────────────────
      // HOT needs an explicit pixel height on the mount div.
      // We set it via JS after render so it always matches the
      // actual available space.
      '#grid-container {',
        'position: relative;',
        'overflow: hidden;',
        // flex:1 alone is not enough for HOT — height is set by _fitContainer()
      '}',

      // ── Cell overrides ───────────────────────────────────────

      // Column headers — navy style
      '.handsontable th {',
        'background: var(--bg-navy) !important;',
        'color: var(--text-on-navy) !important;',
        'font-family: var(--font-display) !important;',
        'font-weight: 600 !important;',
        'font-size: 11px !important;',
        'letter-spacing: 0.08em !important;',
        'text-transform: uppercase !important;',
        'border-color: var(--border-navy) !important;',
        'padding: 0 8px !important;',
        'white-space: nowrap !important;',
      '}',

      // Row number headers
      '.handsontable .rowHeader {',
        'background: #f5f7fa !important;',
        'color: var(--text-secondary) !important;',
        'font-family: var(--font-mono) !important;',
        'font-size: 10px !important;',
        'border-color: var(--border) !important;',
      '}',

      // Data cells
      '.handsontable td {',
        'font-family: var(--font-body) !important;',
        'font-size: 13px !important;',
        'color: var(--text-primary) !important;',
        'border-color: var(--border) !important;',
        'padding: 0 8px !important;',
      '}',

      // Read-only cells — very subtle background tint
      '.handsontable td.cell-readonly {',
        'background: #f8f9fb !important;',
        'color: var(--text-secondary) !important;',
      '}',

      // Selected cell
      '.handsontable td.current {',
        'outline: 2px solid var(--bg-navy) !important;',
        'outline-offset: -2px;',
      '}',

      // Selected range fill
      '.handsontable td.area {',
        'background: rgba(26, 46, 74, 0.06) !important;',
      '}',

      // Sort indicator tweak
      '.handsontable th.ascending::after,',
      '.handsontable th.descending::after {',
        'color: var(--accent) !important;',
      '}',

      // ── Save error toast ──────────────────────────────────────
      '#grid-save-error {',
        'position: fixed;',
        'bottom: 40px;',
        'right: 20px;',
        'background: var(--color-error);',
        'color: #fff;',
        'font-family: var(--font-body);',
        'font-size: 13px;',
        'padding: 10px 18px;',
        'box-shadow: 0 4px 16px rgba(0,0,0,0.2);',
        'z-index: 1000;',
        'max-width: 400px;',
      '}',

    ].join('\n');

    document.head.appendChild(s);
  }());

  // ── Expose ────────────────────────────────────────────────

  return {
    init:     init,
    loadData: loadData,
  };

}());
