// ============================================================
// grid.js — AG Grid Community init + ALL column definitions
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Define all 43 columns (key, label, width, type, role visibility)
//   - Filter visible columns by role at init time
//   - Init and render the AG Grid instance
//   - Coordinator row isolation via in-memory filter (SQL WHERE in Session 4)
//   - Row locking: _is_locked flag → editable:false for coordinators
//   - JC uniqueness: DuckDB query on job_code change
//   - Coordinator auto-stamp: coordinator_name on new row creation
//   - Handle cell edits → debounced save via Offline.queueSave
//   - Expose the same public API the rest of the app already calls
// ============================================================

var Grid = (function () {
  'use strict';

  // ══════════════════════════════════════════════════════════
  // COLUMN MASTER LIST
  // ══════════════════════════════════════════════════════════

  var COLUMNS = [

    // ── Coordinator columns (visible to all roles) ──────────
    { key: 'id',
      label: 'ID #',                       width: 180, type: 'text',
      readOnly: ['coordinator', 'invoicing', 'manager'] },

    { key: 'job_code',
      label: 'Job Code',                   width: 120, type: 'text'     },

    { key: 'tx_rf',
      label: 'TX/RF',                      width:  80, type: 'dropdown' },

    { key: 'vendor',
      label: 'Vendor',                     width: 130, type: 'dropdown' },

    { key: 'physical_site_id',
      label: 'Physical Site ID',           width: 130, type: 'text'     },

    { key: 'logical_site_id',
      label: 'Logical Site ID',            width: 130, type: 'text'     },

    { key: 'site_option',
      label: 'Site Option',                width: 100, type: 'text'     },

    { key: 'facing',
      label: 'Facing',                     width:  90, type: 'dropdown' },

    { key: 'region',
      label: 'Region',                     width: 100, type: 'dropdown' },

    { key: 'sub_region',
      label: 'Sub Region',                 width: 110, type: 'dropdown' },

    { key: 'distance',
      label: 'Distance',                   width: 140, type: 'dropdown' },

    { key: 'absolute_quantity',
      label: 'Quantity',                   width: 110, type: 'numeric'  },

    { key: 'actual_quantity',
      label: 'RC Quantity',                width: 110, type: 'numeric',
      readOnly: ['coordinator', 'invoicing'] },

    { key: 'general_stream',
      label: 'General Stream',             width: 130, type: 'dropdown' },

    { key: 'task_name',
      label: 'Task Name',                  width: 200, type: 'dropdown' },

    { key: 'contractor',
      label: 'Contractor',                 width: 130, type: 'dropdown' },

    { key: 'engineer_name',
      label: "Engineer's Name",            width: 140, type: 'text'     },

    { key: 'line_item',
      label: 'Line Item',                  width: 260, type: 'dropdown' },

    { key: 'new_price',
      label: 'New Price (EGP)',            width: 120, type: 'numeric',
      readOnly: ['coordinator', 'invoicing'] },

    { key: 'new_total_price',
      label: 'New Total Price (EGP)',      width: 150, type: 'numeric',
      readOnly: ['coordinator', 'invoicing'] },

    { key: 'comments',
      label: 'Comments',                   width: 200, type: 'text'     },

    { key: 'status',
      label: 'Status',                     width: 110, type: 'dropdown' },

    { key: 'task_date',
      label: 'Task Date',                  width: 110, type: 'date'     },

    { key: '_price_indicator',
      label: '●',                          width:  42, type: 'text',
      readOnly: ['coordinator', 'invoicing', 'manager'] },

    { key: 'vf_task_owner',
      label: 'VF Task Owner',             width: 130, type: 'dropdown' },

    { key: 'prq',
      label: 'PRQ',                        width:  90, type: 'text'     },

    // ── Ownership column ────────────────────────────────────
    { key: 'coordinator_name',
      label: 'Coordinator',               width: 130, type: 'text',
      roles:    ['invoicing', 'manager'],
      readOnly: ['invoicing']              },

    // ── Invoicing / Manager columns ─────────────────────────
    { key: 'acceptance_status',
      label: 'Acceptance Status',         width: 145, type: 'dropdown',
      roles: ['invoicing', 'manager']      },

    { key: 'fac_date',
      label: 'FAC Date',                  width: 110, type: 'date',
      roles: ['invoicing', 'manager']      },

    { key: 'certificate_num',
      label: 'Certificate #',             width: 120, type: 'text',
      roles: ['invoicing', 'manager']      },

    { key: 'acceptance_week',
      label: 'Acceptance Week',           width: 135, type: 'text',
      roles: ['invoicing', 'manager']      },

    { key: 'tsr_sub',
      label: 'TSR Sub#',                  width: 100, type: 'text',
      roles: ['invoicing', 'manager']      },

    { key: 'po_status',
      label: 'PO Status',                 width: 110, type: 'dropdown',
      roles: ['invoicing', 'manager']      },

    { key: 'po_number',
      label: 'PO Number',                 width: 115, type: 'text',
      roles: ['invoicing', 'manager']      },

    { key: 'vf_invoice_num',
      label: 'VF Invoice #',              width: 120, type: 'text',
      roles: ['invoicing', 'manager']      },

    { key: 'first_receiving_date',
      label: '1st Receiving Date',        width: 145, type: 'date',
      roles: ['invoicing', 'manager']      },

    { key: 'lmp_portion',
      label: 'LMP Portion (EGP)',         width: 130, type: 'numeric',
      readOnly: ['coordinator', 'invoicing'],
      roles: ['invoicing', 'manager']      },

    { key: 'contractor_portion',
      label: 'Contractor Portion (EGP)',  width: 165, type: 'numeric',
      readOnly: ['coordinator', 'invoicing'],
      roles: ['invoicing', 'manager']      },

    { key: 'sent_to_cost_control',
      label: 'Sent to Cost Control',      width: 155, type: 'date',
      roles: ['invoicing', 'manager']      },

    { key: 'received_from_cc',
      label: 'Received from CC',          width: 145, type: 'date',
      roles: ['invoicing', 'manager']      },

    { key: 'contractor_invoice_num',
      label: 'Contractor Invoice #',      width: 155, type: 'text',
      roles: ['invoicing', 'manager']      },

    { key: 'vf_invoice_submission_date',
      label: 'VF Invoice Submission Date',width: 200, type: 'date',
      roles: ['invoicing', 'manager']      },

    { key: 'cash_received_date',
      label: 'Cash Received Date',        width: 155, type: 'date',
      roles: ['invoicing', 'manager']      },
  ];

  // ══════════════════════════════════════════════════════════
  // INTERNAL STATE
  // ══════════════════════════════════════════════════════════

  var _gridApi         = null;
  var _role            = null;
  var _userName        = null;
  var _visibleCols     = [];
  var _allData         = [];     // rows currently shown in the grid
  var _dropdownSources = {};
  var _savePending     = {};     // nodeId → setTimeout handle
  var _changedRows     = {};     // nodeId → setTimeout handle (manager highlight)
  var _searchFn        = null;   // active global-search predicate

  // Session 3 state
  var _jcErrors        = {};     // { _row_id: true } — cells with a JC conflict
  var _jcRevertActive  = false;  // guard: skip change handler during programmatic revert

  // ══════════════════════════════════════════════════════════
  // PUBLIC: init
  // ══════════════════════════════════════════════════════════

  function init(role, userName) {
    _role     = role;
    _userName = userName;

    _visibleCols = COLUMNS.filter(function (col) {
      if (!col.roles) return true;
      return col.roles.indexOf(role) !== -1;
    });

    // Record session owner in DuckDB so SQL queries in Session 4+ can
    // filter by coordinator_name without reading sessionStorage directly.
    if (typeof Db !== 'undefined') {
      Db.init().then(function () {
        return Db.setSessionOwner(userName, role);
      }).catch(function (e) {
        console.warn('[Grid] DuckDB session owner set failed:', e.message || e);
      });
    }

    _renderToolbar(role);
    _initGrid();
    _fitContainer();
    _updateRowCount(0);

    window.addEventListener('resize', _fitContainer);
    console.log('[Grid] init() — role:', role, 'cols:', _visibleCols.length);
  }

  // ══════════════════════════════════════════════════════════
  // AG GRID INITIALISATION
  // ══════════════════════════════════════════════════════════

  function _initGrid() {
    var container = document.getElementById('grid-container');
    if (!container) { console.error('[Grid] #grid-container not found'); return; }
    container.classList.add('ag-theme-alpine');

    _gridApi = agGrid.createGrid(container, {
      // Use v32-style CSS themes (ag-theme-alpine + ag-grid.css).
      // Without 'legacy', AG Grid v33 defaults to themeQuartz and
      // conflicts with the CSS files, causing error #239.
      theme:       'legacy',

      columnDefs:  _buildColDefs(),
      rowData:     [],
      rowHeight:   24,
      headerHeight: 32,

      defaultColDef: {
        resizable:        true,
        sortable:         true,
        suppressMovable:  false,
        // Disable AG Grid v32+ automatic cell data type inference.
        // Without this, text columns whose values look numeric (e.g. site IDs
        // like "5797") are inferred as numeric and non-numeric values render
        // as "Invalid Number".
        cellDataType:     false,
        // Per-column filter types are set in _buildColDefs().
        // Filters fire onFilterChanged → Filters.js → DuckDB SQL.
      },

      // ── Row visual rules ──────────────────────────────────
      rowClassRules: {
        'row-locked': function (params) {
          return _role === 'coordinator' && !!(params.data && params.data._is_locked);
        },
      },

      // Stable row identity — lets applyTransaction(update) find rows even after
      // setGridOption('rowData') replaces the dataset.  Without this, AG Grid
      // uses object reference equality, which breaks after any full data swap.
      getRowId: function (params) {
        return params.data._row_id
          || (params.data._row_index ? 'row_' + params.data._row_index : null)
          || params.data.id
          || null;
      },

      editType:                     '',
      stopEditingWhenCellsLoseFocus: true,
      singleClickEdit:              false,

      // v32.2+ object format — 'multiple' string is deprecated
      rowSelection: {
        mode:                'multiRow',
        enableClickSelection: false,
      },
      animateRows:                 false,

      // ── Events ────────────────────────────────────────────
      onCellValueChanged:  _onCellValueChanged,
      onCellDoubleClicked: _onCellDoubleClicked,
      onGridSizeChanged:   _fitContainer,

      // Column filter change → Filters.js translates to SQL and re-queries DuckDB
      onFilterChanged: function () {
        if (typeof Filters !== 'undefined' && Filters.onColumnFilterChanged) {
          Filters.onColumnFilterChanged();
        }
      },
    });
  }

  // ══════════════════════════════════════════════════════════
  // COLUMN DEFINITION BUILDER
  // ══════════════════════════════════════════════════════════

  function _buildColDefs() {
    return _visibleCols.map(function (col) {
      var isRO = _isColReadOnly(col);

      var def = {
        field:      col.key,
        headerName: col.label,
        width:      col.width || 120,
        editable:   _makeEditableFn(col),
        resizable:  true,
        sortable:   true,
        cellClass:  isRO ? 'cell-readonly' : undefined,
      };

      // ── Column filter type (feeds onFilterChanged → DuckDB SQL) ─
      // Price indicator has no filter; all others get appropriate type.
      if (col.key !== '_price_indicator') {
        if (col.type === 'numeric') {
          def.filter       = 'agNumberColumnFilter';
          def.filterParams = { buttons: ['apply', 'clear'], closeOnApply: true };
        } else if (col.type === 'date') {
          def.filter       = 'agDateColumnFilter';
          def.filterParams = { buttons: ['apply', 'clear'], closeOnApply: true };
        } else {
          // text, dropdown — all treated as text search in SQL
          def.filter       = 'agTextColumnFilter';
          def.filterParams = { buttons: ['apply', 'clear'], closeOnApply: true };
        }
      }

      // ── Numeric ─────────────────────────────────────────────
      if (col.type === 'numeric') {
        def.type           = 'numericColumn';
        def.valueFormatter = _numFormatter;
        def.valueParser    = _numParser;
      }

      // ── Date — text storage, formatted display ───────────────
      if (col.type === 'date') {
        def.valueFormatter = _dateFormatter;
      }

      // ── Dropdown — agSelectCellEditor ───────────────────────
      if (col.type === 'dropdown' && !isRO) {
        var src = _dropdownSources[col.key] || [];
        if (src.length) {
          def.cellEditor       = 'agSelectCellEditor';
          def.cellEditorParams = { values: src };
        }
      }

      // ── ID# column: show lock icon for coordinator on locked rows ──
      if (col.key === 'id' && _role === 'coordinator') {
        def.valueFormatter = function (params) {
          if (params.data && params.data._is_locked) {
            return '🔒 ' + (params.value || '');
          }
          return params.value || '';
        };
      }

      // ── job_code: dynamic class for JC conflict highlighting ──
      if (col.key === 'job_code') {
        def.cellClass = function (params) {
          if (params.data && params.data._row_id && _jcErrors[params.data._row_id]) {
            return 'cell-jc-error';
          }
          return isRO ? 'cell-readonly' : undefined;
        };
      }

      // ── Price indicator — compact centred column ────────────
      if (col.key === '_price_indicator') {
        def.minWidth    = 42;
        def.maxWidth    = 42;
        def.width       = 42;
        def.cellClass   = 'col-price-indicator';
        def.headerClass = 'ag-header-cell-center';
      }

      return def;
    });
  }

  // ── Editable callback ──────────────────────────────────────
  //
  // For coordinator role, locked rows are entirely read-only.
  // Manager and invoicing are never locked out (per CLAUDE.md).
  // Column-level readOnly is a separate, higher-priority check.

  function _makeEditableFn(col) {
    if (_isColReadOnly(col)) return false;
    if (_role !== 'coordinator') return true;

    // Coordinator: per-cell check — non-editable when row is locked
    return function (params) {
      return !(params.data && params.data._is_locked);
    };
  }

  // ══════════════════════════════════════════════════════════
  // VALUE FORMATTERS / PARSERS
  // ══════════════════════════════════════════════════════════

  function _numFormatter(params) {
    var v = params.value;
    if (v === null || v === undefined || v === '') return '';
    var n = parseFloat(v);
    if (isNaN(n)) return '';
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _numParser(params) {
    if (params.newValue === '' || params.newValue === null) return null;
    var n = parseFloat(String(params.newValue).replace(/,/g, ''));
    return isNaN(n) ? params.newValue : n;
  }

  function _dateFormatter(params) {
    var v = params.value;
    if (!v) return '';
    var s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) s = s.slice(0, 10);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var mon = months[parseInt(m[2], 10) - 1];
      if (mon) return m[3] + '-' + mon + '-' + m[1];
    }
    return s;
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: applyDropdowns
  // ══════════════════════════════════════════════════════════

  function applyDropdowns(configDropdowns, priceList) {
    _dropdownSources = {};

    var config = configDropdowns || {};
    Object.keys(config).forEach(function (key) {
      if (config[key] && config[key].length) {
        _dropdownSources[key] = config[key].slice();
      }
    });

    var seen = {}, lineItems = [];
    (priceList || []).forEach(function (p) {
      var li = String(p.lineItem || '').trim();
      if (li && !seen[li]) { seen[li] = true; lineItems.push(li); }
    });
    if (lineItems.length) _dropdownSources['line_item'] = lineItems;

    if (!_dropdownSources['distance'] && typeof DROPDOWN_DEFAULTS !== 'undefined') {
      var dist = DROPDOWN_DEFAULTS['distance'];
      if (dist && dist.length) _dropdownSources['distance'] = dist.slice();
    }

    if (_gridApi) {
      _gridApi.setGridOption('columnDefs', _buildColDefs());
    }

    console.log('[Grid] applyDropdowns() — sources:', Object.keys(_dropdownSources).join(', '));
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: loadData
  // ══════════════════════════════════════════════════════════

  /**
   * Load rows into the grid.
   *
   * For every row we:
   *   1. Derive _is_locked from acceptance_status if not already set
   *   2. Derive _row_id from _row_index if not already set
   *   3. (Coordinator only) filter to rows owned by the logged-in user
   *
   * The filtered set is then written to AG Grid immediately (synchronous)
   * and stored in DuckDB in the background for SQL search (Session 4).
   */
  function loadData(rows) {
    var all = _filterMeaningful(rows || []);

    // Stamp system fields derived from business data
    all.forEach(function (row) {
      // Lock status: a row is locked the moment acceptance_status is filled.
      // Once locked it stays locked — no unlock path per CLAUDE.md.
      if (row._is_locked === undefined || row._is_locked === null) {
        row._is_locked = !!(row.acceptance_status && String(row.acceptance_status).trim());
      }
      // _row_id needed for DuckDB self-exclusion in JC uniqueness queries.
      if (!row._row_id && row._row_index) {
        row._row_id = 'row_' + String(row._row_index);
      }
    });

    // ── Coordinator isolation ────────────────────────────────
    // Coordinator sees only rows where coordinator_name === their own name.
    // This is a belt-and-suspenders check: Code.gs already filters
    // server-side, but cached/offline data may contain foreign rows.
    // Session 4 will add the SQL WHERE equivalent on every DuckDB query.
    var display = all;
    if (_role === 'coordinator') {
      var myName = String(_userName || '').trim().toLowerCase();
      display = all.filter(function (r) {
        return String(r.coordinator_name || '').trim().toLowerCase() === myName;
      });
    }

    _allData = display.slice();

    if (_gridApi) {
      _gridApi.setGridOption('rowData', _allData);
    }

    // DuckDB is populated by the caller (app.js) before loadData() is invoked.
    // Callers call Filters.onDataChanged() directly after their Db.loadAllRows().
    // Do NOT call Db.loadAllRows here — concurrent transactions on _conn would
    // cause TransactionContext aborts, especially with large delta syncs.

    _updateRowCount(_allData.length);
    console.log('[Grid] loadData() —', _allData.length, 'rows shown (role:', _role + ')');
  }

  function _filterMeaningful(rows) {
    return rows.filter(function (r) {
      if (!r) return false;
      var keys = Object.keys(r);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].charAt(0) === '_') continue;
        var v = r[keys[i]];
        if (v !== '' && v !== null && v !== undefined) return true;
      }
      return false;
    });
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: applyDelta
  // ══════════════════════════════════════════════════════════

  function applyDelta(rows) {
    if (!rows || !rows.length || !_gridApi) return;

    // Stamp system fields on incoming delta rows
    rows.forEach(function (row) {
      if (row._is_locked === undefined || row._is_locked === null) {
        row._is_locked = !!(row.acceptance_status && String(row.acceptance_status).trim());
      }
      if (!row._row_id && row._row_index) {
        row._row_id = 'row_' + String(row._row_index);
      }
    });

    var idxMap = {};
    _allData.forEach(function (r, i) {
      if (r._row_index) idxMap[String(r._row_index)] = i;
    });

    var toAdd    = [];
    var toUpdate = [];

    rows.forEach(function (incoming) {
      var pos = idxMap[String(incoming._row_index)];
      if (pos !== undefined) {
        Object.assign(_allData[pos], incoming);
        toUpdate.push(_allData[pos]);
      } else {
        _allData.push(incoming);
        toAdd.push(incoming);
      }
    });

    _gridApi.applyTransaction({ update: toUpdate, add: toAdd });
    _updateRowCount(_allData.length);
  }

  // ══════════════════════════════════════════════════════════
  // CELL EDIT HANDLER
  // ══════════════════════════════════════════════════════════

  function _onCellValueChanged(params) {
    // Guard: skip during programmatic revert (JC conflict handling)
    if (_jcRevertActive || !params.data) return;

    var field = params.colDef.field;

    // ── job_code changes ─────────────────────────────────────
    if (field === 'job_code') {
      // Clear any stale JC error on this row
      if (params.data._row_id) _dismissJcError(params.data._row_id, params.node);

      // ID# auto-generation: fires when job_code becomes non-empty
      if (params.newValue && typeof ID !== 'undefined') {
        var newId = ID.tryGenerate(params.data, params.rowIndex);
        if (newId) {
          params.data.id = newId;
          _gridApi.refreshCells({ rowNodes: [params.node], columns: ['id'], force: true });
        }
      }

      // JC uniqueness check (async).
      // _checkJcUniqueness calls _scheduleSave internally on success,
      // or reverts and shows an error on conflict — so we return early here.
      if (params.newValue) {
        _checkJcUniqueness(params);
        return;
      }
    }

    // All other changed columns — schedule debounced save
    _scheduleSave(params.node);
  }

  // ── Lock message on double-click (coordinator only) ────────
  //
  // When editable() returns false the grid doesn't start editing,
  // so onCellEditingStarted never fires.  We use onCellDoubleClicked
  // instead: it fires regardless of editability, letting us show the
  // user-facing lock message.

  function _onCellDoubleClicked(params) {
    if (_role !== 'coordinator') return;
    if (params.data && params.data._is_locked) {
      _showLockModal();
    }
  }

  // ══════════════════════════════════════════════════════════
  // JC UNIQUENESS CHECK
  // ══════════════════════════════════════════════════════════

  /**
   * Query DuckDB for any existing row with the same job_code on a
   * DIFFERENT logical_site_id.  On conflict: revert the field, highlight
   * the cell red, and show an error message.  On success: schedule save.
   *
   * Same-site duplicate JCs (same job on multiple task types) are allowed.
   */
  function _checkJcUniqueness(params) {
    var newJC   = String(params.newValue || '').trim();
    var rowId   = params.data._row_id || '';
    var ownSite = String(params.data.logical_site_id || '').trim().toLowerCase();

    // If DuckDB isn't ready, allow the save optimistically
    if (!newJC || typeof Db === 'undefined') {
      _scheduleSave(params.node);
      return;
    }

    Db.query(
      'SELECT logical_site_id FROM rows ' +
      'WHERE job_code = ? AND _row_id != ? AND _is_deleted = false',
      [newJC, rowId]
    ).then(function (results) {

      // Look for any row with the same JC bound to a DIFFERENT site
      var conflict = null;
      for (var i = 0; i < results.length; i++) {
        var siteLower = String(results[i].logical_site_id || '').trim().toLowerCase();
        if (siteLower && siteLower !== ownSite) {
          conflict = results[i];
          break;
        }
      }

      if (!conflict) {
        _scheduleSave(params.node);  // no conflict — proceed
        return;
      }

      // ── Conflict detected ──────────────────────────────────
      // Revert the field value, mark the cell red, and show an error.
      _jcRevertActive = true;
      params.node.setDataValue('job_code', params.oldValue || '');
      _jcRevertActive = false;

      // Mark this row as having a JC error
      if (params.data._row_id) {
        _jcErrors[params.data._row_id] = true;
        _gridApi.refreshCells({ rowNodes: [params.node], columns: ['job_code'], force: true });
      }

      var conflictSite = String(conflict.logical_site_id || '').trim() || '(no site)';
      _showJcErrorToast(newJC, conflictSite);

    }).catch(function (e) {
      // DuckDB error — fail open (allow save) to avoid blocking the user
      console.warn('[Grid] JC uniqueness check failed:', e);
      _scheduleSave(params.node);
    });
  }

  function _dismissJcError(rowId, rowNode) {
    if (!_jcErrors[rowId]) return;
    delete _jcErrors[rowId];
    if (rowNode && _gridApi) {
      _gridApi.refreshCells({ rowNodes: [rowNode], columns: ['job_code'], force: true });
    }
    var toast = document.getElementById('jc-error-toast');
    if (toast) toast.remove();
  }

  // ══════════════════════════════════════════════════════════
  // MODALS AND TOASTS
  // ══════════════════════════════════════════════════════════

  // ── Row locked message ─────────────────────────────────────

  function _showLockModal() {
    _removeExistingModal();
    _ensureModalStyles();

    var overlay = document.createElement('div');
    overlay.id  = 'grid-modal-overlay';

    var dialog = document.createElement('div');
    dialog.id  = 'grid-modal-dialog';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-modal', 'true');

    var titleEl = document.createElement('div');
    titleEl.id  = 'grid-modal-title';
    titleEl.textContent = 'Row Locked';

    var bodyEl = document.createElement('div');
    bodyEl.id  = 'grid-modal-body';
    bodyEl.textContent =
      'This record is locked because acceptance is in progress. ' +
      'Contact the invoicing team for changes.';

    var footer = document.createElement('div');
    footer.id  = 'grid-modal-footer';

    var okBtn = document.createElement('button');
    okBtn.id  = 'grid-modal-ok';
    okBtn.textContent = 'OK';
    okBtn.addEventListener('click', _closeModal);

    footer.appendChild(okBtn);
    dialog.appendChild(titleEl);
    dialog.appendChild(bodyEl);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) _closeModal();
    });
    document.addEventListener('keydown', _modalKeyHandler);
    okBtn.focus();
  }

  function _closeModal() {
    _removeExistingModal();
    document.removeEventListener('keydown', _modalKeyHandler);
  }

  function _removeExistingModal() {
    var el = document.getElementById('grid-modal-overlay');
    if (el) el.remove();
  }

  function _modalKeyHandler(e) {
    if (e.key === 'Escape' || e.keyCode === 27) _closeModal();
    if ((e.key === 'Enter' || e.keyCode === 13) &&
        document.getElementById('grid-modal-overlay')) _closeModal();
  }

  // ── JC error toast ─────────────────────────────────────────

  function _showJcErrorToast(jc, siteId) {
    var existing = document.getElementById('jc-error-toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.id  = 'jc-error-toast';
    toast.textContent =
      'Job Code "' + jc + '" is already assigned to site ' + siteId + '. ' +
      'A Job Code can only belong to one Logical Site ID.';

    document.body.appendChild(toast);

    // Auto-dismiss after 6 seconds
    setTimeout(function () {
      var el = document.getElementById('jc-error-toast');
      if (el) el.remove();
    }, 6000);

    if (!document.getElementById('jc-toast-styles')) {
      var s = document.createElement('style');
      s.id = 'jc-toast-styles';
      s.textContent = [
        '#jc-error-toast {',
          'position:fixed;',
          'bottom:48px;',
          'left:50%;',
          'transform:translateX(-50%);',
          'background:#c0392b;',
          'color:#fff;',
          'font-family:var(--font-body);',
          'font-size:13px;',
          'padding:10px 20px;',
          'max-width:520px;',
          'text-align:center;',
          'box-shadow:0 4px 16px rgba(0,0,0,0.25);',
          'z-index:8000;',
          'pointer-events:none;',
        '}',
      ].join('');
      document.head.appendChild(s);
    }
  }

  // ── Modal styles (shared with lock + future modals) ────────

  function _ensureModalStyles() {
    if (document.getElementById('grid-modal-styles')) return;
    var s = document.createElement('style');
    s.id = 'grid-modal-styles';
    s.textContent = [
      '#grid-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:9000;}',
      '#grid-modal-dialog{background:var(--bg-surface,#fff);border:1px solid var(--border,#ccc);box-shadow:0 8px 40px rgba(0,0,0,0.32);min-width:320px;max-width:480px;width:90%;display:flex;flex-direction:column;}',
      '#grid-modal-title{background:var(--bg-navy,#1a2e4a);color:var(--text-on-navy,#fff);font-family:var(--font-display,sans-serif);font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:10px 16px;border-bottom:1px solid var(--border-navy,rgba(255,255,255,0.12));}',
      '#grid-modal-body{font-family:var(--font-body,sans-serif);font-size:13px;color:var(--text-primary,#222);padding:20px 20px 16px;line-height:1.55;}',
      '#grid-modal-footer{display:flex;justify-content:flex-end;padding:0 16px 14px;}',
      '#grid-modal-ok{height:30px;min-width:80px;padding:0 20px;font-family:var(--font-display,sans-serif);font-weight:700;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;background:var(--bg-navy,#1a2e4a);color:var(--text-on-navy,#fff);border:1px solid var(--border-navy,rgba(255,255,255,0.15));cursor:pointer;}',
      '#grid-modal-ok:hover{background:var(--accent,#c9973a);border-color:var(--accent,#c9973a);}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ══════════════════════════════════════════════════════════
  // ROW SAVE
  // ══════════════════════════════════════════════════════════

  function _scheduleSave(rowNode) {
    var nodeId = rowNode.id;
    clearTimeout(_savePending[nodeId]);
    _savePending[nodeId] = setTimeout(function () {
      delete _savePending[nodeId];
      _saveRow(rowNode);
    }, 500);
  }

  function _saveRow(rowNode) {
    if (!rowNode || !rowNode.data) return;
    var rowData = Object.assign({}, rowNode.data);

    // Restore _row_index from _row_id when the row was loaded from DuckDB.
    // DuckDB does not persist _row_index (it's not in the schema), so rows
    // coming from _startupFromCache have _row_id='row_N' but no _row_index.
    // Without this, Code.gs sees no _row_index and appends a new row instead
    // of updating the existing one.
    if (!rowData._row_index && rowData._row_id) {
      var _m = String(rowData._row_id).match(/^row_(\d+)$/);
      if (_m) {
        rowData._row_index       = Number(_m[1]);
        rowNode.data._row_index  = rowData._row_index;
      }
    }

    // Coordinator auto-stamp: silently fill coordinator_name on new rows.
    // The column is hidden from coordinators so they never see it.
    if (_role === 'coordinator' && !rowData.coordinator_name) {
      rowData.coordinator_name = _userName;
      rowNode.data.coordinator_name = _userName;
    }

    // Stable local ID for new rows so the offline queue can deduplicate
    // multiple edits to the same unsaved row before the server assigns a _row_index.
    if (!rowData._row_index && !rowData._local_id) {
      rowData._local_id = 'n' + Date.now() + '_' + rowNode.id;
      rowNode.data._local_id = rowData._local_id;
    }
    if (!rowData._row_index && rowNode.data._local_id) {
      rowData._local_id = rowNode.data._local_id;
    }

    if (typeof Sync !== 'undefined') {
      Sync.queueSave(rowData, function (result) {
        if (!result.success) {
          console.error('[Grid] save failed:', result.error);
          return;
        }
        // rowIndex is assigned later by sync.js flush() via Grid.updateRowIndex()
        if (result.rowIndex && rowNode.data) {
          rowNode.data._row_index = result.rowIndex;
          rowNode.data._row_id    = 'row_' + String(result.rowIndex);
          delete rowNode.data._local_id;
        }
        console.log('[Grid] queued save — sheet row:', result.rowIndex || '(pending sync)');
      });
    }
  }

  // ══════════════════════════════════════════════════════════
  // TOOLBAR
  // ══════════════════════════════════════════════════════════

  function _renderToolbar(role) {
    var el = document.getElementById('toolbar-actions');
    if (!el) return;

    var buttons = [
      '<button class="tb-btn tb-btn--primary" id="tb-add-row">+ New Row</button>',
      '<button class="tb-btn" id="tb-refresh">&#8635; Refresh</button>',
      '<button class="tb-btn" id="tb-export">Export</button>',
    ];

    if (role === 'invoicing' || role === 'manager') {
      buttons.push('<button class="tb-btn" id="tb-reconcile">Reconcile</button>');
    }
    if (role === 'manager') {
      buttons.push('<button class="tb-btn tb-btn--danger" id="tb-manager">&#9881; Manager</button>');
    }

    el.innerHTML = buttons.join('');

    // ── Add Row ──────────────────────────────────────────────
    var addBtn = document.getElementById('tb-add-row');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        var newRow = {};

        // Coordinator auto-stamp: set silently on row creation.
        // The coordinator_name column is hidden for coordinator role,
        // so the user never sees or types this — it's transparent.
        if (_role === 'coordinator') {
          newRow.coordinator_name = _userName;
        }

        _allData.push(newRow);
        _gridApi.applyTransaction({ add: [newRow] });
        _updateRowCount(_allData.length);

        var lastIdx = _gridApi.getDisplayedRowCount() - 1;
        if (lastIdx >= 0) {
          _gridApi.ensureIndexVisible(lastIdx);
          _gridApi.startEditingCell({ rowIndex: lastIdx, colKey: 'job_code' });
        }
      });
    }

    // ── Refresh ──────────────────────────────────────────────
    var refreshBtn = document.getElementById('tb-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        _doRefresh(refreshBtn);
      });
    }
  }

  function _doRefresh(btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = 'Syncing…'; }
    var restore = function () {
      if (btn) { btn.disabled = false; btn.innerHTML = '&#8635; Refresh'; }
    };

    if (typeof Sheets === 'undefined') { restore(); return; }

    Sheets.fetchAllRows(function (result) {
      restore();
      if (!result.success) {
        console.error('[Grid] refresh failed:', result.error);
        return;
      }

      if (typeof Sync !== 'undefined') Sync.setLastSyncTime(result.serverTime);

      if (typeof Db !== 'undefined') {
        Db.init().then(function () {
          return Db.clearRows();
        }).then(function () {
          return Db.loadAllRows(result.rows);
        }).then(function () {
          // Re-inject pending new rows (created offline, not yet synced)
          return Db.query("SELECT payload FROM pending_queue WHERE action = 'save'");
        }).then(function (pending) {
          var pendingNew = [];
          pending.forEach(function (p) {
            try {
              var r = JSON.parse(p.payload);
              if (r && !r._row_index) pendingNew.push(r);
            } catch (_) {}
          });
          loadData(result.rows.concat(pendingNew));
        }).catch(function () {
          loadData(result.rows);
        });
      } else {
        loadData(result.rows);
      }
    });
  }

  // ══════════════════════════════════════════════════════════
  // CONTAINER SIZING
  // ══════════════════════════════════════════════════════════

  function _fitContainer() {
    var container   = document.getElementById('grid-container');
    var header      = document.getElementById('app-header');
    var filterPanel = document.getElementById('filter-panel');
    var statusbar   = document.getElementById('app-statusbar');
    if (!container) return;

    var usedH = (header      ? header.offsetHeight      : 48)
              + (filterPanel ? filterPanel.offsetHeight : 34)
              + (statusbar   ? statusbar.offsetHeight   : 28);
    container.style.height = (window.innerHeight - usedH) + 'px';
  }

  // ══════════════════════════════════════════════════════════
  // STATUS BAR
  // ══════════════════════════════════════════════════════════

  function _updateRowCount(visible) {
    var el = document.getElementById('row-count');
    if (!el) return;
    var total = _allData.length;
    if (total && visible < total) {
      el.textContent = visible + ' of ' + total + ' rows';
    } else {
      var n = total || visible;
      el.textContent = n + (n === 1 ? ' row' : ' rows');
    }
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: applyGlobalSearch  (kept for back-compat — no-op)
  // Session 4+: Filters.js handles all search via SQL.
  // ══════════════════════════════════════════════════════════

  function applyGlobalSearch(fn) {
    // Filters.js now drives search via Db.query() + applyFilteredData().
    // This stub keeps older callers from throwing.
    void fn;
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: applyFilteredData
  // Set the grid to the SQL-filtered result from Filters.js.
  // Does NOT touch DuckDB or rebuild _allData.
  // ══════════════════════════════════════════════════════════

  function applyFilteredData(rows, visibleCount) {
    if (!_gridApi) return;
    _gridApi.setGridOption('rowData', rows || []);
    _updateRowCount(visibleCount !== undefined ? visibleCount : (rows || []).length);
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: getAgFilterModel
  // Returns the current AG Grid column filter model object.
  // Filters.js calls this to know what conditions to translate to SQL.
  // ══════════════════════════════════════════════════════════

  function getAgFilterModel() {
    return _gridApi ? (_gridApi.getFilterModel() || {}) : {};
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: clearAgFilterModel
  // Clears all AG Grid column filters (fires onFilterChanged).
  // Filters.js calls this from its "Clear All" handler.
  // ══════════════════════════════════════════════════════════

  function clearAgFilterModel() {
    if (_gridApi) _gridApi.setFilterModel(null);
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: clearAllFilters
  // Legacy entry-point. Delegates to the SQL-driven path.
  // ══════════════════════════════════════════════════════════

  function clearAllFilters() {
    clearAgFilterModel();   // fires onFilterChanged → Filters re-runs SQL
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: highlightChange  (stub — Session 7)
  // ══════════════════════════════════════════════════════════

  function highlightChange(rowId) {
    // Amber row tint when a coordinator saves — implemented in Session 7
    void rowId;
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: updateRowIndex  (stub — Session 5)
  // ══════════════════════════════════════════════════════════

  function updateRowIndex(localId, rowIndex) {
    if (!_gridApi) return;
    _gridApi.forEachNode(function (node) {
      if (node.data && node.data._local_id === localId) {
        node.data._row_index = rowIndex;
        node.data._row_id    = 'row_' + String(rowIndex);
        delete node.data._local_id;
      }
    });
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: removeRow
  // ══════════════════════════════════════════════════════════

  function removeRow(physicalRowIndex) {
    if (!_gridApi || physicalRowIndex < 0 || physicalRowIndex >= _allData.length) return;
    var removed = _allData.splice(physicalRowIndex, 1)[0];
    if (removed) _gridApi.applyTransaction({ remove: [removed] });
    _updateRowCount(_allData.length);
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: refresh
  // ══════════════════════════════════════════════════════════

  function refresh() { _doRefresh(null); }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: getExportData
  // ══════════════════════════════════════════════════════════

  function getExportData() {
    var filteredRows = [];
    if (_gridApi) {
      _gridApi.forEachNodeAfterFilterAndSort(function (node) {
        if (node.data) filteredRows.push(node.data);
      });
    }
    return { allRows: _allData.slice(), filteredRows: filteredRows, columns: _visibleCols.slice() };
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: getVisibleTotals
  // ══════════════════════════════════════════════════════════

  function getVisibleTotals() {
    var result = { newTotal: 0, lmp: 0, contractor: 0 };
    if (!_gridApi) return result;
    _gridApi.forEachNodeAfterFilterAndSort(function (node) {
      if (!node.data) return;
      result.newTotal   += parseFloat(node.data.new_total_price)    || 0;
      result.lmp        += parseFloat(node.data.lmp_portion)        || 0;
      result.contractor += parseFloat(node.data.contractor_portion) || 0;
    });
    return result;
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: getVisibleColumns
  // ══════════════════════════════════════════════════════════

  function getVisibleColumns() { return _visibleCols.slice(); }

  // ══════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════

  function _isColReadOnly(col) {
    if (!col.readOnly) return false;
    return col.readOnly.indexOf(_role) !== -1;
  }

  // ══════════════════════════════════════════════════════════
  // STYLES
  // ══════════════════════════════════════════════════════════

  (function _injectStyles() {
    if (document.getElementById('grid-js-styles')) return;
    var s = document.createElement('style');
    s.id = 'grid-js-styles';
    s.textContent = [
      '#toolbar-actions{display:flex;align-items:center;gap:6px;margin-left:auto;padding-right:4px;}',
      '.tb-btn{height:30px;padding:0 14px;font-family:var(--font-display);font-weight:600;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;background:rgba(255,255,255,0.11);color:var(--text-on-navy);border:1px solid rgba(255,255,255,0.22);cursor:pointer;transition:background 0.15s,border-color 0.15s,color 0.15s;white-space:nowrap;}',
      '.tb-btn:hover{background:rgba(255,255,255,0.22);border-color:rgba(255,255,255,0.38);color:#fff;}',
      '.tb-btn:disabled{opacity:0.5;cursor:default;}',
      '.tb-btn--primary{background:var(--accent);color:#fff;border-color:var(--accent);}',
      '.tb-btn--primary:hover{background:var(--accent-bright);border-color:var(--accent-bright);}',
      '.tb-btn--danger{background:rgba(192,57,43,0.15);border-color:rgba(192,57,43,0.35);color:#f08070;}',
      '.tb-btn--danger:hover{background:rgba(192,57,43,0.28);}',
      '#grid-container{position:relative;flex:1;min-height:0;}',
      '.ag-header-cell-center .ag-header-cell-label{justify-content:center;}',
    ].join('\n');
    document.head.appendChild(s);
  }());

  // ══════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════

  return {
    init:               init,
    loadData:           loadData,
    applyDropdowns:     applyDropdowns,
    applyDelta:         applyDelta,
    highlightChange:    highlightChange,
    updateRowIndex:     updateRowIndex,
    removeRow:          removeRow,
    refresh:            refresh,
    getExportData:      getExportData,
    getVisibleTotals:   getVisibleTotals,
    applyGlobalSearch:  applyGlobalSearch,   // kept for back-compat; no-op
    applyFilteredData:  applyFilteredData,   // Session 4: Filters.js sets SQL results
    getAgFilterModel:   getAgFilterModel,    // Session 4: Filters.js reads filter state
    clearAgFilterModel: clearAgFilterModel,  // Session 4: Filters.js clears column filters
    clearAllFilters:    clearAllFilters,
    getVisibleColumns:  getVisibleColumns,
  };

}());
