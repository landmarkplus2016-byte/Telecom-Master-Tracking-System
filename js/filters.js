// ============================================================
// filters.js — Global search bar + column filter status panel
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Inject global search bar into #global-search-wrap (header)
//   - Live-filter grid rows across all visible columns (OR logic)
//   - Show active filter status strip in #filter-panel
//   - Wire #tb-filter button to toggle panel / clear filters
//   - Receive column-filter events from HOT's afterFilter hook
//     (grid.js calls Filters.onColumnFilterChanged on each change)
//
// Column filtering (per-column conditions: text, date, numeric,
// multi-value) is handled entirely by HOT's built-in Filters plugin.
// The ▼ arrow on every column header opens HOT's Excel-style popover.
// This file only tracks HOT's active filter count for the status panel.
//
// Filtering is entirely local — no Apps Script calls are made.
// Global search predicate is passed to Grid.applyGlobalSearch(fn).
//
// Depends on:
//   Grid.applyGlobalSearch / clearAllFilters / getVisibleColumns
// ============================================================

var Filters = (function () {

  // ── State ─────────────────────────────────────────────────

  var _role           = null;
  var _visibleCols    = [];   // column defs for current role (cached from Grid)
  var _searchTerm     = '';   // current global search string
  var _hotFilterCount = 0;    // number of HOT column conditions active
  var _debounce       = null; // search input debounce timer
  var _panelOpen      = false;

  // ── Public API ────────────────────────────────────────────

  /**
   * Called by app.js after Grid.init().
   * Injects the search bar and wires the Filter button.
   */
  function init(role, name) {
    _role        = role;
    _visibleCols = (typeof Grid !== 'undefined') ? Grid.getVisibleColumns() : [];

    _injectSearchBar();
    _injectStyles();
    _wireFilterBtn();
    _refreshPanel();   // render idle state immediately — no filter = no white gap
  }

  /**
   * Called by grid.js's HOT afterFilter hook whenever the user
   * changes a column filter via the ▼ dropdown.
   * conditionsStack — array of { column, conditions[] } from HOT.
   */
  function onColumnFilterChanged(conditionsStack) {
    _hotFilterCount = (conditionsStack || []).filter(function (c) {
      return c.conditions && c.conditions.length > 0;
    }).length;
    _refreshPanel();
    _refreshFilterBtn();
  }

  // ── Global search bar ─────────────────────────────────────

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
          ' placeholder="Search all records\u2026"',
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
      input.addEventListener('input', function () {
        _searchTerm = input.value;
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

  function _clearSearch(input, clearBtn) {
    _searchTerm = '';
    if (input) input.value = '';
    _toggleClearBtn(clearBtn, false);
    _applySearch();
  }

  function _toggleClearBtn(btn, show) {
    if (!btn) return;
    if (show) btn.removeAttribute('hidden');
    else       btn.setAttribute('hidden', '');
  }

  function _scheduleSearch() {
    if (_debounce) clearTimeout(_debounce);
    _debounce = setTimeout(_applySearch, 140);
  }

  function _applySearch() {
    var term = _searchTerm.trim().toLowerCase();

    if (!term) {
      if (typeof Grid !== 'undefined') Grid.applyGlobalSearch(null);
      _refreshPanel();
      _refreshFilterBtn();
      return;
    }

    // Columns to search across — exclude the synthetic price indicator
    var cols = _visibleCols.filter(function (c) {
      return c.key !== '_price_indicator';
    });

    if (typeof Grid !== 'undefined') {
      Grid.applyGlobalSearch(function (row) {
        for (var i = 0; i < cols.length; i++) {
          var val = String(row[cols[i].key] || '').toLowerCase();
          if (val.indexOf(term) !== -1) return true;
        }
        return false;
      });
    }

    _refreshPanel();
    _refreshFilterBtn();
  }

  // ── Filter button ─────────────────────────────────────────

  function _wireFilterBtn() {
    // #tb-filter is created by grid.js _renderToolbar before Filters.init runs
    var btn = document.getElementById('tb-filter');
    if (!btn) return;
    btn.addEventListener('click', _onFilterBtnClick);
  }

  function _onFilterBtnClick() {
    // Clicking the Filter button always focuses the search bar —
    // use the "Clear All" button in the filter panel to clear filters.
    var input = document.getElementById('gs-input');
    if (input) input.focus();
  }

  function _clearAllAndReset() {
    // Clear global search input
    var input    = document.getElementById('gs-input');
    var clearBtn = document.getElementById('gs-clear');
    _searchTerm = '';
    if (input) input.value = '';
    _toggleClearBtn(clearBtn, false);

    // Clear grid filters (HOT column filters + global search predicate)
    if (typeof Grid !== 'undefined') Grid.clearAllFilters();

    _hotFilterCount = 0;
    _refreshPanel();
    _refreshFilterBtn();
  }

  // ── Filter status panel ───────────────────────────────────

  function _refreshPanel() {
    var panel = document.getElementById('filter-panel');
    if (!panel) return;

    var term         = _searchTerm.trim();
    var hasSearch    = !!term;
    var hasColFilter = _hotFilterCount > 0;
    var hasAny       = hasSearch || hasColFilter;

    // ── Idle state — no active filters ────────────────────────
    if (!hasAny) {
      _panelOpen = false;
      panel.innerHTML = [
        '<div class="fp-inner fp-inner--idle">',
          '<span class="fp-idle-dot" aria-hidden="true">&#9679;</span>',
          '<span class="fp-label">Active Filters</span>',
          '<span class="fp-idle-text">&#8212; none</span>',
        '</div>',
      ].join('');
      return;
    }

    // ── Active state — build filter badges ────────────────────
    var parts = [];
    if (hasSearch) {
      parts.push(
        '<span class="fp-badge fp-badge--search">' +
          '<span class="fp-badge-label">Search</span>' +
          '<span class="fp-badge-value">\u201c' + _esc(term) + '\u201d</span>' +
          '<button class="fp-badge-remove" data-type="search" aria-label="Clear search">&times;</button>' +
        '</span>'
      );
    }
    if (hasColFilter) {
      parts.push(
        '<span class="fp-badge fp-badge--col">' +
          '<span class="fp-badge-label">' +
            _hotFilterCount + ' column ' + (_hotFilterCount === 1 ? 'filter' : 'filters') +
          '</span>' +
          '<button class="fp-badge-remove" data-type="col" aria-label="Clear column filters">&times;</button>' +
        '</span>'
      );
    }

    _panelOpen = true;

    panel.innerHTML = [
      '<div class="fp-inner">',
        '<span class="fp-active-dot" aria-hidden="true">&#9679;</span>',
        '<span class="fp-label">Active Filters:</span>',
        '<span class="fp-badges">', parts.join(''), '</span>',
        '<button class="fp-clear-all" id="fp-clear-all">Clear All</button>',
      '</div>',
    ].join('');

    // Wire individual badge remove buttons
    panel.querySelectorAll('.fp-badge-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.getAttribute('data-type');
        if (type === 'search') {
          var input    = document.getElementById('gs-input');
          var clearBtn = document.getElementById('gs-clear');
          _searchTerm = '';
          if (input) input.value = '';
          _toggleClearBtn(clearBtn, false);
          if (typeof Grid !== 'undefined') Grid.applyGlobalSearch(null);
          _refreshPanel();
          _refreshFilterBtn();
        } else if (type === 'col') {
          // Clear only HOT column filters — preserve active global search.
          var savedTerm = _searchTerm;
          _hotFilterCount = 0;
          if (typeof Grid !== 'undefined') {
            Grid.clearAllFilters();
            if (savedTerm.trim()) {
              _searchTerm = savedTerm;
              var input   = document.getElementById('gs-input');
              var gsClear = document.getElementById('gs-clear');
              if (input) input.value = savedTerm;
              _toggleClearBtn(gsClear, true);
              _applySearch();
              return;
            }
          }
          _refreshPanel();
          _refreshFilterBtn();
        }
      });
    });

    // Wire Clear All button
    var clearAllBtn = document.getElementById('fp-clear-all');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', _clearAllAndReset);
    }
  }

  function _refreshFilterBtn() {
    var btn = document.getElementById('tb-filter');
    if (!btn) return;

    var term  = _searchTerm.trim();
    var total = _hotFilterCount + (term ? 1 : 0);

    if (total > 0) {
      btn.innerHTML = '&#9660; Filter (' + total + ')';
      btn.title     = 'Filters active — use Clear All to remove';
    } else {
      btn.innerHTML = '&#9660; Filter';
      btn.title     = 'Filter rows';
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Styles ────────────────────────────────────────────────

  function _injectStyles() {
    if (document.getElementById('filters-styles')) return;
    var s   = document.createElement('style');
    s.id    = 'filters-styles';
    s.textContent = [

      // ── Global search bar ─────────────────────────────────
      '#global-search-wrap {',
        'flex: 1;',
        'min-width: 0;',
        'max-width: 340px;',
        'margin: 0 12px;',
      '}',

      '.gs-wrap {',
        'position: relative;',
        'display: flex;',
        'align-items: center;',
        'height: 30px;',
        'background: rgba(255,255,255,0.06);',
        'border: 1px solid var(--border-navy);',
        'transition: border-color 0.15s, background 0.15s;',
      '}',
      '.gs-wrap:focus-within {',
        'border-color: var(--accent);',
        'background: rgba(255,255,255,0.10);',
      '}',

      '.gs-icon {',
        'position: absolute;',
        'left: 8px;',
        'font-size: 13px;',
        'color: var(--text-muted-navy);',
        'pointer-events: none;',
        'line-height: 1;',
        'top: 50%;',
        'transform: translateY(-50%);',
      '}',

      '.gs-input {',
        'width: 100%;',
        'height: 100%;',
        'padding: 0 28px 0 28px;',
        'background: transparent;',
        'border: none;',
        'outline: none;',
        'font-family: var(--font-body);',
        'font-size: 12px;',
        'color: var(--text-on-navy);',
        'letter-spacing: 0.02em;',
      '}',
      '.gs-input::placeholder {',
        'color: var(--text-muted-navy);',
        'font-style: italic;',
      '}',

      '.gs-clear {',
        'position: absolute;',
        'right: 6px;',
        'top: 50%;',
        'transform: translateY(-50%);',
        'background: transparent;',
        'border: none;',
        'color: var(--text-muted-navy);',
        'font-size: 16px;',
        'line-height: 1;',
        'cursor: pointer;',
        'padding: 0 2px;',
        'transition: color 0.15s;',
      '}',
      '.gs-clear:hover { color: var(--text-on-navy); }',

      // ── Filter status panel (always visible) ─────────────
      '#filter-panel {',
        'height: 34px;',
        'flex-shrink: 0;',
        'border-bottom: 2px solid var(--border);',
        'background: var(--bg-base);',
        'display: flex;',
        'align-items: center;',
        'overflow: hidden;',
      '}',

      '.fp-inner {',
        'display: flex;',
        'align-items: center;',
        'gap: 10px;',
        'padding: 0 16px;',
        'width: 100%;',
        'height: 100%;',
      '}',

      // Idle state
      '.fp-idle-dot {',
        'font-size: 7px;',
        'color: var(--border);',
        'line-height: 1;',
        'flex-shrink: 0;',
      '}',
      '.fp-idle-text {',
        'font-family: var(--font-body);',
        'font-size: 11px;',
        'font-style: italic;',
        'color: var(--text-secondary);',
        'opacity: 0.6;',
      '}',

      '.fp-active-dot {',
        'font-size: 8px;',
        'color: var(--accent);',
        'line-height: 1;',
        'flex-shrink: 0;',
      '}',

      '.fp-label {',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 10px;',
        'letter-spacing: 0.14em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
        'white-space: nowrap;',
        'flex-shrink: 0;',
      '}',

      '.fp-badges {',
        'display: flex;',
        'align-items: center;',
        'gap: 6px;',
        'flex: 1;',
        'overflow: hidden;',
      '}',

      '.fp-badge {',
        'display: inline-flex;',
        'align-items: center;',
        'gap: 4px;',
        'height: 22px;',
        'padding: 0 6px 0 8px;',
        'border: 1px solid var(--border);',
        'background: var(--bg-base);',
        'white-space: nowrap;',
        'flex-shrink: 0;',
      '}',
      '.fp-badge--search { border-color: rgba(201,151,58,0.4); background: rgba(201,151,58,0.06); }',
      '.fp-badge--col    { border-color: rgba(46,140,200,0.4);  background: rgba(46,140,200,0.06); }',

      '.fp-badge-label {',
        'font-family: var(--font-mono);',
        'font-size: 9px;',
        'letter-spacing: 0.1em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
      '}',

      '.fp-badge-value {',
        'font-family: var(--font-body);',
        'font-size: 11px;',
        'color: var(--text-primary);',
        'font-style: italic;',
      '}',

      '.fp-badge-remove {',
        'background: transparent;',
        'border: none;',
        'color: var(--text-secondary);',
        'font-size: 14px;',
        'line-height: 1;',
        'cursor: pointer;',
        'padding: 0 1px;',
        'transition: color 0.12s;',
        'margin-left: 2px;',
      '}',
      '.fp-badge-remove:hover { color: var(--color-error); }',

      '.fp-clear-all {',
        'margin-left: auto;',
        'height: 24px;',
        'padding: 0 12px;',
        'background: transparent;',
        'border: 1px solid var(--border);',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 9px;',
        'letter-spacing: 0.14em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
        'cursor: pointer;',
        'white-space: nowrap;',
        'flex-shrink: 0;',
        'transition: background 0.12s, color 0.12s;',
      '}',
      '.fp-clear-all:hover {',
        'background: var(--bg-base);',
        'color: var(--color-error);',
        'border-color: rgba(192,57,43,0.4);',
      '}',

      // ── HOT filter dropdown overrides ──────────────────────
      // Restyle HOT's built-in dropdown menu to match the app design system.

      '.handsontableInputHolder .htUIInput input,',
      '.htCore .handsontableInputHolder input {',
        'font-family: var(--font-body) !important;',
        'font-size: 12px !important;',
      '}',

      // Dropdown container
      '.handsontable .htDropdownMenu .ht_master .wtHolder,',
      '.htDropdownMenu.handsontable {',
        'border: 1px solid var(--border) !important;',
        'box-shadow: 0 6px 24px rgba(10,20,35,0.14) !important;',
        'border-radius: 0 !important;',
      '}',

      // Dropdown table cells
      '.htDropdownMenu .htCore td {',
        'font-family: var(--font-body) !important;',
        'font-size: 12px !important;',
        'color: var(--text-primary) !important;',
        'padding: 5px 12px !important;',
        'cursor: pointer !important;',
      '}',
      '.htDropdownMenu .htCore tr:hover td {',
        'background: var(--bg-base) !important;',
      '}',

      // Filter condition inputs inside the dropdown
      '.htFiltersConditionsMenu .htUIInput input,',
      '.htFiltersMenuCondition .htUIInput input {',
        'font-family: var(--font-body) !important;',
        'font-size: 12px !important;',
        'border: 1px solid var(--border) !important;',
        'outline: none !important;',
        'padding: 4px 8px !important;',
        'color: var(--text-primary) !important;',
        'background: var(--bg-surface) !important;',
      '}',
      '.htFiltersConditionsMenu .htUIInput input:focus,',
      '.htFiltersMenuCondition .htUIInput input:focus {',
        'border-color: var(--accent) !important;',
      '}',

      // OK / Cancel buttons inside dropdown
      '.htFiltersMenuActionBar .htUIButton {',
        'font-family: var(--font-display) !important;',
        'font-weight: 600 !important;',
        'font-size: 10px !important;',
        'letter-spacing: 0.12em !important;',
        'text-transform: uppercase !important;',
        'border: 1px solid var(--border) !important;',
        'background: transparent !important;',
        'color: var(--text-secondary) !important;',
        'cursor: pointer !important;',
        'padding: 5px 12px !important;',
        'transition: background 0.12s !important;',
      '}',
      '.htFiltersMenuActionBar .htUIButton.htUIButtonOK {',
        'background: var(--accent) !important;',
        'color: #fff !important;',
        'border-color: var(--accent) !important;',
      '}',
      '.htFiltersMenuActionBar .htUIButton.htUIButtonOK:hover {',
        'background: var(--accent-bright) !important;',
      '}',

      // ▼ arrow in column header — style the HOT dropdown trigger button
      '.handsontable .changeType {',
        'color: var(--text-secondary) !important;',
        'transition: color 0.12s !important;',
      '}',
      '.handsontable .changeType:hover {',
        'color: var(--accent) !important;',
      '}',
      // Highlight the ▼ when that column has an active filter
      '.handsontable th.htFiltersActive .changeType {',
        'color: var(--accent) !important;',
      '}',

    ].join('\n');

    document.head.appendChild(s);
  }

  // ── Expose ────────────────────────────────────────────────

  return {
    init:                  init,
    onColumnFilterChanged: onColumnFilterChanged,
  };

}());
