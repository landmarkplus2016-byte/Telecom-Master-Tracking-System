// ============================================================
// export.js — Excel export for all roles
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Wire the Export toolbar button
//   - Show a role-gated export options modal
//   - Build and download a .xlsx file via xlsx-js-style
//
// Role rules:
//   Coordinator — own rows only (server-filtered), 26 coordinator columns
//   Invoicing   — all rows or filtered view, all 43 columns
//   Manager     — all rows or filtered view, all 43 columns,
//                 optional filter by coordinator name
//
// Depends on:
//   window.XLSX      — xlsx-js-style (loaded in index.html)
//   Grid.getExportData() — returns { allRows, filteredRows, columns }
// ============================================================

var Export = (function () {

  // ── State ─────────────────────────────────────────────────

  var _role           = null;
  var _name           = null;
  var _overlayHandler = null;  // tracked so we can remove it on close

  // ── Public API ────────────────────────────────────────────

  function init(role, name) {
    _role = role;
    _name = name;

    var btn = document.getElementById('tb-export');
    if (btn) btn.addEventListener('click', openDialog);
  }

  function openDialog() {
    _renderModal();
    _showModal();
  }

  // ── Modal render ──────────────────────────────────────────

  function _renderModal() {
    var container = document.getElementById('modal-container');
    if (!container) return;

    var isCoord = _role === 'coordinator';
    var isMgr   = _role === 'manager';

    // Coordinator names for manager filter dropdown
    var coordNames = [];
    if (isMgr) {
      var exportData = Grid.getExportData();
      var seen = {};
      (exportData.allRows || []).forEach(function (r) {
        var n = (r.coordinator_name || '').trim();
        if (n && !seen[n]) { seen[n] = true; coordNames.push(n); }
      });
      coordNames.sort();
    }

    container.innerHTML = [
      '<div class="export-modal">',

        // ── Header ──────────────────────────────────────────
        '<div class="export-modal-header">',
          '<span class="export-modal-title">Export to Excel</span>',
          '<button class="export-modal-close" id="export-close-btn" ',
            'aria-label="Close">&times;</button>',
        '</div>',

        // ── Body ────────────────────────────────────────────
        '<div class="export-modal-body">',

          // Coordinator: fixed scope note
          isCoord ? [
            '<p class="export-info">',
              'Exports your rows with coordinator columns only.',
            '</p>',
          ].join('') : '',

          // Invoicing / Manager: scope toggle
          !isCoord ? [
            '<div class="export-field">',
              '<label class="export-label">Scope</label>',
              '<div class="export-toggle-group" id="export-scope-group">',
                '<button class="export-toggle export-toggle--active" ',
                  'data-value="all">All Rows</button>',
                '<button class="export-toggle" ',
                  'data-value="filtered">Current Filtered View</button>',
              '</div>',
            '</div>',
          ].join('') : '',

          // Manager: optional coordinator filter
          isMgr && coordNames.length ? [
            '<div class="export-field">',
              '<label class="export-label">Coordinator (optional)</label>',
              '<select id="export-coord-filter" class="export-select">',
                '<option value="">All coordinators</option>',
                coordNames.map(function (n) {
                  return '<option value="' + _esc(n) + '">' + _esc(n) + '</option>';
                }).join(''),
              '</select>',
            '</div>',
          ].join('') : '',

          // Filename
          '<div class="export-field">',
            '<label class="export-label">Filename</label>',
            '<div class="export-filename-wrap">',
              '<input id="export-filename" class="export-input" type="text" ',
                'value="' + _defaultFilename() + '" ',
                'autocomplete="off" spellcheck="false">',
              '<span class="export-ext">.xlsx</span>',
            '</div>',
          '</div>',

          // Row count preview (updated dynamically)
          '<div class="export-preview" id="export-preview"></div>',

        '</div>',

        // ── Footer ──────────────────────────────────────────
        '<div class="export-modal-footer">',
          '<button class="export-btn-cancel" id="export-cancel-btn">Cancel</button>',
          '<button class="export-btn-primary" id="export-go-btn">',
            '&#8675; Export',
          '</button>',
        '</div>',

      '</div>',
    ].join('');

    _wireModalEvents();
    _updatePreview();
  }

  function _wireModalEvents() {
    var closeBtn  = document.getElementById('export-close-btn');
    var cancelBtn = document.getElementById('export-cancel-btn');
    var goBtn     = document.getElementById('export-go-btn');

    if (closeBtn)  closeBtn.addEventListener('click', _hideModal);
    if (cancelBtn) cancelBtn.addEventListener('click', _hideModal);

    // Scope toggle buttons
    var scopeGroup = document.getElementById('export-scope-group');
    if (scopeGroup) {
      scopeGroup.querySelectorAll('.export-toggle').forEach(function (btn) {
        btn.addEventListener('click', function () {
          scopeGroup.querySelectorAll('.export-toggle').forEach(function (b) {
            b.classList.remove('export-toggle--active');
          });
          btn.classList.add('export-toggle--active');
          _updatePreview();
        });
      });
    }

    // Coordinator filter
    var coordFilter = document.getElementById('export-coord-filter');
    if (coordFilter) coordFilter.addEventListener('change', _updatePreview);

    // Export action
    if (goBtn) {
      goBtn.addEventListener('click', function () {
        _doExport();
        _hideModal();
      });
    }
  }

  // ── Modal show / hide ─────────────────────────────────────

  function _showModal() {
    var overlay   = document.getElementById('modal-overlay');
    var container = document.getElementById('modal-container');

    if (overlay) {
      overlay.removeAttribute('hidden');
      _overlayHandler = function () { _hideModal(); };
      overlay.addEventListener('click', _overlayHandler);
    }
    if (container) container.removeAttribute('hidden');
  }

  function _hideModal() {
    var overlay   = document.getElementById('modal-overlay');
    var container = document.getElementById('modal-container');

    if (overlay) {
      overlay.setAttribute('hidden', '');
      if (_overlayHandler) {
        overlay.removeEventListener('click', _overlayHandler);
        _overlayHandler = null;
      }
    }
    if (container) {
      container.setAttribute('hidden', '');
      container.innerHTML = '';
    }
  }

  // ── Row count preview ─────────────────────────────────────

  function _updatePreview() {
    var el = document.getElementById('export-preview');
    if (!el) return;
    var count = _resolveRows().length;
    el.textContent = count + ' row' + (count === 1 ? '' : 's') + ' will be exported';
  }

  // ── Export orchestration ──────────────────────────────────

  function _doExport() {
    var rows    = _resolveRows();
    var columns = _resolveColumns();
    var raw     = (document.getElementById('export-filename') || {}).value || '';
    var fname   = raw.trim() || _defaultFilename();
    _buildWorkbook(rows, columns, fname);
  }

  function _resolveRows() {
    var exportData = Grid.getExportData();
    var scope      = _getScope();
    var rows       = (scope === 'filtered') ? exportData.filteredRows : exportData.allRows;

    // Manager: optional coordinator name filter
    var coord = _getCoordFilter();
    if (coord) {
      rows = rows.filter(function (r) {
        return (r.coordinator_name || '').trim() === coord;
      });
    }

    return rows;
  }

  function _resolveColumns() {
    var exportData = Grid.getExportData();
    // Strip the client-side pricing indicator — it is UI-only, not real data
    return exportData.columns.filter(function (c) {
      return c.key !== '_price_indicator';
    });
  }

  function _getScope() {
    var active = document.querySelector('#export-scope-group .export-toggle--active');
    return active ? (active.getAttribute('data-value') || 'all') : 'all';
  }

  function _getCoordFilter() {
    var sel = document.getElementById('export-coord-filter');
    return sel ? sel.value.trim() : '';
  }

  function _defaultFilename() {
    var now = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return 'telecom_export_' + now.getFullYear() + '-' +
      pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  }

  // ── Workbook builder ──────────────────────────────────────

  // Design tokens (hex without #)
  var _C = {
    navy:    '1A2E4A',
    gold:    'C9973A',
    white:   'FFFFFF',
    altRow:  'F0F2F5',
    border:  'D0D7E2',
    text:    '1A2E4A',
    subtext: '5A6A80',
  };

  function _buildWorkbook(rows, columns, filename) {
    var XLSX = window.XLSX;
    if (!XLSX) {
      _toast('Export library not available. Check your internet connection and reload.', 'error');
      return;
    }
    if (!rows.length) {
      _toast('No rows to export.', 'warn');
      return;
    }

    var wb = XLSX.utils.book_new();
    wb.Props = { Title: 'Telecom Tracking Export', Author: 'Telecom Tracker', Created: new Date() };

    var ws = _buildSheet(rows, columns);
    XLSX.utils.book_append_sheet(wb, ws, 'Tracking Export');

    try {
      XLSX.writeFile(wb, filename + '.xlsx');
    } catch (e) {
      console.error('[export.js] writeFile failed:', e);
      _toast('Export failed: ' + (e.message || 'unknown error'), 'error');
    }
  }

  function _buildSheet(rows, columns) {
    var XLSX    = window.XLSX;
    var numCols = columns.length;
    var numRows = rows.length;

    // ── Build header row ────────────────────────────────────
    var headers = columns.map(function (c) { return c.label; });

    // ── Build data rows ─────────────────────────────────────
    var dataRows = rows.map(function (row) {
      return columns.map(function (col) {
        var v = row[col.key];
        if (v === null || v === undefined || v === '') return '';
        // Return numeric types as JS numbers so Excel formats them correctly
        if (col.type === 'numeric') {
          var cleaned = String(v).replace(/[^0-9.\-]/g, '');
          var n = parseFloat(cleaned);
          return isNaN(n) ? '' : n;
        }
        return String(v);
      });
    });

    var ws = XLSX.utils.aoa_to_sheet([headers].concat(dataRows));

    // ── Column widths (px → approximate Excel char width) ──
    ws['!cols'] = columns.map(function (col) {
      return { wch: Math.max(8, Math.round(col.width / 7)) };
    });

    // ── Freeze top row ──────────────────────────────────────
    ws['!freeze'] = {
      xSplit: 0, ySplit: 1,
      topLeftCell: 'A2',
      activePane:  'bottomLeft',
      state:       'frozen',
    };

    // ── Apply styles ────────────────────────────────────────
    // Header row (row index 0)
    for (var c = 0; c < numCols; c++) {
      var hRef = XLSX.utils.encode_cell({ r: 0, c: c });
      if (!ws[hRef]) ws[hRef] = { v: headers[c], t: 's' };
      ws[hRef].s = _headerStyle(c, numCols);
    }

    // Data rows
    for (var r = 0; r < numRows; r++) {
      var isAlt = (r % 2 === 1);
      for (var cc = 0; cc < numCols; cc++) {
        var dRef = XLSX.utils.encode_cell({ r: r + 1, c: cc });
        var col  = columns[cc];
        if (!ws[dRef]) {
          ws[dRef] = { v: '', t: 's' };
        }
        ws[dRef].s = _dataStyle(col, isAlt, cc, numCols);
        // Number / date formats
        var fmt = _numFmt(col);
        if (fmt) ws[dRef].z = fmt;
      }
    }

    return ws;
  }

  // ── Style factories ───────────────────────────────────────

  function _headerStyle(colIdx, numCols) {
    var isFirst = colIdx === 0;
    var isLast  = colIdx === numCols - 1;
    return {
      font: {
        name:  'Arial',
        sz:    10,
        bold:  true,
        color: { rgb: _C.white },
      },
      fill: {
        patternType: 'solid',
        fgColor:     { rgb: _C.navy },
      },
      alignment: {
        horizontal: 'center',
        vertical:   'center',
        wrapText:   false,
      },
      border: {
        top:    { style: 'thin',   color: { rgb: _C.navy } },
        bottom: { style: 'medium', color: { rgb: _C.gold } },
        left:   { style: 'thin',   color: { rgb: isFirst ? _C.navy : _C.subtext } },
        right:  { style: 'thin',   color: { rgb: isLast  ? _C.navy : _C.subtext } },
      },
    };
  }

  function _dataStyle(col, isAlt, colIdx, numCols) {
    var bg      = isAlt ? _C.altRow : _C.white;
    var isNum   = col.type === 'numeric';
    var isLast  = colIdx === numCols - 1;
    return {
      font: {
        name:  'Arial',
        sz:    10,
        color: { rgb: _C.text },
      },
      fill: {
        patternType: 'solid',
        fgColor:     { rgb: bg },
      },
      alignment: {
        horizontal: isNum ? 'right' : 'left',
        vertical:   'center',
      },
      border: {
        bottom: { style: 'thin', color: { rgb: _C.border } },
        right:  { style: 'thin', color: { rgb: isLast ? _C.border : _C.border } },
      },
    };
  }

  function _numFmt(col) {
    if (col.type === 'date') return 'DD-MMM-YYYY';
    if (col.type === 'numeric') return '#,##0.00';
    return null;
  }

  // ── Helpers ───────────────────────────────────────────────

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _toast(msg, type) {
    var bg = (type === 'error') ? '#c0392b' : '#8a6a0a';
    var el = document.createElement('div');
    el.style.cssText = [
      'position:fixed', 'bottom:40px', 'right:20px',
      'background:' + bg, 'color:#fff',
      'font-family:var(--font-body)', 'font-size:13px',
      'padding:10px 18px', 'z-index:9999', 'max-width:400px',
      'box-shadow:0 4px 16px rgba(0,0,0,0.2)', 'line-height:1.5',
    ].join(';');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }

  // ── Injected styles ───────────────────────────────────────

  (function _injectStyles() {
    if (document.getElementById('export-styles')) return;
    var s = document.createElement('style');
    s.id = 'export-styles';
    s.textContent = [

      // ── Modal overlay positioning ────────────────────────
      '#modal-overlay {',
        'position: fixed;',
        'inset: 0;',
        'background: rgba(10, 20, 35, 0.48);',
        'z-index: 1000;',
      '}',

      '#modal-container {',
        'position: fixed;',
        'top: 50%;',
        'left: 50%;',
        'transform: translate(-50%, -50%);',
        'z-index: 1001;',
        'outline: none;',
      '}',

      // ── Export modal card ────────────────────────────────
      '.export-modal {',
        'display: flex;',
        'flex-direction: column;',
        'width: 480px;',
        'max-width: 96vw;',
        'background: var(--bg-surface);',
        'border: 1px solid var(--border);',
        'box-shadow: 0 12px 48px rgba(10, 20, 35, 0.22);',
        'position: relative;',
      '}',

      // Gold corner brackets (matching login card)
      '.export-modal::before, .export-modal::after {',
        'content: "";',
        'position: absolute;',
        'width: 10px;',
        'height: 10px;',
        'border-color: var(--accent);',
        'border-style: solid;',
        'z-index: 1;',
      '}',
      '.export-modal::before {',
        'top: -1px; left: -1px;',
        'border-width: 2px 0 0 2px;',
      '}',
      '.export-modal::after {',
        'bottom: -1px; right: -1px;',
        'border-width: 0 2px 2px 0;',
      '}',

      // ── Header ──────────────────────────────────────────
      '.export-modal-header {',
        'display: flex;',
        'align-items: center;',
        'justify-content: space-between;',
        'padding: 16px 20px 14px;',
        'background: var(--bg-navy);',
        'border-bottom: 2px solid var(--accent);',
        'flex-shrink: 0;',
      '}',

      '.export-modal-title {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 14px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'color: var(--text-on-navy);',
      '}',

      '.export-modal-close {',
        'background: transparent;',
        'border: none;',
        'color: var(--text-muted-navy);',
        'font-size: 22px;',
        'line-height: 1;',
        'cursor: pointer;',
        'padding: 0 2px;',
        'transition: color 0.15s;',
      '}',
      '.export-modal-close:hover { color: var(--text-on-navy); }',

      // ── Body ────────────────────────────────────────────
      '.export-modal-body {',
        'padding: 24px 24px 16px;',
        'display: flex;',
        'flex-direction: column;',
        'gap: 18px;',
      '}',

      '.export-field {',
        'display: flex;',
        'flex-direction: column;',
        'gap: 7px;',
      '}',

      '.export-label {',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 10px;',
        'letter-spacing: 0.18em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
      '}',

      '.export-info {',
        'font-family: var(--font-body);',
        'font-size: 13px;',
        'color: var(--text-secondary);',
        'padding: 10px 14px;',
        'background: var(--bg-base);',
        'border-left: 3px solid var(--accent);',
        'margin: 0;',
        'line-height: 1.5;',
      '}',

      // ── Scope toggle ─────────────────────────────────────
      '.export-toggle-group {',
        'display: flex;',
        'border: 1px solid var(--border);',
      '}',

      '.export-toggle {',
        'flex: 1;',
        'height: 34px;',
        'background: var(--bg-surface);',
        'border: none;',
        'border-right: 1px solid var(--border);',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 10px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
        'cursor: pointer;',
        'transition: background 0.15s, color 0.15s;',
      '}',
      '.export-toggle:last-child { border-right: none; }',
      '.export-toggle:hover:not(.export-toggle--active) { background: var(--bg-base); }',
      '.export-toggle--active {',
        'background: var(--bg-navy);',
        'color: var(--text-on-navy);',
      '}',

      // ── Coordinator select ───────────────────────────────
      '.export-select {',
        'height: 36px;',
        'padding: 0 10px;',
        'font-family: var(--font-body);',
        'font-size: 13px;',
        'font-weight: 500;',
        'color: var(--text-primary);',
        'background: var(--bg-surface);',
        'border: 1px solid var(--border);',
        'border-radius: 0;',
        'outline: none;',
        'cursor: pointer;',
        'transition: border-color 0.15s;',
      '}',
      '.export-select:focus {',
        'border-color: var(--bg-navy);',
        'box-shadow: 0 0 0 2px var(--accent-dim);',
      '}',

      // ── Filename field ───────────────────────────────────
      '.export-filename-wrap {',
        'display: flex;',
        'align-items: stretch;',
      '}',

      '.export-input {',
        'flex: 1;',
        'height: 36px;',
        'padding: 0 10px;',
        'font-family: var(--font-mono);',
        'font-size: 12px;',
        'color: var(--text-primary);',
        'background: var(--bg-surface);',
        'border: 1px solid var(--border);',
        'border-right: none;',
        'outline: none;',
        'transition: border-color 0.15s;',
      '}',
      '.export-input:focus {',
        'border-color: var(--bg-navy);',
        'box-shadow: inset 0 0 0 1px var(--bg-navy);',
      '}',

      '.export-ext {',
        'display: flex;',
        'align-items: center;',
        'padding: 0 10px;',
        'font-family: var(--font-mono);',
        'font-size: 12px;',
        'color: var(--text-secondary);',
        'background: var(--bg-base);',
        'border: 1px solid var(--border);',
        'white-space: nowrap;',
        'flex-shrink: 0;',
      '}',

      // ── Row count preview ────────────────────────────────
      '.export-preview {',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'letter-spacing: 0.14em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
        'padding: 4px 0 0;',
      '}',

      // ── Footer ───────────────────────────────────────────
      '.export-modal-footer {',
        'display: flex;',
        'justify-content: flex-end;',
        'align-items: center;',
        'gap: 10px;',
        'padding: 14px 24px;',
        'border-top: 1px solid var(--border);',
        'background: var(--bg-base);',
        'flex-shrink: 0;',
      '}',

      '.export-btn-cancel {',
        'height: 34px;',
        'padding: 0 18px;',
        'background: transparent;',
        'border: 1px solid var(--border);',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 10px;',
        'letter-spacing: 0.14em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
        'cursor: pointer;',
        'transition: background 0.15s, color 0.15s;',
      '}',
      '.export-btn-cancel:hover {',
        'background: var(--bg-surface);',
        'color: var(--text-primary);',
      '}',

      '.export-btn-primary {',
        'height: 34px;',
        'padding: 0 22px;',
        'background: var(--bg-navy);',
        'border: none;',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 10px;',
        'letter-spacing: 0.16em;',
        'text-transform: uppercase;',
        'color: var(--text-on-navy);',
        'cursor: pointer;',
        'transition: background 0.15s;',
        'display: flex;',
        'align-items: center;',
        'gap: 6px;',
      '}',
      '.export-btn-primary:hover { background: var(--bg-navy-deep); }',

    ].join('\n');
    document.head.appendChild(s);
  }());

  // ── Expose ────────────────────────────────────────────────

  return {
    init:       init,
    openDialog: openDialog,
  };

}());
