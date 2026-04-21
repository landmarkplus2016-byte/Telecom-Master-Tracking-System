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
    { key: 'new_price',                  label: 'New Price (EGP)',           width: 120, type: 'numeric',  numericFormat: { pattern: '0,0.00' }, readOnly: ['coordinator', 'invoicing'] },
    { key: 'new_total_price',            label: 'New Total Price (EGP)',     width: 150, type: 'numeric',  numericFormat: { pattern: '0,0.00' }, readOnly: ['coordinator', 'invoicing'] },
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
    { key: 'lmp_portion',                label: 'LMP Portion (EGP)',         width: 130, type: 'numeric',  numericFormat: { pattern: '0,0.00' }, readOnly: ['coordinator', 'invoicing'], roles: ['invoicing', 'manager'] },
    { key: 'contractor_portion',         label: 'Contractor Portion (EGP)',  width: 165, type: 'numeric',  numericFormat: { pattern: '0,0.00' }, readOnly: ['coordinator', 'invoicing'], roles: ['invoicing', 'manager'] },
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
  var _data            = [];     // rows currently loaded into HOT (may be global-search-filtered)
  var _allData         = [];     // complete unfiltered dataset — global search filters against this
  var _globalSearchFn  = null;   // predicate fn for global search, or null when inactive
  var _savePending     = {};     // rowIdx → setTimeout handle (debounce per row)
  var _dropdownSources = {};     // { field_key: [option, ...] } — merged from DROPDOWN_DEFAULTS + Config
  var _lockedRows           = {};     // { physicalRowIndex: true } — built in loadData for coordinator role
  var _jcErrors             = {};     // { physicalRowIndex: true } — rows with a JC conflict; drives red highlight
  var _changedRows          = {};     // { physicalRowIndex: timerId } — manager: coordinator just saved this row
  var _savedFilterConditions = [];    // last conditionsStack from afterFilter — restored after any loadData call

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
    // Filter out rows with no meaningful data (e.g. sheet rows that contain
    // only last_modified/created_date timestamps but no actual field values).
    // These can accumulate in IDB from previous fetches before the server-side
    // fix, and should never appear in the grid.
    var filtered = (rows || []).filter(function (r) {
      if (!r) return false;
      // Accept any row with at least one non-metadata field that has a value.
      // The server already runs hasMeaningfulData; this guards only against
      // null/empty IDB artifacts. Checking only id/job_code/task_name was too
      // strict — imported rows often lack id (not yet auto-generated).
      var keys = Object.keys(r);
      for (var fi = 0; fi < keys.length; fi++) {
        if (keys[fi].charAt(0) === '_') continue; // skip _row_index, _last_modified, etc.
        var v = r[keys[fi]];
        if (v !== '' && v !== null && v !== undefined) return true;
      }
      return false;
    });
    console.log('[grid.js] loadData() — rows:', filtered.length, '(filtered from', (rows || []).length + ')');
    _allData = filtered.slice();   // store complete copy for global search
    _data    = _globalSearchFn ? _allData.filter(_globalSearchFn) : filtered;

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
    _hotLoadData(_data);

    // Apply pricing calculations and indicators to every loaded row.
    // Pricing must be initialised (Pricing.init called) before loadData.
    // batch() suspends HOT rendering for the entire loop and does ONE render
    // at the end — without this, 6000+ rows × 4 setDataAtRowProp calls each
    // trigger a re-render, freezing the browser for several seconds.
    if (typeof Pricing !== 'undefined' && Pricing.isReady()) {
      _hot.batch(function () {
        for (var i = 0; i < _data.length; i++) {
          _applyPricing(i);
        }
      });
    }

    // Re-measure dimensions after data loads so stretchH:'all' and the
    // left-clone height both account for the scrollbars (which only appear
    // once there is enough data to require scrolling).
    setTimeout(function () {
      if (_hot) _hot.refreshDimensions();
      _fixLeftCloneHeight();
    }, 0);
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
        // Purge any stale empty rows that old alter() calls left in _data
        // but never synced to _allData. These cause phantom rows in filtered
        // views. Rebuild _data from _allData then reload HOT so column
        // conditions are re-applied before we insert the new row.
        var cleanData = _globalSearchFn
          ? _allData.filter(function(r) { return !r._row_index || _globalSearchFn(r); })
          : _allData.slice();
        if (cleanData.length !== _data.length) {
          _data = cleanData;
          _hotLoadData(_data);
        }

        // Use alter() so the new row is immediately visible even when a
        // column filter is active — alter() bypasses TrimRows, which is
        // intentional here so the user can start filling in the new row.
        var insertIdx = _hot.countRows();
        _hot.alter('insert_row_below', insertIdx);

        // Sync the row object HOT just created into _allData so it
        // survives any future applyGlobalSearch or applyDelta rebuild.
        var newRow = _hot.getSourceDataAtRow(insertIdx);
        if (newRow && _allData.indexOf(newRow) === -1) {
          _allData.push(newRow);
        }
        _hot.selectCell(insertIdx, 0);
        _updateRowCount(_hot.countRows());
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

  // ── Manual data refresh ──────────────────────────────────
  // Always does a full fetch from the server.
  // Manual Refresh = "give me the canonical truth" — it clears IDB first
  // so any rows deleted directly in Google Sheets are removed locally too.
  // Background/automatic sync uses delta sync (app.js _runDeltaSync).

  function _refreshData(btn) {
    if (btn) {
      btn.disabled    = true;
      btn.textContent = 'Syncing\u2026';
    }

    Sheets.fetchAllRows(function (result) {
      if (btn) { btn.disabled = false; btn.innerHTML = '&#8635; Refresh'; }
      if (!result.success) {
        console.error('[grid.js] refresh failed:', result.error);
        _showSaveError('Refresh failed: ' + result.error);
        return;
      }
      console.log('[grid.js] refresh — rows received:', result.rows.length);

      if (typeof Offline === 'undefined') {
        loadData(result.rows);
        return;
      }

      Offline.replaceAllRows(result.rows);
      Offline.setLastSyncTime(result.serverTime);

      // Re-inject pending new rows so they don't vanish from the grid.
      // New rows (no _row_index) live in the sync queue and haven't reached
      // the server yet — they must stay visible until the drain completes.
      // Updated rows (have _row_index) are already on the server so the
      // fetched copy is authoritative; we skip them here.
      Offline.getPendingQueue(function (queueEntries) {
        var pendingNew = queueEntries
          .filter(function (e) { return e.rowData && !e.rowData._row_index; })
          .map(function (e) { return e.rowData; });

        if (pendingNew.length) {
          console.log('[grid.js] refresh — re-injecting', pendingNew.length, 'pending new row(s) from queue');
        }

        loadData(result.rows.concat(pendingNew));
      });
    });
  }

  // ── Apply a delta of changed rows without a full reload ───
  //
  // Called after background sync and manual Refresh (delta path).
  // Updates existing rows in _data in-place and appends new ones.
  // Does NOT reset the scroll position — surgical re-render only.
  //
  // rows — array of row objects from fetchDelta, each with _row_index.

  function applyDelta(rows) {
    if (!rows || !rows.length || !_hot) return;

    // Same meaningful-data guard as loadData — drop rows with only metadata
    rows = rows.filter(function (r) {
      return r && (r.id || r.job_code || r.coordinator_name || r.task_name);
    });
    if (!rows.length) return;

    // Build fast lookup from _allData (the complete dataset, not the filtered view).
    // This ensures rows hidden by an active global search are still updated correctly.
    var idxMap = {};
    for (var i = 0; i < _allData.length; i++) {
      if (_allData[i] && _allData[i]._row_index) idxMap[_allData[i]._row_index] = i;
    }

    var hasNewRows = false;

    rows.forEach(function (incoming) {
      var dataPos = idxMap[incoming._row_index];
      if (dataPos !== undefined) {
        // Existing row — update in _allData in-place.
        // When no global search is active, _data shares the same object references
        // as _allData, so HOT sees the update on the next render() call.
        var target = _allData[dataPos];
        Object.keys(incoming).forEach(function (k) {
          target[k] = incoming[k];
        });
        _visibleCols.forEach(function (col) {
          if (col.type === 'date' && target[col.key]) {
            target[col.key] = _normalizeDate(target[col.key]);
          }
        });
      } else {
        // New row — normalize dates and append to _allData
        _visibleCols.forEach(function (col) {
          if (col.type === 'date' && incoming[col.key]) {
            incoming[col.key] = _normalizeDate(incoming[col.key]);
          }
        });
        _allData.push(incoming);
        hasNewRows = true;
      }
    });

    // When new rows arrive, re-derive _data from _allData to include (or exclude)
    // them correctly under any active global search filter.
    if (hasNewRows) {
      _data = _globalSearchFn
        ? _allData.filter(function (r) { return !r._row_index || _globalSearchFn(r); })
        : _allData.slice();
    }

    // Rebuild locked-row index for coordinator (lock status may have changed)
    if (_role === 'coordinator') {
      _lockedRows = {};
      _data.forEach(function (row, pos) {
        if (row && row._locked) _lockedRows[pos] = true;
      });
    }

    // Apply pricing to affected rows in the visible (_data) array
    if (typeof Pricing !== 'undefined' && Pricing.isReady()) {
      var pricingMap = {};
      for (var pi = 0; pi < _data.length; pi++) {
        if (_data[pi] && _data[pi]._row_index) pricingMap[String(_data[pi]._row_index)] = pi;
      }
      rows.forEach(function (r) {
        var pIdx = pricingMap[String(r._row_index)];
        if (pIdx !== undefined) _applyPricing(pIdx);
      });
    }

    if (hasNewRows) {
      _hotLoadData(_data);
      // afterFilter (fired inside _hotLoadData) already calls _updateRowCount
      // with the correct post-filter count. Do NOT call _updateRowCount here —
      // it would overwrite the filtered count (e.g. 3 rows) with _data.length
      // (e.g. 2538), producing a wrong "2538 of 6410" status when a column
      // filter is active.
    } else {
      _hot.render();
      // afterFilter fires via _hotLoadData (hasNewRows path) which already
      // notifies Filters. For the render-only path, notify explicitly so
      // the totals box reflects updated cell values.
      if (typeof Filters !== 'undefined') Filters.onDataChanged();
      // Render-only path: afterFilter doesn't fire, so update count manually.
      // When column filters are active, use _hot.countRows() (respects trimmed
      // rows); otherwise use _data.length which is always accurate here.
      var renderCount = (_savedFilterConditions && _savedFilterConditions.length)
        ? (_hot ? _hot.countRows() : _data.length)
        : _data.length;
      _updateRowCount(renderCount);
    }
  }

  // ── _hotLoadData — load data while preserving active column filters ──
  //
  // Uses updateData() instead of loadData() so HOT's Filters plugin is NOT
  // reset on every data change. Any active column conditions are automatically
  // re-applied by HOT to the new dataset, and afterFilter fires so the count
  // stays in sync. When no column conditions are active afterFilter does not
  // fire — update the count directly with data.length in that case.

  function _hotLoadData(data) {
    _hot.updateData(data);
    if (!_savedFilterConditions || !_savedFilterConditions.length) {
      _updateRowCount(data.length);
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
      rowHeights:                  24,
      autoRowSize:                 false,
      autoColumnSize:              false,
      renderAllRows:               false,
      viewportRowRenderingOffset:  10,
      minSpareRows:                0,
      licenseKey:         'non-commercial-and-evaluation',

      fixedColumnsLeft:   0,

      // ── Column filters ────────────────────────────────────
      // filters: true enables the Filters plugin.
      // dropdownMenu renders the ▼ arrow on every column header that opens
      // an Excel-style popover with condition + value filter options.
      filters:            true,
      dropdownMenu:       ['filter_by_condition', '---------', 'filter_by_value', '---------', 'filter_action_bar'],

      afterFilter: function (conditionsStack) {
        // Save a deep copy of the current filter state.
        // _hotLoadData reads this to re-apply conditions after every loadData call.
        _savedFilterConditions = JSON.parse(JSON.stringify(conditionsStack || []));
        // When conditions are empty (HOT cleared its filter during loadData or user
        // removed all filters), countRows may transiently return 0 — use _data.length
        // instead so the status bar never flickers to "0 rows" incorrectly.
        var visible = _hot ? _hot.countRows() : _data.length;
        if (!conditionsStack || !conditionsStack.length) visible = _data.length;
        _updateRowCount(visible);
        if (typeof Filters !== 'undefined') {
          Filters.onColumnFilterChanged(conditionsStack || []);
        }
      },

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
        if (!changes || source === 'loadData' || source === 'pricing' ||
            source === 'lock_revert' || source === 'jc_revert') return;

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

        // Tracks rows with a JC conflict in this batch — ALL changes for a
        // conflicting row must be skipped, not just the job_code change itself.
        // Using a set here because `return` inside forEach only exits that one
        // callback iteration; subsequent iterations for the same row would
        // otherwise re-add the row to dirtyRows and still trigger a save.
        var jcConflictRows = {};

        changes.forEach(function (change) {
          var rowIdx = change[0];
          var colKey = change[1]; // property name when columns use data:'key'

          // ── Skip entire row if it had a JC conflict earlier in this batch ──
          if (jcConflictRows[rowIdx]) return;

          // ── JC uniqueness check ──────────────────────────────
          // Fires whenever job_code changes (single edit or paste).
          // Scans _data for a row with the same JC on a different
          // Logical Site ID. On conflict: clears the field, marks the
          // physical row in _jcErrors (red highlight via cells callback),
          // and shows an inline error label below the cell.
          if (colKey === 'job_code') {
            var physRow = (_hot.toPhysicalRow) ? _hot.toPhysicalRow(rowIdx) : rowIdx;
            // Clear any prior error on this row
            delete _jcErrors[physRow];
            _clearJcErrorLabel(rowIdx);

            var newJC = String(change[3] || '').trim(); // change[3] = new value
            if (newJC) {
              var conflict = _findJcConflict(newJC, physRow);
              if (conflict) {
                // Clear the value before saving
                self.setDataAtRowProp(rowIdx, 'job_code', '', 'jc_revert');
                _jcErrors[physRow] = true;
                jcConflictRows[rowIdx] = true; // block all further changes for this row
                delete dirtyRows[rowIdx];      // ensure not in save queue
                _hot.render();
                var jcMsg = 'Job Code "' + newJC + '" is already assigned to site ' +
                  conflict.logicalSiteId + '.\nA Job Code can only belong to one site.';
                _showJcErrorLabel(
                  rowIdx,
                  _visibleCols.findIndex(function (c) { return c.key === 'job_code'; }),
                  jcMsg.replace('\n', ' ')
                );
                _showModal('Duplicate Job Code', jcMsg);
                return; // skip save + pricing for this change
              }
            }
          }

          // Row is clean — mark dirty so it gets saved
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
          if (dirtyRows[rowIdx]) _scheduleSave(parseInt(rowIdx, 10));
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

        // JC error: highlight only the job_code cell red
        if (colDef.key === 'job_code') {
          var physRow = (_hot && _hot.toPhysicalRow) ? _hot.toPhysicalRow(row) : row;
          if (_jcErrors[physRow]) {
            return { className: 'cell-jc-error' };
          }
        }

        // Change notification highlight (manager only): coordinator just saved this row
        var physRowC = (_hot && _hot.toPhysicalRow) ? _hot.toPhysicalRow(row) : row;
        if (_changedRows[physRowC] !== undefined) {
          var baseClass = _isColReadOnly(colDef, _role) ? 'cell-readonly ' : '';
          return { className: baseClass + 'row-changed' };
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
    var container   = document.getElementById('grid-container');
    var header      = document.getElementById('app-header');
    var filterPanel = document.getElementById('filter-panel');
    var statusbar   = document.getElementById('app-statusbar');
    if (!container) return;

    var usedHeight = (header      ? header.offsetHeight      : 48)
                   + (filterPanel ? filterPanel.offsetHeight : 34)
                   + (statusbar   ? statusbar.offsetHeight   : 28);
    var h = window.innerHeight - usedHeight;
    container.style.height = h + 'px';

    if (_hot) _hot.render();

    // Fix frozen-column clone height after every render.
    // HOT sets .ht_clone_left height = full container height via inline
    // style, unaware of the horizontal scrollbar occupying the bottom
    // N px. This makes the frozen columns extend below the last data row.
    // Defer to next tick so HOT finishes its own layout pass first.
    setTimeout(_fixLeftCloneHeight, 0);
  }

  function _fixLeftCloneHeight() {
    var container = document.getElementById('grid-container');
    if (!container) return;

    var leftClone    = container.querySelector('.ht_clone_left');
    var masterHolder = container.querySelector('.ht_master .wtHolder');
    if (!leftClone || !masterHolder) return;

    // Measure actual horizontal scrollbar height (0 when not visible)
    var hBarH = masterHolder.offsetHeight - masterHolder.clientHeight;
    if (hBarH <= 0) return;

    // HOT wrote an inline height — read it, subtract the scrollbar height
    var cloneH = parseInt(leftClone.style.height, 10);
    if (!cloneH || isNaN(cloneH)) return;

    var target = cloneH - hBarH;
    // Only write if different to avoid triggering another HOT render
    if (parseInt(leftClone.style.height, 10) !== target) {
      leftClone.style.height = target + 'px';
    }
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

    // Assign a stable local ID to new rows so Offline.queueSave can
    // deduplicate multiple offline edits to the same unsaved row.
    // Stored on _data[rowIdx] so it persists across debounce calls.
    if (!rowData._row_index) {
      if (!originalRow) _data[rowIdx] = originalRow = {};
      if (!originalRow._local_id) {
        originalRow._local_id = 'n' + Date.now() + '_' + rowIdx;
      }
      rowData._local_id = originalRow._local_id;
    }

    Offline.queueSave(rowData, function (result) {
      if (!result.success) {
        console.error('[grid.js] queueSave failed:', result.error);

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
      if (result.rowIndex) {
        _data[rowIdx]._row_index = result.rowIndex;
        delete _data[rowIdx]._local_id; // no longer needed once server-assigned
      }

      console.log('[grid.js] Row saved — sheet row:', result.rowIndex);
    });
  }

  // ── Change notification highlight (manager only) ─────────
  //
  // Called by Sheets._handleChanges() for each entry in the Changes tab.
  // Finds the row in _data whose `id` field matches rowId, marks it in
  // _changedRows, and schedules a 10-second auto-clear.
  // If no id match is found (row not yet in the local dataset), the call
  // is silently ignored — the next delta sync will bring the row in anyway.

  var CHANGE_HIGHLIGHT_MS = 10 * 1000; // how long the amber tint stays

  function highlightChange(rowId) {
    if (!_hot || !rowId) return;

    // Find the physical row index whose `id` matches rowId
    var targetPhys = -1;
    for (var i = 0; i < _data.length; i++) {
      if (_data[i] && String(_data[i].id || '').trim() === String(rowId).trim()) {
        targetPhys = i;
        break;
      }
    }

    if (targetPhys < 0) return; // row not in local data yet

    // Clear any existing timer for this row before resetting
    if (_changedRows[targetPhys] !== undefined) {
      clearTimeout(_changedRows[targetPhys]);
    }

    // Schedule auto-clear
    _changedRows[targetPhys] = setTimeout(function () {
      delete _changedRows[targetPhys];
      if (_hot) _hot.render();
    }, CHANGE_HIGHLIGHT_MS);

    _hot.render();
  }

  // ── Row index patch-up (called by offline.js after queue drain) ──

  /**
   * After draining a queued new-row save, offline.js calls this to
   * patch the server-assigned _row_index into the in-memory _data array.
   * Without this, the next user edit would attempt to create a duplicate row.
   *
   * localId  — the _local_id assigned by _saveRow at queue time
   * rowIndex — the _row_index assigned by the server
   */
  function updateRowIndex(localId, rowIndex) {
    for (var i = 0; i < _data.length; i++) {
      if (_data[i] && _data[i]._local_id === localId) {
        _data[i]._row_index = rowIndex;
        delete _data[i]._local_id;
        console.log('[grid.js] updateRowIndex — localId:', localId, '→ rowIndex:', rowIndex);
        break;
      }
    }
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

    // Delete only for coordinator (own rows) and manager.
    // Custom callback delegates to Delete.confirmDelete() instead of
    // using HOT's native row removal — ensures the confirmation modal
    // and soft-delete flow always run.
    if (_role === 'coordinator' || _role === 'manager') {
      items['separator2'] = Handsontable.plugins.ContextMenu.SEPARATOR;
      items['remove_row'] = {
        name: 'Delete row',
        callback: function (key, selection) {
          if (!selection || !selection.length) return;
          var visualRow = selection[0].start.row;
          var physRow   = _hot.toPhysicalRow(visualRow);
          if (physRow < 0 || physRow >= _data.length) return;
          if (typeof Delete !== 'undefined') {
            Delete.confirmDelete(_data[physRow], physRow);
          }
        }
      };
    }

    return { items: items };
  }

  // ── Status bar ────────────────────────────────────────────

  function _updateRowCount(visibleCount) {
    var el = document.getElementById('row-count');
    if (!el) return;
    var total = _allData.length;
    // Show "X of Y rows" when a filter is hiding some rows; plain "Y rows" otherwise.
    if (total && visibleCount < total) {
      el.textContent = visibleCount + ' of ' + total + ' rows';
    } else {
      var n = total || visibleCount;
      el.textContent = n + (n === 1 ? ' row' : ' rows');
    }
  }

  // ── JC uniqueness helpers ─────────────────────────────────

  /**
   * Scan _data for any row with the same job_code on a different
   * Logical Site ID than the row at physicalRowIndex.
   *
   * Returns { logicalSiteId } of the conflicting row, or null if no conflict.
   *
   * Stage 3 note: swap _data scan for an IndexedDB query here.
   */
  function _findJcConflict(jc, physicalRowIndex) {
    if (!jc) return null;
    var jcLower   = jc.toLowerCase();
    var ownSite   = String((_data[physicalRowIndex] || {}).logical_site_id || '').trim().toLowerCase();

    for (var i = 0; i < _data.length; i++) {
      if (i === physicalRowIndex) continue;
      var row    = _data[i];
      var rowJC  = String(row.job_code || '').trim().toLowerCase();
      if (rowJC !== jcLower) continue;

      var rowSite = String(row.logical_site_id || '').trim().toLowerCase();
      // Same JC, different site (or the existing row has a site and this row doesn't)
      if (rowSite !== ownSite) {
        return { logicalSiteId: String(row.logical_site_id || '').trim() || '(no site)' };
      }
    }
    return null;
  }

  /**
   * Show a small red error label positioned below the JC cell.
   * One label at a time — replaced on each call, cleared on next valid edit.
   */
  function _showJcErrorLabel(visualRow, colIndex, message) {
    _clearJcErrorLabel(); // remove any existing label first

    if (!_hot || colIndex < 0) return;

    var td = _hot.getCell(visualRow, colIndex);
    if (!td) return;

    var rect    = td.getBoundingClientRect();
    var container = document.getElementById('grid-container');
    var cRect   = container ? container.getBoundingClientRect() : { top: 0, left: 0 };

    var label = document.createElement('div');
    label.id  = 'jc-error-label';
    label.textContent = message;

    // Position relative to viewport
    label.style.cssText = [
      'position:fixed',
      'top:'  + (rect.bottom + 2) + 'px',
      'left:' + rect.left + 'px',
      'z-index:3000',
      'background:#c0392b',
      'color:#fff',
      'font-family:var(--font-body)',
      'font-size:11px',
      'padding:4px 10px',
      'pointer-events:none',
      'white-space:nowrap',
      'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
    ].join(';');

    document.body.appendChild(label);

    // Auto-remove after 6 seconds
    setTimeout(_clearJcErrorLabel, 6000);
  }

  function _clearJcErrorLabel() {
    var el = document.getElementById('jc-error-label');
    if (el) el.remove();
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
        'background: rgba(255,255,255,0.11);',
        'color: var(--text-on-navy);',
        'border: 1px solid rgba(255,255,255,0.22);',
        'cursor: pointer;',
        'transition: background 0.15s, border-color 0.15s, color 0.15s;',
        'white-space: nowrap;',
      '}',

      '.tb-btn:hover {',
        'background: rgba(255,255,255,0.22);',
        'border-color: rgba(255,255,255,0.38);',
        'color: #ffffff;',
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
      // overflow is intentionally NOT set here — #app-body clips the container
      // and overflow:hidden would clip HOT's own scrollbars on the right/bottom.
      '#grid-container {',
        'position: relative;',
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

      // Row number headers — navy to match column headers
      '.handsontable .rowHeader {',
        'background: var(--bg-navy) !important;',
        'color: var(--text-muted-navy) !important;',
        'font-family: var(--font-mono) !important;',
        'font-size: 10px !important;',
        'border-color: var(--border-navy) !important;',
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

      // Read-only cells — slightly distinct tint so non-editable columns are clear
      '.handsontable td.cell-readonly {',
        'background: #edf1f8 !important;',
        'color: var(--text-secondary) !important;',
      '}',

      // JC conflict — red cell background on the job_code cell
      '.handsontable td.cell-jc-error {',
        'background: rgba(192,57,43,0.12) !important;',
        'outline: 2px solid #c0392b !important;',
        'outline-offset: -2px;',
      '}',

      // Locked rows (coordinator view) — grey tint signals non-editable
      '.handsontable td.row-locked {',
        'background: #ebebef !important;',
        'color: #9898a8 !important;',
      '}',

      // Change notification (manager view) — coordinator just saved this row
      // Subtle amber left-border + very light amber tint; fades out after 10 s
      '.handsontable td.row-changed {',
        'background: rgba(201,151,58,0.07) !important;',
        'border-left: 2px solid var(--accent, #c9973a) !important;',
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

  /**
   * Immediately removes a row from the in-memory data and re-renders HOT.
   * Called by delete.js after a confirmed soft delete.
   * physicalRowIndex — index in the _data array (not the visual row).
   */
  function removeRow(physicalRowIndex) {
    if (!_hot || physicalRowIndex < 0 || physicalRowIndex >= _data.length) return;

    var removedRow = _data.splice(physicalRowIndex, 1)[0];

    // Also remove from _allData so the complete dataset stays in sync
    if (removedRow) {
      for (var i = 0; i < _allData.length; i++) {
        if (_allData[i] === removedRow ||
            (removedRow._row_index && _allData[i] && _allData[i]._row_index === removedRow._row_index)) {
          _allData.splice(i, 1);
          break;
        }
      }
    }

    // Rebuild lock index since physical positions shifted
    if (_role === 'coordinator') {
      _lockedRows = {};
      _data.forEach(function (row, idx) {
        if (row && row._locked) _lockedRows[idx] = true;
      });
    }

    _hotLoadData(_data);
    _updateRowCount(_hot ? _hot.countRows() : _data.length);
  }

  /**
   * Apply a global search predicate that pre-filters _allData before
   * HOT's own column filters run. Pass null to clear global search.
   * Called by js/filters.js on every search-input change.
   */
  function applyGlobalSearch(fn) {
    _globalSearchFn = fn || null;
    // Always include rows without _row_index — they are pending new rows
    // that haven't reached the server yet and must stay visible regardless
    // of what the search predicate returns on their empty fields.
    _data = _globalSearchFn
      ? _allData.filter(function (r) { return !r._row_index || _globalSearchFn(r); })
      : _allData.slice();

    if (_role === 'coordinator') {
      _lockedRows = {};
      _data.forEach(function (row, idx) {
        if (row && row._locked) _lockedRows[idx] = true;
      });
    }

    if (_hot) {
      _hotLoadData(_data);
    }
  }

  /**
   * Clear both global search and HOT column filters in one call.
   * Called by the filter panel's "Clear All" button via js/filters.js.
   */
  function clearAllFilters() {
    _savedFilterConditions = [];
    if (_hot) {
      var filtersPlugin = _hot.getPlugin('filters');
      if (filtersPlugin) {
        filtersPlugin.clearConditions();
        filtersPlugin.filter(); // fires afterFilter with [] → keeps _savedFilterConditions in sync
      }
    }
    applyGlobalSearch(null);
  }

  /**
   * Returns the visible column definitions for the current role.
   * Called by js/filters.js to know which columns to search across.
   */
  function getVisibleColumns() {
    return _visibleCols.slice();
  }

  /**
   * Full data refresh — re-fetches all rows from Apps Script,
   * replaces IDB cache, and reloads the grid.
   * Called by delete.js after Clear All Data.
   */
  function refresh() {
    _refreshData(null);
  }

  /**
   * Returns data for Excel export.
   *   allRows      — full _data array (role-filtered by server)
   *   filteredRows — rows currently visible in HOT (honours active column filters)
   *   columns      — visible column definitions for current role
   * Called by js/export.js.
   */
  /**
   * Sum new_total_price, lmp_portion, and contractor_portion for every row
   * currently visible in HOT (respects both global search and column filters).
   * Called by js/filters.js to display live totals in the filter ribbon.
   */
  function getVisibleTotals() {
    var result = { newTotal: 0, lmp: 0, contractor: 0 };
    if (!_hot) return result;
    var n = _hot.countRows();
    for (var i = 0; i < n; i++) {
      var phys = _hot.toPhysicalRow(i);
      var row  = _hot.getSourceDataAtRow(phys);
      if (!row) continue;
      result.newTotal   += parseFloat(row.new_total_price)    || 0;
      result.lmp        += parseFloat(row.lmp_portion)        || 0;
      result.contractor += parseFloat(row.contractor_portion) || 0;
    }
    return result;
  }

  function getExportData() {
    var filteredRows = [];
    if (_hot) {
      var count = _hot.countRows();
      for (var i = 0; i < count; i++) {
        var physIdx = _hot.toPhysicalRow(i);
        if (physIdx >= 0 && _data[physIdx]) filteredRows.push(_data[physIdx]);
      }
    } else {
      filteredRows = _data.slice();
    }
    return {
      allRows:      _data.slice(),
      filteredRows: filteredRows,
      columns:      _visibleCols.slice(),
    };
  }

  return {
    init:              init,
    loadData:          loadData,
    applyDropdowns:    applyDropdowns,
    applyDelta:        applyDelta,
    highlightChange:   highlightChange,
    updateRowIndex:    updateRowIndex,
    removeRow:         removeRow,
    refresh:           refresh,
    getExportData:     getExportData,
    getVisibleTotals:  getVisibleTotals,
    applyGlobalSearch: applyGlobalSearch,
    clearAllFilters:   clearAllFilters,
    getVisibleColumns: getVisibleColumns,
  };

}());
