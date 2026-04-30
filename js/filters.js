// ============================================================
// filters.js — Global search + column filters via SQL (Session 4)
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Inject global search bar into #global-search-wrap (header)
//   - Global search = SQL ILIKE across all visible text columns
//   - Column filters = translate AG Grid filter model to SQL WHERE
//   - Both compose via AND in a single DuckDB query
//   - Totals = SQL SUM(new_total_price / lmp_portion / contractor_portion)
//     recalculated against the SAME WHERE clause on every filter change
//   - Status panel shows active filter badges + live totals
//   - "Clear All" resets both search bar and AG Grid filter model
//
// No trimRows, no HOT plugin concepts.
//
// Data flow:
//   1. User types in search OR applies an AG Grid column filter
//   2. _applyFilters() builds a single SQL WHERE clause
//   3. Two parallel DuckDB queries: SELECT * (data) + SELECT SUM (totals)
//   4. Grid.applyFilteredData(rows) replaces the grid's row data
//   5. Totals + panel update immediately
//
// Depends on:
//   Db.query()  — DuckDB parameterised query
//   Grid.applyFilteredData() / getAgFilterModel() / clearAgFilterModel()
//   Grid.getVisibleColumns()
// ============================================================

var Filters = (function () {
  'use strict';

  // ══════════════════════════════════════════════════════════
  // STATE
  // ══════════════════════════════════════════════════════════

  var _role        = null;
  var _visibleCols = [];     // column defs for current role (from Grid)
  var _searchTerm  = '';     // current global search string
  var _debounce    = null;   // search input debounce timer
  var _queryGen    = 0;      // monotonic counter — stale async results are discarded
  var _totals      = { new_total: 0, lmp: 0, contractor: 0 };

  // ══════════════════════════════════════════════════════════
  // PUBLIC: init
  // ══════════════════════════════════════════════════════════

  /**
   * Called by app.js after Grid.init() so Grid.getVisibleColumns() is ready.
   */
  function init(role /*, name */) {
    _role        = role;
    _visibleCols = (typeof Grid !== 'undefined') ? Grid.getVisibleColumns() : [];

    _injectSearchBar();
    _injectStyles();
    _refreshPanel();
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: onColumnFilterChanged
  // Called by grid.js onFilterChanged event (AG Grid column filter changed).
  // ══════════════════════════════════════════════════════════

  function onColumnFilterChanged() {
    // AG Grid filter model just changed — run SQL with the new conditions.
    _applyFilters();
    _refreshPanel();
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC: onDataChanged
  // Called by grid.js after DuckDB loadAllRows() completes.
  // Re-runs any active filters against the freshly loaded data.
  // ══════════════════════════════════════════════════════════

  function onDataChanged() {
    _applyFilters();
    _refreshPanel();
  }

  // ══════════════════════════════════════════════════════════
  // CORE: _applyFilters
  // Builds one SQL WHERE clause from (global search + column filters),
  // runs data query + totals query in parallel, and feeds results back.
  // ══════════════════════════════════════════════════════════

  function _applyFilters() {
    var gen = ++_queryGen;   // stamp this request so stale callbacks self-discard

    if (typeof Db === 'undefined' || typeof Grid === 'undefined') return;

    var params     = [];
    var conditions = [];

    // ── 1. Global search — ILIKE across all visible text columns ─────
    var term = _searchTerm.trim();
    if (term) {
      var textCols = _visibleCols.filter(function (c) {
        return c.type !== 'numeric' && c.key !== '_price_indicator';
      });
      if (textCols.length) {
        var ilikeParts = textCols.map(function (c) {
          params.push('%' + term + '%');
          return 'CAST(' + c.key + ' AS TEXT) ILIKE ?';
        });
        conditions.push('(' + ilikeParts.join(' OR ') + ')');
      }
    }

    // ── 2. Column filters — AG Grid filter model → SQL WHERE ─────────
    var colModel = Grid.getAgFilterModel() || {};
    var colConditions = _filterModelToSQL(colModel, params);
    conditions = conditions.concat(colConditions);

    // ── 3. Compose WHERE clause ─────────────────────────────────────
    // Always exclude soft-deleted rows.
    var where = conditions.length
      ? 'WHERE _is_deleted = false AND ' + conditions.join(' AND ')
      : 'WHERE _is_deleted = false';

    var dataSql   = 'SELECT * FROM rows ' + where;
    var totalsSql =
      'SELECT ' +
      'COALESCE(SUM(CAST(new_total_price AS DOUBLE)), 0) AS new_total, ' +
      'COALESCE(SUM(CAST(lmp_portion AS DOUBLE)), 0) AS lmp, ' +
      'COALESCE(SUM(CAST(contractor_portion AS DOUBLE)), 0) AS contractor ' +
      'FROM rows ' + where;

    // Identical param arrays for data and totals (same WHERE clause)
    var dataParams   = params.slice();
    var totalsParams = params.slice();

    // ── 4. Run both queries in parallel ──────────────────────────────
    Db.init().then(function () {
      return Promise.all([
        Db.query(dataSql,   dataParams),
        Db.query(totalsSql, totalsParams),
      ]);
    }).then(function (results) {
      // Discard stale result if a newer query has already been started
      if (gen !== _queryGen) return;

      var rows         = results[0] || [];
      var totalsResult = (results[1] || [])[0] || {};

      _totals = {
        new_total:   parseFloat(totalsResult.new_total)   || 0,
        lmp:         parseFloat(totalsResult.lmp)         || 0,
        contractor:  parseFloat(totalsResult.contractor)  || 0,
      };

      // Feed filtered rows to grid (replaces rowData without touching DuckDB)
      Grid.applyFilteredData(rows, rows.length);

      // Update status bar row count and filter panel totals
      _refreshPanel();

    }).catch(function (e) {
      if (gen !== _queryGen) return;
      console.error('[Filters] SQL query failed:', e.message || e);
    });
  }

  // ══════════════════════════════════════════════════════════
  // FILTER MODEL → SQL TRANSLATOR
  // ══════════════════════════════════════════════════════════

  /**
   * Convert an AG Grid column filter model to an array of SQL WHERE fragments.
   * Each fragment is appended to the outer AND chain.
   * Positional parameters are pushed into the `params` array.
   */
  function _filterModelToSQL(model, params) {
    if (!model || typeof model !== 'object') return [];
    var conditions = [];

    Object.keys(model).forEach(function (field) {
      var filter = model[field];
      if (!filter) return;

      // Find the column's type so we know how to cast in SQL
      var colDef = null;
      for (var i = 0; i < _visibleCols.length; i++) {
        if (_visibleCols[i].key === field) { colDef = _visibleCols[i]; break; }
      }
      var colType = colDef ? colDef.type : 'text';

      var clause = _singleFilterToSQL(field, filter, colType, params);
      if (clause) conditions.push(clause);
    });

    return conditions;
  }

  /**
   * Handle one column's filter entry.
   * AG Grid may give us a single condition OR a combined (operator: AND/OR).
   */
  function _singleFilterToSQL(field, filter, colType, params) {
    // Combined condition: { operator:'AND'|'OR', condition1:{...}, condition2:{...} }
    if (filter.operator && filter.condition1) {
      var c1 = _conditionToSQL(field, filter.condition1, colType, params);
      var c2 = _conditionToSQL(field, filter.condition2, colType, params);
      if (!c1 && !c2) return '';
      if (!c1) return c2;
      if (!c2) return c1;
      return '(' + c1 + ' ' + filter.operator + ' ' + c2 + ')';
    }
    return _conditionToSQL(field, filter, colType, params);
  }

  /**
   * Convert a single AG Grid filter condition to a SQL fragment.
   * AG Grid filter types: text → contains/equals/startsWith/endsWith/blank/notBlank
   *                       number → equals/notEqual/greaterThan/lessThan/inRange/blank
   *                       date → equals/before/after/inRange/blank
   */
  function _conditionToSQL(field, cond, colType, params) {
    if (!cond || !cond.type) return '';

    var type = cond.type;
    var val  = cond.filter;
    var val2 = cond.filterTo;

    // ── Date conditions ──────────────────────────────────────
    // Dates are stored as DD-MMM-YYYY text; filter values arrive as YYYY-MM-DD.
    if (colType === 'date') {
      // dateFrom / dateTo used by agDateColumnFilter (not filter / filterTo)
      var dateFrom = cond.dateFrom || val;
      var dateTo   = cond.dateTo   || val2;
      var parsedCol = "TRY_STRPTIME(CAST(" + field + " AS TEXT), '%d-%b-%Y')";
      var fmtParam  = "'%Y-%m-%d'";

      switch (type) {
        case 'equals':
          if (!dateFrom) return '';
          params.push(String(dateFrom));
          return parsedCol + " = TRY_STRPTIME(?, " + fmtParam + ")";
        case 'notEqual':
          if (!dateFrom) return '';
          params.push(String(dateFrom));
          return '(' + parsedCol + " != TRY_STRPTIME(?, " + fmtParam + ") OR " + field + " IS NULL)";
        case 'before':
        case 'lessThan':
          if (!dateFrom) return '';
          params.push(String(dateFrom));
          return parsedCol + " < TRY_STRPTIME(?, " + fmtParam + ")";
        case 'after':
        case 'greaterThan':
          if (!dateFrom) return '';
          params.push(String(dateFrom));
          return parsedCol + " > TRY_STRPTIME(?, " + fmtParam + ")";
        case 'inRange':
          var parts = [];
          if (dateFrom) {
            params.push(String(dateFrom));
            parts.push(parsedCol + " >= TRY_STRPTIME(?, " + fmtParam + ")");
          }
          if (dateTo) {
            params.push(String(dateTo));
            parts.push(parsedCol + " <= TRY_STRPTIME(?, " + fmtParam + ")");
          }
          return parts.join(' AND ');
        case 'blank':
          return '(' + field + " IS NULL OR TRIM(CAST(" + field + " AS TEXT)) = '')";
        case 'notBlank':
          return '(' + field + " IS NOT NULL AND TRIM(CAST(" + field + " AS TEXT)) != '')";
        default:
          return '';
      }
    }

    // ── Number conditions ─────────────────────────────────────
    if (colType === 'numeric') {
      if (type === 'blank')    return '(' + field + ' IS NULL)';
      if (type === 'notBlank') return '(' + field + ' IS NOT NULL)';
      if (type === 'inRange') {
        var numParts = [];
        if (val !== null && val !== undefined && val !== '') {
          params.push(parseFloat(val));
          numParts.push(field + ' >= ?');
        }
        if (val2 !== null && val2 !== undefined && val2 !== '') {
          params.push(parseFloat(val2));
          numParts.push(field + ' <= ?');
        }
        return numParts.join(' AND ');
      }
      if (val === null || val === undefined || val === '') return '';
      var numVal = parseFloat(val);
      if (isNaN(numVal)) return '';
      switch (type) {
        case 'equals':            params.push(numVal); return field + ' = ?';
        case 'notEqual':          params.push(numVal); return '(' + field + ' != ? OR ' + field + ' IS NULL)';
        case 'greaterThan':       params.push(numVal); return field + ' > ?';
        case 'greaterThanOrEqual':params.push(numVal); return field + ' >= ?';
        case 'lessThan':          params.push(numVal); return field + ' < ?';
        case 'lessThanOrEqual':   params.push(numVal); return field + ' <= ?';
        default: return '';
      }
    }

    // ── Text conditions (text, dropdown, and everything else) ─
    if (type === 'blank')    return '(' + field + " IS NULL OR TRIM(CAST(" + field + " AS TEXT)) = '')";
    if (type === 'notBlank') return '(' + field + " IS NOT NULL AND TRIM(CAST(" + field + " AS TEXT)) != '')";

    if (val === null || val === undefined || val === '') return '';
    var strVal = String(val);

    switch (type) {
      case 'contains':
        params.push('%' + strVal + '%');
        return 'CAST(' + field + ' AS TEXT) ILIKE ?';
      case 'notContains':
        params.push('%' + strVal + '%');
        return '(CAST(' + field + ' AS TEXT) NOT ILIKE ? OR ' + field + ' IS NULL)';
      case 'equals':
        params.push(strVal);
        return 'CAST(' + field + ' AS TEXT) ILIKE ?';
      case 'notEqual':
        params.push(strVal);
        return '(CAST(' + field + ' AS TEXT) NOT ILIKE ? OR ' + field + ' IS NULL)';
      case 'startsWith':
        params.push(strVal + '%');
        return 'CAST(' + field + ' AS TEXT) ILIKE ?';
      case 'endsWith':
        params.push('%' + strVal);
        return 'CAST(' + field + ' AS TEXT) ILIKE ?';
      default:
        return '';
    }
  }

  // ══════════════════════════════════════════════════════════
  // SEARCH BAR
  // ══════════════════════════════════════════════════════════

  function _injectSearchBar() {
    var wrap = document.getElementById('global-search-wrap');
    if (!wrap) return;

    wrap.innerHTML = [
      '<div class="gs-wrap">',
        '<span class="gs-icon" aria-hidden="true">&#128269;</span>',
        '<input',
          ' id="gs-input"',
          ' class="gs-input"',
          ' type="text"',
          ' placeholder="Search all records…"',
          ' autocomplete="off"',
          ' spellcheck="false"',
          ' aria-label="Global search">',
        '<button',
          ' id="gs-clear"',
          ' class="gs-clear"',
          ' hidden',
          ' aria-label="Clear search">',
          '&times;',
        '</button>',
      '</div>',
    ].join('');

    var input    = document.getElementById('gs-input');
    var clearBtn = document.getElementById('gs-clear');

    if (input) {
      input.addEventListener('input', function (e) {
        _searchTerm = e.target.value;
        _toggleClearBtn(clearBtn, !!_searchTerm);
        _scheduleSearch();
      });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') _clearSearch(input, clearBtn);
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        _clearSearch(input, clearBtn);
        if (input) input.focus();
      });
    }
  }

  // ── Debounced search — live-as-you-type, 140 ms delay ─────
  function _scheduleSearch() {
    clearTimeout(_debounce);
    _debounce = setTimeout(function () {
      _applyFilters();
      _refreshPanel();
    }, 140);
  }

  function _clearSearch(input, clearBtn) {
    _searchTerm = '';
    if (input) input.value = '';
    _toggleClearBtn(clearBtn, false);
    _applyFilters();
    _refreshPanel();
  }

  function _toggleClearBtn(btn, show) {
    if (!btn) return;
    if (show) btn.removeAttribute('hidden');
    else      btn.setAttribute('hidden', '');
  }

  // ══════════════════════════════════════════════════════════
  // "CLEAR ALL" — wipes both search bar and AG Grid filter model
  // ══════════════════════════════════════════════════════════

  function _clearAllAndReset() {
    // 1. Clear search term FIRST so onColumnFilterChanged (fired synchronously
    //    by setFilterModel) already sees an empty _searchTerm.
    _searchTerm = '';
    var input    = document.getElementById('gs-input');
    var clearBtn = document.getElementById('gs-clear');
    if (input)    input.value = '';
    _toggleClearBtn(clearBtn, false);

    // 2. Clear AG Grid column filter model.
    //    This fires onFilterChanged → onColumnFilterChanged → _applyFilters()
    //    with empty conditions, so all rows are returned.
    if (typeof Grid !== 'undefined') Grid.clearAgFilterModel();

    // 3. If no column filters were active, onFilterChanged won't fire,
    //    so explicitly run the query to show all rows.
    _applyFilters();
    _refreshPanel();
  }

  // ══════════════════════════════════════════════════════════
  // TOTALS DISPLAY
  // ══════════════════════════════════════════════════════════

  function _formatNum(val) {
    var n = Math.round(parseFloat(val) || 0);
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function _buildTotalsHtml() {
    var showPortions = (_role === 'invoicing' || _role === 'manager');
    var html = '<div class="fp-totals">';

    html += '<span class="fp-total-item">';
    html += '<span class="fp-total-label">New Total</span>';
    html += '<span class="fp-total-val fp-total-val--primary">' +
            _formatNum(_totals.new_total) + ' EGP</span>';
    html += '</span>';

    if (showPortions) {
      html += '<span class="fp-total-sep">|</span>';
      html += '<span class="fp-total-item">';
      html += '<span class="fp-total-label">LMP</span>';
      html += '<span class="fp-total-val">' + _formatNum(_totals.lmp) + ' EGP</span>';
      html += '</span>';

      html += '<span class="fp-total-sep">|</span>';
      html += '<span class="fp-total-item">';
      html += '<span class="fp-total-label">Contractor</span>';
      html += '<span class="fp-total-val">' + _formatNum(_totals.contractor) + ' EGP</span>';
      html += '</span>';
    }

    html += '</div>';
    return html;
  }

  // ══════════════════════════════════════════════════════════
  // FILTER STATUS PANEL
  // ══════════════════════════════════════════════════════════

  function _refreshPanel() {
    var panel = document.getElementById('filter-panel');
    if (!panel) return;

    // Preserve the theme dropdown anchor if it lives inside the panel
    var themeAnchor = document.getElementById('theme-dropdown-anchor');
    if (themeAnchor && themeAnchor.parentNode === panel) {
      panel.removeChild(themeAnchor);
    }

    var term          = _searchTerm.trim();
    var colModel      = (typeof Grid !== 'undefined') ? (Grid.getAgFilterModel() || {}) : {};
    var colFilterCount = Object.keys(colModel).length;
    var hasSearch     = !!term;
    var hasColFilter  = colFilterCount > 0;
    var hasAny        = hasSearch || hasColFilter;
    var totalsHtml    = _buildTotalsHtml();

    // ── Idle state ────────────────────────────────────────────
    if (!hasAny) {
      panel.innerHTML = [
        '<div class="fp-inner fp-inner--idle">',
          '<span class="fp-idle-dot" aria-hidden="true">&#9679;</span>',
          '<span class="fp-label">Active Filters</span>',
          '<span class="fp-idle-text">&#8212; none</span>',
          totalsHtml,
        '</div>',
      ].join('');
      if (themeAnchor) panel.appendChild(themeAnchor);
      return;
    }

    // ── Active state — build filter badges ────────────────────
    var parts = [];

    if (hasSearch) {
      parts.push(
        '<span class="fp-badge fp-badge--search">' +
          '<span class="fp-badge-label">Search</span>' +
          '<span class="fp-badge-value">“' + _esc(term) + '”</span>' +
          '<button class="fp-badge-remove" data-type="search" aria-label="Clear search">&times;</button>' +
        '</span>'
      );
    }

    if (hasColFilter) {
      parts.push(
        '<span class="fp-badge fp-badge--col">' +
          '<span class="fp-badge-label">' +
            colFilterCount + ' column ' + (colFilterCount === 1 ? 'filter' : 'filters') +
          '</span>' +
          '<button class="fp-badge-remove" data-type="col" aria-label="Clear column filters">&times;</button>' +
        '</span>'
      );
    }

    panel.innerHTML = [
      '<div class="fp-inner">',
        '<span class="fp-active-dot" aria-hidden="true">&#9679;</span>',
        '<span class="fp-label">Active Filters:</span>',
        '<span class="fp-badges">', parts.join(''), '</span>',
        totalsHtml,
        '<button class="fp-clear-all" id="fp-clear-all">Clear All</button>',
      '</div>',
    ].join('');

    if (themeAnchor) panel.appendChild(themeAnchor);

    // ── Wire badge remove buttons ─────────────────────────────
    panel.querySelectorAll('.fp-badge-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.getAttribute('data-type');

        if (type === 'search') {
          var input    = document.getElementById('gs-input');
          var clearBtn = document.getElementById('gs-clear');
          _searchTerm = '';
          if (input) input.value = '';
          _toggleClearBtn(clearBtn, false);
          _applyFilters();
          _refreshPanel();
          return;
        }

        if (type === 'col') {
          // Clear only column filters; keep search term active.
          if (typeof Grid !== 'undefined') Grid.clearAgFilterModel();
          // onFilterChanged fires → onColumnFilterChanged → _applyFilters
          // which picks up the still-active _searchTerm.
          _refreshPanel();
        }
      });
    });

    // ── Wire Clear All button ─────────────────────────────────
    var clearAllBtn = document.getElementById('fp-clear-all');
    if (clearAllBtn) clearAllBtn.addEventListener('click', _clearAllAndReset);
  }

  // ══════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ══════════════════════════════════════════════════════════
  // STYLES — injected once on init
  // ══════════════════════════════════════════════════════════

  function _injectStyles() {
    if (document.getElementById('filters-styles')) return;
    var s = document.createElement('style');
    s.id  = 'filters-styles';

    s.textContent = [
      // Search bar
      '#global-search-wrap{flex:1;min-width:0;max-width:340px;margin:0 12px;}',
      '.gs-wrap{position:relative;display:flex;align-items:center;height:30px;background:rgba(255,255,255,0.06);border:1px solid var(--border-navy);transition:border-color 0.15s,background 0.15s;}',
      '.gs-wrap:focus-within{border-color:var(--accent);background:rgba(255,255,255,0.10);}',
      '.gs-icon{position:absolute;left:8px;font-size:13px;color:var(--text-muted-navy);pointer-events:none;line-height:1;top:50%;transform:translateY(-50%);}',
      '.gs-input{width:100%;height:100%;padding:0 28px 0 28px;background:transparent;border:none;outline:none;font-family:var(--font-body);font-size:12px;color:var(--text-on-navy);letter-spacing:0.02em;}',
      '.gs-input::placeholder{color:var(--text-muted-navy);font-style:italic;}',
      '.gs-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:transparent;border:none;color:var(--text-muted-navy);font-size:16px;line-height:1;cursor:pointer;padding:0 2px;transition:color 0.15s;}',
      '.gs-clear:hover{color:var(--text-on-navy);}',

      // Filter panel ribbon
      '#filter-panel{height:34px;flex-shrink:0;border-bottom:2px solid var(--border);background:var(--bg-base);display:flex;align-items:center;overflow:visible;position:relative;}',
      '.fp-inner{display:flex;align-items:center;gap:10px;padding:0 16px;width:100%;height:100%;}',
      '.fp-idle-dot{font-size:7px;color:var(--border);line-height:1;flex-shrink:0;}',
      '.fp-idle-text{font-family:var(--font-body);font-size:11px;font-style:italic;color:var(--text-secondary);opacity:0.6;}',
      '.fp-active-dot{font-size:8px;color:var(--accent);line-height:1;flex-shrink:0;}',
      '.fp-label{font-family:var(--font-display);font-weight:600;font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-secondary);white-space:nowrap;flex-shrink:0;}',
      '.fp-badges{display:flex;align-items:center;gap:6px;flex:1;overflow:hidden;}',
      '.fp-badge{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 6px 0 8px;border:1px solid var(--border);background:var(--bg-base);white-space:nowrap;flex-shrink:0;}',
      '.fp-badge--search{border-color:rgba(201,151,58,0.4);background:rgba(201,151,58,0.06);}',
      '.fp-badge--col{border-color:rgba(46,140,200,0.4);background:rgba(46,140,200,0.06);}',
      '.fp-badge-label{font-family:var(--font-mono);font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-secondary);}',
      '.fp-badge-value{font-family:var(--font-body);font-size:11px;color:var(--text-primary);font-style:italic;}',
      '.fp-badge-remove{background:transparent;border:none;color:var(--text-secondary);font-size:14px;line-height:1;cursor:pointer;padding:0 1px;transition:color 0.12s;margin-left:2px;}',
      '.fp-badge-remove:hover{color:var(--color-error);}',

      // Totals
      '.fp-totals{display:flex;align-items:center;gap:10px;margin-left:auto;padding-left:16px;border-left:1px solid var(--border);flex-shrink:0;}',
      '.fp-total-item{display:flex;align-items:center;gap:6px;}',
      '.fp-total-label{font-family:var(--font-mono);font-size:9px;letter-spacing:0.12em;text-transform:uppercase;color:var(--text-secondary);white-space:nowrap;}',
      '.fp-total-val{font-family:var(--font-mono);font-size:11px;font-weight:600;color:var(--text-primary);letter-spacing:0.02em;white-space:nowrap;}',
      '.fp-total-val--primary{color:var(--accent);}',
      '.fp-total-sep{color:var(--border);font-size:12px;flex-shrink:0;user-select:none;}',

      // Clear All button
      '.fp-clear-all{margin-left:12px;height:24px;padding:0 12px;background:transparent;border:1px solid var(--border);font-family:var(--font-display);font-weight:600;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:var(--text-secondary);cursor:pointer;white-space:nowrap;flex-shrink:0;transition:background 0.12s,color 0.12s;}',
      '.fp-clear-all:hover{background:var(--bg-base);color:var(--color-error);border-color:rgba(192,57,43,0.4);}',

      // AG Grid column filter icon tinting (active column gets gold menu icon)
      '.ag-theme-alpine .ag-header-cell.ag-column-filtered .ag-header-icon{color:var(--accent)!important;}',
      '.ag-theme-alpine .ag-header-cell.ag-column-filtered .ag-header-menu-icon{color:var(--accent)!important;}',
    ].join('\n');

    document.head.appendChild(s);
  }

  // ══════════════════════════════════════════════════════════
  // PUBLIC API
  // ══════════════════════════════════════════════════════════

  return {
    init:                  init,
    onColumnFilterChanged: onColumnFilterChanged,
    onDataChanged:         onDataChanged,
  };

}());
