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

  var COLUMNS = [
    // ── Coordinator columns (shown to all roles) ───────────
    { key: 'id',                 label: 'ID #',               width: 180, type: 'text',    readOnly: ['coordinator', 'invoicing', 'manager'] },
    { key: 'logical_site_id',    label: 'Logical Site ID',    width: 130, type: 'text'    },
    { key: 'site_name',          label: 'Site Name',          width: 160, type: 'text'    },
    { key: 'region',             label: 'Region',             width: 100, type: 'text'    },
    { key: 'job_code',           label: 'Job Code',           width: 110, type: 'text'    },
    { key: 'job_type',           label: 'Job Type',           width: 120, type: 'text'    },
    { key: 'vendor',             label: 'Vendor',             width: 130, type: 'text'    },
    { key: 'contractor',         label: 'Contractor',         width: 130, type: 'text'    },
    { key: 'task_date',          label: 'Task Date',          width: 110, type: 'date',   dateFormat: 'YYYY-MM-DD' },
    { key: 'task_description',   label: 'Task Description',   width: 200, type: 'text'    },
    { key: 'scope_of_work',      label: 'Scope of Work',      width: 200, type: 'text'    },
    { key: 'actual_quantity',    label: 'Actual Qty',         width:  90, type: 'numeric' },
    { key: 'unit',               label: 'Unit',               width:  80, type: 'text'    },
    { key: 'new_price',          label: 'New Price',          width: 100, type: 'numeric', numericFormat: { pattern: '$0,0.00' } },
    { key: 'new_total_price',    label: 'New Total Price',    width: 120, type: 'numeric', numericFormat: { pattern: '$0,0.00' }, readOnly: ['coordinator', 'invoicing', 'manager'] },
    { key: 'lmp_portion',        label: 'LMP Portion',        width: 110, type: 'numeric', numericFormat: { pattern: '$0,0.00' }, readOnly: ['coordinator', 'invoicing', 'manager'] },
    { key: 'contractor_portion', label: 'Contractor Portion', width: 140, type: 'numeric', numericFormat: { pattern: '$0,0.00' }, readOnly: ['coordinator', 'invoicing', 'manager'] },
    { key: 'po_status',          label: 'PO Status',          width: 110, type: 'text'    },
    { key: 'tsr_sub',            label: 'TSR Sub #',          width: 100, type: 'text'    },
    { key: 'notes',              label: 'Notes',              width: 200, type: 'text'    },
    { key: 'created_date',       label: 'Created Date',       width: 130, type: 'text',   readOnly: ['coordinator', 'invoicing', 'manager'] },
    { key: 'last_modified',      label: 'Last Modified',      width: 145, type: 'text',   readOnly: ['coordinator', 'invoicing', 'manager'] },
    { key: 'work_order',         label: 'Work Order #',       width: 120, type: 'text'    },
    { key: 'priority',           label: 'Priority',           width:  90, type: 'text'    },
    { key: 'status',             label: 'Status',             width: 110, type: 'text'    },
    { key: 'comments',           label: 'Comments',           width: 200, type: 'text'    },

    // ── Ownership column — role-gated ─────────────────────
    // hidden: coordinator, read-only: invoicing, editable: manager
    { key: 'coordinator_name',   label: 'Coordinator',        width: 130, type: 'text',
      roles: ['invoicing', 'manager'],          // coordinator never sees this
      readOnly: ['invoicing']                   // invoicing sees, cannot edit
    },

    // ── Invoicing columns — invoicing + manager only ───────
    { key: 'invoice_number',     label: 'Invoice #',          width: 120, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'invoice_date',       label: 'Invoice Date',       width: 115, type: 'date',   dateFormat: 'YYYY-MM-DD', roles: ['invoicing', 'manager'] },
    { key: 'invoice_amount',     label: 'Invoice Amount',     width: 120, type: 'numeric', numericFormat: { pattern: '$0,0.00' }, roles: ['invoicing', 'manager'] },
    { key: 'invoice_status',     label: 'Invoice Status',     width: 120, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'acceptance_status',  label: 'Acceptance Status',  width: 140, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'acceptance_date',    label: 'Acceptance Date',    width: 130, type: 'date',   dateFormat: 'YYYY-MM-DD', roles: ['invoicing', 'manager'] },
    { key: 'acceptance_notes',   label: 'Acceptance Notes',   width: 160, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'po_number',          label: 'PO Number',          width: 115, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'po_date',            label: 'PO Date',            width: 105, type: 'date',   dateFormat: 'YYYY-MM-DD', roles: ['invoicing', 'manager'] },
    { key: 'payment_status',     label: 'Payment Status',     width: 125, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'payment_date',       label: 'Payment Date',       width: 115, type: 'date',   dateFormat: 'YYYY-MM-DD', roles: ['invoicing', 'manager'] },
    { key: 'payment_amount',     label: 'Payment Amount',     width: 125, type: 'numeric', numericFormat: { pattern: '$0,0.00' }, roles: ['invoicing', 'manager'] },
    { key: 'billing_code',       label: 'Billing Code',       width: 115, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'gl_code',            label: 'GL Code',            width: 100, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'cost_center',        label: 'Cost Center',        width: 110, type: 'text',    roles: ['invoicing', 'manager'] },
    { key: 'finance_notes',      label: 'Finance Notes',      width: 180, type: 'text',    roles: ['invoicing', 'manager'] },
  ];

  // ── Internal state ────────────────────────────────────────

  var _hot       = null;   // Handsontable instance
  var _role      = null;
  var _userName  = null;
  var _visibleCols = [];   // filtered COLUMNS for current role
  var _data      = [];     // current grid data (array of row objects)

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
    _updateRowCount(0);
  }

  /**
   * Load rows into the grid.
   * rows: array of row objects keyed by column key.
   */
  function loadData(rows) {
    console.log('[grid.js] loadData() — rows:', rows.length);
    _data = rows || [];
    if (!_hot) return;

    var tableData = _data.map(function (row) {
      return _visibleCols.map(function (col) {
        return row[col.key] !== undefined ? row[col.key] : '';
      });
    });

    _hot.loadData(tableData);
    _updateRowCount(_data.length);
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
      stretchH:           'last',
      manualColumnResize: true,
      manualRowResize:    false,
      columnSorting:      true,
      sortIndicator:      true,
      contextMenu:        _contextMenu(),
      outsideClickDeselects: false,
      selectionMode:      'multiple',
      autoWrapRow:        false,
      autoWrapCol:        false,
      licenseKey:         'non-commercial-and-evaluation',

      // Freeze first 2 columns (ID + Logical Site ID) so they
      // stay visible when scrolling horizontally
      fixedColumnsLeft: (_role === 'coordinator') ? 2 : 2,

      // After a cell is edited, save the row to Apps Script
      afterChange: function (changes, source) {
        if (!changes || source === 'loadData') return;
        var dirtyRows = {};
        changes.forEach(function (change) {
          dirtyRows[change[0]] = true;
        });
        Object.keys(dirtyRows).forEach(function (rowIdx) {
          _saveRow(parseInt(rowIdx, 10));
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

  // ── Row save ──────────────────────────────────────────────

  function _saveRow(rowIdx) {
    if (!_hot) return;

    var rowData = {};
    _visibleCols.forEach(function (col, colIdx) {
      rowData[col.key] = _hot.getDataAtCell(rowIdx, colIdx);
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
      '#grid-container {',
        'flex: 1;',
        'overflow: hidden;',
        'position: relative;',
      '}',

      // Force HOT to fill container fully
      '#grid-container .handsontable,',
      '#grid-container .wtHolder {',
        'height: 100% !important;',
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
