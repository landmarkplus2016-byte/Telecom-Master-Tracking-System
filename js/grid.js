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
    { key: 'id',                         label: 'ID #',                      width: 180, type: 'text',     readOnly: ['coordinator', 'invoicing', 'manager'] },
    { key: 'job_code',                   label: 'Job Code',                  width: 120, type: 'text'     },
    { key: 'tx_rf',                      label: 'TX/RF',                     width:  80, type: 'dropdown' },
    { key: 'vendor',                     label: 'Vendor',                    width: 130, type: 'dropdown' },
    { key: 'physical_site_id',           label: 'Physical Site ID',          width: 130, type: 'text'     },
    { key: 'logical_site_id',            label: 'Logical Site ID',           width: 130, type: 'text'     },
    { key: 'site_option',                label: 'Site Option',               width: 100, type: 'text'     },
    { key: 'facing',                     label: 'Facing',                    width:  90, type: 'dropdown' },
    { key: 'region',                     label: 'Region',                    width: 100, type: 'dropdown' },
    { key: 'sub_region',                 label: 'Sub Region',                width: 110, type: 'dropdown' },
    { key: 'distance',                   label: 'Distance',                  width: 140, type: 'dropdown' },
    // absolute_quantity = "Quantity" — manually entered by the user
    { key: 'absolute_quantity',          label: 'Quantity',                  width: 110, type: 'numeric'  },
    // actual_quantity = "RC Quantity" — auto-calculated: Quantity × distance multiplier
    { key: 'actual_quantity',            label: 'RC Quantity',               width: 110, type: 'numeric',  numericFormat: { pattern: '0.00' }, readOnly: ['coordinator', 'invoicing'] },
    { key: 'general_stream',             label: 'General Stream',            width: 130, type: 'dropdown' },
    { key: 'task_name',                  label: 'Task Name',                 width: 200, type: 'dropdown' },
    { key: 'contractor',                 label: 'Contractor',                width: 130, type: 'dropdown' },
    { key: 'engineer_name',              label: "Engineer's Name",           width: 140, type: 'text'     },
    { key: 'line_item',                  label: 'Line Item',                 width: 260, type: 'dropdown' },
    { key: 'new_price',                  label: 'New Price',                 width: 110, type: 'numeric',  numericFormat: { pattern: '$0,0.00' }, readOnly: ['coordinator', 'invoicing'] },
    { key: 'new_total_price',            label: 'New Total Price',           width: 130, type: 'numeric',  numericFormat: { pattern: '$0,0.00' }, readOnly: ['coordinator', 'invoicing'] },
    { key: 'comments',                   label: 'Comments',                  width: 200, type: 'text'     },
    { key: 'status',                     label: 'Status',                    width: 110, type: 'dropdown' },
    { key: 'task_date',                  label: 'Task Date',                 width: 110, type: 'date',     dateFormat: 'DD-MMM-YYYY' },
    // ── Pricing indicator — computed client-side, never saved to sheet ──
    { key: '_price_indicator',           label: '●',                         width:  42, type: 'text',     readOnly: ['coordinator', 'invoicing', 'manager'] },
    { key: 'vf_task_owner',              label: 'VF Task Owner',             width: 130, type: 'dropdown' },
    { key: 'prq',                        label: 'PRQ',                       width:  90, type: 'text'     },

    // ── Ownership column — role-gated ─────────────────────
    { key: 'coordinator_name',           label: 'Coordinator',               width: 130, type: 'text',
      roles:    ['invoicing', 'manager'],   // coordinator never sees this column
      readOnly: ['invoicing']               // invoicing can see but not edit
    },

    // ── Invoicing columns — invoicing + manager only ───────
    { key: 'acceptance_status',          label: 'Acceptance Status',         width: 145, type: 'dropdown', roles: ['invoicing', 'manager'] },
    { key: 'fac_date',                   label: 'FAC Date',                  width: 110, type: 'date',     dateFormat: 'DD-MMM-YYYY', roles: ['invoicing', 'manager'] },
    { key: 'certificate_num',            label: 'Certificate #',             width: 120, type: 'text',     roles: ['invoicing', 'manager'] },
    { key: 'acceptance_week',            label: 'Acceptance Week',           width: 135, type: 'text',     roles: ['invoicing', 'manager'] },
    { key: 'tsr_sub',                    label: 'TSR Sub#',                  width: 100, type: 'text',     roles: ['invoicing', 'manager'] },
    { key: 'po_status',                  label: 'PO Status',                 width: 110, type: 'dropdown', roles: ['invoicing', 'manager'] },
    { key: 'po_number',                  label: 'PO Number',                 width: 115, type: 'text',     roles: ['invoicing', 'manager'] },
    { key: 'vf_invoice_num',             label: 'VF Invoice #',              width: 120, type: 'text',     roles: ['invoicing', 'manager'] },
    { key: 'first_receiving_date',       label: '1st Receiving Date',        width: 145, type: 'date',     dateFormat: 'DD-MMM-YYYY', roles: ['invoicing', 'manager'] },
    { key: 'lmp_portion',                label: 'LMP Portion',               width: 115, type: 'numeric',  numericFormat: { pattern: '$0,0.00' }, readOnly: ['coordinator', 'invoicing'], roles: ['invoicing', 'manager'] },
    { key: 'contractor_portion',         label: 'Contractor Portion',        width: 145, type: 'numeric',  numericFormat: { pattern: '$0,0.00' }, readOnly: ['coordinator', 'invoicing'], roles: ['invoicing', 'manager'] },
    { key: 'sent_to_cost_control',       label: 'Sent to Cost Control',      width: 155, type: 'date',     dateFormat: 'DD-MMM-YYYY', correctFormat: true, roles: ['invoicing', 'manager'] },
    { key: 'received_from_cc',           label: 'Received from CC',          width: 145, type: 'date',     dateFormat: 'DD-MMM-YYYY', correctFormat: true, roles: ['invoicing', 'manager'] },
    { key: 'contractor_invoice_num',     label: 'Contractor Invoice #',      width: 155, type: 'text',     roles: ['invoicing', 'manager'] },
    { key: 'vf_invoice_submission_date', label: 'VF Invoice Submission Date',width: 200, type: 'date',     dateFormat: 'DD-MMM-YYYY', roles: ['invoicing', 'manager'] },
    { key: 'cash_received_date',         label: 'Cash Received Date',        width: 155, type: 'date',     dateFormat: 'DD-MMM-YYYY', roles: ['invoicing', 'manager'] },
  ];

  // ── Internal state ────────────────────────────────────────

  var _hot             = null;   // Handsontable instance
  var _role            = null;
  var _userName        = null;
  var _visibleCols     = [];     // filtered COLUMNS for current role
  var _data            = [];     // current grid data (array of row objects)
  var _savePending     = {};     // rowIdx → setTimeout handle (debounce per row)
  var _dropdownSources = {};     // { field_key: [option, ...] } — merged from DROPDOWN_DEFAULTS + Config
  var _lockedRows      = {};     // { physicalRowIndex: true } — built in loadData for coordinator role

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

    // Build locked-row index for coordinator role.
    // Keyed by _data array index (= HOT physical row index) so lock checks
    // are O(1) and immune to visual row reordering from column sorting.
    _lockedRows = {};
    if (_role === 'coordinator') {
      _data.forEach(function (row, idx) {
        if (row._locked) _lockedRows[idx] = true;
      });
    }

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

    // Apply pricing calculations and indicators to every loaded row.
    // Pricing must be initialised (Pricing.init called) before loadData.
    if (typeof Pricing !== 'undefined' && Pricing.isReady()) {
      for (var i = 0; i < _data.length; i++) {
        _applyPricing(i);
      }
    }
  }

  /**
   * Merge Config dropdown options with DROPDOWN_DEFAULTS fallbacks and
   * store in _dropdownSources. Config values win over defaults.
   * Called by app.js after Sheets.fetchConfig resolves, before Grid.init.
   *
   * configDropdowns — { field_key: [option, ...] } from Code.gs getConfigData()
   *                   Pass null or {} to use defaults only.
   */
  /**
   * configDropdowns — { field_key: [option, ...] } from Config tab [DROPDOWNS] section
   * priceList       — [{ version, lineItem, unitPrice }] from Config tab price tables
   *                   Used to populate the line_item dropdown with all known line items.
   *
   * Rules:
   *   - Config values completely replace DROPDOWN_DEFAULTS for that field
   *   - Fields with type:'dropdown' in COLUMNS but no source get rendered as text
   *     (handled in _initHot — see cfg.type override below)
   *   - line_item is always populated from the price list, not from dropdown section
   */
  function applyDropdowns(configDropdowns, priceList) {
    _dropdownSources = {};

    // Config values only — no hardcoded defaults mixed in.
    // If the Config tab has no entry for a field, that field gets no source
    // and _initHot will render it as plain text instead of a dropdown.
    var config = configDropdowns || {};
    Object.keys(config).forEach(function (key) {
      if (config[key] && config[key].length) {
        _dropdownSources[key] = config[key].slice();
      }
    });

    // ── Populate line_item from price list ──────────────────
    // Extract unique line item names in the order they appear.
    var items = priceList || [];
    if (items.length) {
      var seen      = {};
      var lineItems = [];
      items.forEach(function (p) {
        var li = String(p.lineItem || '').trim();
        if (li && !seen[li]) { seen[li] = true; lineItems.push(li); }
      });
      if (lineItems.length) _dropdownSources['line_item'] = lineItems;
    }

    // ── distance fallback ────────────────────────────────────
    // Always keep a usable distance list even without a [DISTANCE_MULTIPLIERS] section.
    if (!_dropdownSources['distance']) {
      var defaults = (typeof DROPDOWN_DEFAULTS !== 'undefined') ? DROPDOWN_DEFAULTS : {};
      if (defaults['distance'] && defaults['distance'].length) {
        _dropdownSources['distance'] = defaults['distance'].slice();
      }
    }

    console.log('[grid.js] applyDropdowns() — sources:', Object.keys(_dropdownSources).join(', '));

    // If HOT is already initialised update column sources in-place and re-render.
    if (_hot) {
      var columns = _hot.getSettings().columns;
      if (columns) {
        _visibleCols.forEach(function (col, colIdx) {
          if (col.type === 'dropdown') {
            var src = _dropdownSources[col.key] || [];
            if (columns[colIdx]) columns[colIdx].source = src;
          }
        });
        _hot.updateSettings({ columns: columns });
      }
    }
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
        cfg.dateFormat    = col.dateFormat || 'YYYY-MM-DD';
        cfg.correctFormat = true;
      }
      if (col.type === 'dropdown') {
        var src = _dropdownSources[col.key] || [];
        if (src.length) {
          // Has options from Config — render as dropdown.
          // strict:false lets users type values not in the list.
          cfg.type        = 'dropdown';
          cfg.source      = src;
          cfg.strict      = false;
          cfg.allowInvalid = true;
        } else {
          // No options configured — fall back to plain text so the cell
          // doesn't show an unusable empty dropdown arrow.
          cfg.type = 'text';
        }
      }
      return cfg;
    });

    _hot = new Handsontable(container, {
      data:               [],
      colHeaders:         colHeaders,
      columns:            columns,
      rowHeaders: function (row) {
        // Show 🔒 in the row header for locked rows (coordinator view only).
        if (_isRowLockedByVisual(row)) return '\uD83D\uDD12'; // 🔒
        return String(row + 1);
      },
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
      rowHeights:         24,
      licenseKey:         'non-commercial-and-evaluation',

      // Freeze first 2 columns (ID + Logical Site ID)
      fixedColumnsLeft:   2,

      // After a cell is edited, save the row to Apps Script.
      // Debounced per row — prevents duplicate appends when the user
      // edits multiple cells before the first save callback returns.
      //
      // Sources filtered:
      //   'loadData' — bulk load, never save
      //   'pricing'  — programmatic pricing updates (set by _applyPricing);
      //                filtering prevents re-entrancy; the original user edit
      //                already has a debounced save in flight that will capture
      //                all the pricing values written synchronously before it fires
      afterChange: function (changes, source) {
        if (!changes || source === 'loadData' || source === 'pricing' || source === 'lock_revert') return;

        var self      = this; // HOT instance
        var dirtyRows = {};

        // ── Lock revert (belt-and-suspenders) ─────────────────────
        // beforeBeginEditing doesn't fire for every edit path in HOT
        // (e.g. direct dropdown selection). Revert any change to a
        // locked row immediately — before _scheduleSave is called —
        // so no data ever reaches the server.
        //
        // Uses _isRowLockedByVisual which converts visual→physical correctly,
        // so this works even when the grid is sorted.
        var checkedRows = {};
        var anyLocked   = false;
        changes.forEach(function (change) {
          var rowIdx = change[0];
          if (checkedRows[rowIdx] === undefined) {
            checkedRows[rowIdx] = _isRowLockedByVisual(rowIdx);
          }
          if (!checkedRows[rowIdx]) return;
          anyLocked = true;
          // Revert to old value (change[2]) so no dirty state reaches _scheduleSave
          self.setDataAtRowProp(rowIdx, change[1], change[2], 'lock_revert');
        });

        if (anyLocked) {
          _showModal(
            'Row Locked',
            'This record is locked because acceptance is in progress.\n' +
            'Contact the invoicing team for changes.'
          );
          return; // stop — don't schedule saves for any row in this batch
        }

        // Columns whose changes require a pricing recalculation
        var PRICING_COLS = {
          line_item:         true,
          task_date:         true,
          new_price:         true,
          absolute_quantity: true,  // "Quantity" — manual input, drives RC Quantity
          contractor:        true,
          distance:          true
        };

        changes.forEach(function (change) {
          var rowIdx = change[0];
          var colKey = change[1]; // property name when columns use data:'key'
          dirtyRows[rowIdx] = true;

          // ── ID auto-generation ───────────────────────────────
          if (colKey === 'job_code' && typeof ID !== 'undefined') {
            var sourceRow = self.getSourceDataAtRow(rowIdx) || {};
            var newId     = ID.tryGenerate(sourceRow, rowIdx);
            if (newId) {
              self.setDataAtRowProp(rowIdx, 'id', newId, 'id_autofill');
            }
          }

          // ── Pricing recalculation ─────────────────────────────
          if (PRICING_COLS[colKey] && typeof Pricing !== 'undefined' && Pricing.isReady()) {
            var prevVersion = null;
            if (colKey === 'task_date') {
              // Capture the pre-change row to detect a version switch
              var old = self.getSourceDataAtRow(rowIdx) || {};
              prevVersion = Pricing.resolveVersion(old.task_date);
            }

            _applyPricing(rowIdx, prevVersion);
          }
        });

        Object.keys(dirtyRows).forEach(function (rowIdx) {
          _scheduleSave(parseInt(rowIdx, 10));
        });
      },

      // Row lock: prevent coordinators from entering edit mode on locked rows.
      // Fires when user double-clicks or presses Enter/F2 to edit a cell.
      // Returning false cancels the edit without altering any data.
      beforeBeginEditing: function (row) {
        if (_isRowLockedByVisual(row)) {
          _showModal(
            'Row Locked',
            'This record is locked because acceptance is in progress.\n' +
            'Contact the invoicing team for changes.'
          );
          return false;
        }
      },

      afterCreateRow: function (index) {
        _updateRowCount(_hot.countRows());
      },

      afterRemoveRow: function () {
        _updateRowCount(_hot.countRows());
      },

      // Per-cell properties: read-only enforcement + visual classes.
      cells: function (row, col) {
        var colDef = _visibleCols[col];
        if (!colDef) return {};

        // Row lock — coordinator on a locked row: entire row is read-only + greyed out.
        // Manager and invoicing are never affected by row locks.
        if (_isRowLockedByVisual(row)) {
          return { readOnly: true, className: 'cell-readonly row-locked' };
        }

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

        // ── Lock detection from server rejection ──────────────────
        // If the server rejects because the row is locked, immediately
        // mark it locked in _lockedRows and re-render. This handles the
        // case where Code.gs hasn't been redeployed yet with the _locked
        // flag in getRows — the client learns the lock the hard way the
        // first time, then enforces it locally from that point on.
        var isLockError = result.error &&
          result.error.toLowerCase().indexOf('locked') !== -1;

        if (isLockError && _role === 'coordinator') {
          // Mark this physical row as locked
          _lockedRows[rowIdx] = true;
          if (_data[rowIdx]) _data[rowIdx]._locked = true;

          // Re-render so cells callback applies grey tint + readOnly
          if (_hot) _hot.render();

          _showModal(
            'Row Locked',
            'This record is locked because acceptance is in progress.\n' +
            'Contact the invoicing team for changes.'
          );
        } else {
          _showSaveError(result.error);
        }
        return;
      }

      // Update the in-memory _row_index for future edits
      if (!_data[rowIdx]) _data[rowIdx] = {};
      _data[rowIdx]._row_index = result.rowIndex;

      console.log('[grid.js] Row saved — sheet row:', result.rowIndex);
    });
  }

  // ── Pricing ───────────────────────────────────────────────

  // Apply pricing calculations and indicator to a single grid row.
  //
  // rowIdx      — 0-based HOT row index
  // prevVersion — version name that was active BEFORE the triggering
  //               change (only passed when task_date changed); used to
  //               detect and warn about a version switch.
  //
  // All writes use source='pricing' so afterChange ignores them,
  // preventing re-entrancy. Writes are synchronous, so by the time
  // _scheduleSave fires the source row already has the final values.

  function _applyPricing(rowIdx, prevVersion) {
    if (!_hot || !Pricing.isReady()) return;

    var row        = _hot.getSourceDataAtRow(rowIdx) || {};
    var taskDate   = String(row.task_date        || '').trim();
    var lineItem   = String(row.line_item        || '').trim();
    var qty        = parseFloat(row.absolute_quantity) || 0;  // "Quantity" — manual
    var contractor = String(row.contractor       || '').trim();
    var distance   = String(row.distance         || '').trim();

    // ── Auto-fill new_price from price list ───────────────────────
    // All roles: price is always looked up when line_item changes.
    // Manager can override new_price manually afterward.
    var looked = Pricing.lookupPrice(lineItem, taskDate);
    if (looked !== null) {
      var cur = parseFloat(row.new_price) || 0;
      if (Math.abs(cur - looked) > 0.001) {
        _hot.setDataAtRowProp(rowIdx, 'new_price', looked, 'pricing');
        row.new_price = looked;
      }
    }

    // ── Warn on version switch when task_date changes ─────────────
    if (prevVersion !== undefined) {
      var newVersion = Pricing.resolveVersion(taskDate);
      if (newVersion && prevVersion !== null && newVersion !== prevVersion) {
        _showPricingToast(
          'Price version changed: ' + prevVersion + ' \u2192 ' + newVersion +
          '. New price updated automatically.'
        );
      }
    }

    // ── RC Quantity = Quantity × Distance Multiplier (auto-calc) ──
    var distMult = Pricing.getDistanceMultiplier(distance);
    var rcQty    = qty * distMult;

    var curRcQty = parseFloat(row.actual_quantity) || 0;
    if (Math.abs(curRcQty - rcQty) > 0.0001) {
      _hot.setDataAtRowProp(rowIdx, 'actual_quantity', rcQty || 0, 'pricing');
    }

    // ── New Total Price = New Price × RC Quantity ─────────────────
    var newPrice = parseFloat(row.new_price) || 0;
    var totals   = Pricing.calculateTotals(newPrice, rcQty, contractor);

    _hot.setDataAtRowProp(rowIdx, 'new_total_price', totals.newTotalPrice, 'pricing');

    // lmp_portion and contractor_portion are invoicing/manager-only columns
    if (_role === 'invoicing' || _role === 'manager') {
      _hot.setDataAtRowProp(rowIdx, 'lmp_portion',        totals.lmpPortion,        'pricing');
      _hot.setDataAtRowProp(rowIdx, 'contractor_portion', totals.contractorPortion, 'pricing');
    }

    // ── Visual indicator ──────────────────────────────────────────
    // Re-read row after updates for accurate indicator
    var updatedRow  = _hot.getSourceDataAtRow(rowIdx) || {};
    var indicator   = Pricing.getIndicator(updatedRow);
    _hot.setDataAtRowProp(rowIdx, '_price_indicator', indicator.icon, 'pricing');
  }

  // Non-blocking toast for pricing events (version change warning).
  function _showPricingToast(msg) {
    var existing = document.getElementById('pricing-toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.id = 'pricing-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function () { if (toast.parentNode) toast.remove(); }, 5000);

    // Inject styles on first use
    if (!document.getElementById('pricing-toast-styles')) {
      var s = document.createElement('style');
      s.id = 'pricing-toast-styles';
      s.textContent = [
        '#pricing-toast {',
          'position: fixed;',
          'bottom: 40px;',
          'left: 50%;',
          'transform: translateX(-50%);',
          'background: var(--bg-navy);',
          'color: var(--text-on-navy);',
          'font-family: var(--font-body);',
          'font-size: 13px;',
          'padding: 10px 20px;',
          'border: 1px solid var(--accent);',
          'box-shadow: 0 4px 16px rgba(0,0,0,0.25);',
          'z-index: 2000;',
          'white-space: nowrap;',
        '}',
      ].join('\n');
      document.head.appendChild(s);
    }
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

  // ── Row lock helpers ──────────────────────────────────────

  /**
   * Returns true if the given VISUAL row index is a locked row.
   *
   * Uses _hot.toPhysicalRow() to convert visual → physical before checking
   * _lockedRows, so the result is correct even when the grid is sorted.
   *
   * For coordinator: relies on _lockedRows map built from server _locked flag.
   * For invoicing/manager: checks acceptance_status directly on the source row.
   */
  function _isRowLockedByVisual(visualRow) {
    if (!_hot) return false;
    var physRow = (_hot.toPhysicalRow) ? _hot.toPhysicalRow(visualRow) : visualRow;

    if (_role === 'coordinator') {
      return !!_lockedRows[physRow];
    }

    // Invoicing / manager: locked rows are visible but never locked out for them.
    // Return false — managers and invoicing can always edit.
    return false;
  }

  // ── Modal dialog ──────────────────────────────────────────
  //
  // Used for all error and warning messages — replaces toasts.
  // Blocks interaction until dismissed (OK button or Escape key).
  // title   — short heading  e.g. "Row Locked" / "Save Failed"
  // message — body text; \n becomes a line break

  function _showModal(title, message) {
    // Remove any existing modal
    var existing = document.getElementById('grid-modal-overlay');
    if (existing) existing.remove();

    _injectModalStyles();

    var overlay = document.createElement('div');
    overlay.id = 'grid-modal-overlay';

    var dialog = document.createElement('div');
    dialog.id = 'grid-modal-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');

    var titleEl = document.createElement('div');
    titleEl.id = 'grid-modal-title';
    titleEl.textContent = title;

    var bodyEl = document.createElement('div');
    bodyEl.id = 'grid-modal-body';
    // Convert \n to <br> safely
    message.split('\n').forEach(function (line, idx) {
      if (idx > 0) bodyEl.appendChild(document.createElement('br'));
      bodyEl.appendChild(document.createTextNode(line));
    });

    var footer = document.createElement('div');
    footer.id = 'grid-modal-footer';

    var okBtn = document.createElement('button');
    okBtn.id = 'grid-modal-ok';
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', _closeModal);

    footer.appendChild(okBtn);
    dialog.appendChild(titleEl);
    dialog.appendChild(bodyEl);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Close on overlay click (outside dialog)
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) _closeModal();
    });

    // Close on Escape
    document.addEventListener('keydown', _modalKeyHandler);

    okBtn.focus();
  }

  function _closeModal() {
    var overlay = document.getElementById('grid-modal-overlay');
    if (overlay) overlay.remove();
    document.removeEventListener('keydown', _modalKeyHandler);
  }

  function _modalKeyHandler(e) {
    if (e.key === 'Escape' || e.keyCode === 27) _closeModal();
    if ((e.key === 'Enter' || e.keyCode === 13) && document.getElementById('grid-modal-overlay')) _closeModal();
  }

  function _injectModalStyles() {
    if (document.getElementById('grid-modal-styles')) return;
    var s = document.createElement('style');
    s.id = 'grid-modal-styles';
    s.textContent = [
      '#grid-modal-overlay {',
        'position: fixed;',
        'inset: 0;',
        'background: rgba(0,0,0,0.45);',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        'z-index: 9000;',
      '}',
      '#grid-modal-dialog {',
        'background: var(--bg-surface, #fff);',
        'border: 1px solid var(--border, #ccc);',
        'box-shadow: 0 8px 40px rgba(0,0,0,0.32);',
        'min-width: 320px;',
        'max-width: 480px;',
        'width: 90%;',
        'display: flex;',
        'flex-direction: column;',
      '}',
      '#grid-modal-title {',
        'background: var(--bg-navy, #1a2e4a);',
        'color: var(--text-on-navy, #fff);',
        'font-family: var(--font-display, sans-serif);',
        'font-size: 12px;',
        'font-weight: 700;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'padding: 10px 16px;',
        'border-bottom: 1px solid var(--border-navy, rgba(255,255,255,0.12));',
      '}',
      '#grid-modal-body {',
        'font-family: var(--font-body, sans-serif);',
        'font-size: 13px;',
        'color: var(--text-primary, #222);',
        'padding: 20px 20px 16px;',
        'line-height: 1.55;',
      '}',
      '#grid-modal-footer {',
        'display: flex;',
        'justify-content: flex-end;',
        'padding: 0 16px 14px;',
      '}',
      '#grid-modal-ok {',
        'height: 30px;',
        'min-width: 80px;',
        'padding: 0 20px;',
        'font-family: var(--font-display, sans-serif);',
        'font-weight: 700;',
        'font-size: 11px;',
        'letter-spacing: 0.1em;',
        'text-transform: uppercase;',
        'background: var(--bg-navy, #1a2e4a);',
        'color: var(--text-on-navy, #fff);',
        'border: 1px solid var(--border-navy, rgba(255,255,255,0.15));',
        'cursor: pointer;',
      '}',
      '#grid-modal-ok:hover {',
        'background: var(--accent, #c9973a);',
        'border-color: var(--accent, #c9973a);',
      '}',
    ].join('\n');
    document.head.appendChild(s);
  }

  function _showSaveError(msg) {
    _showModal('Save Failed', msg || 'An unknown error occurred.');
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

      // Data cells — no wrap so rows stay compact like Excel
      '.handsontable td {',
        'font-family: var(--font-body) !important;',
        'font-size: 13px !important;',
        'color: var(--text-primary) !important;',
        'border-color: var(--border) !important;',
        'padding: 0 8px !important;',
        'white-space: nowrap !important;',
        'overflow: hidden;',
        'text-overflow: ellipsis;',
      '}',

      // Read-only cells — very subtle background tint
      '.handsontable td.cell-readonly {',
        'background: #f8f9fb !important;',
        'color: var(--text-secondary) !important;',
      '}',

      // Locked rows (coordinator view) — grey tint signals non-editable
      '.handsontable td.row-locked {',
        'background: #ebebef !important;',
        'color: #9898a8 !important;',
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


    ].join('\n');

    document.head.appendChild(s);
  }());

  // ── Expose ────────────────────────────────────────────────

  return {
    init:           init,
    loadData:       loadData,
    applyDropdowns: applyDropdowns,
  };

}());
