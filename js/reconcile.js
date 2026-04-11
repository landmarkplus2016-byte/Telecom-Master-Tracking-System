// ============================================================
// reconcile.js — TSR Reconciliation Workflow
// Telecom Coordinator Tracking App — Stage 4
// ============================================================
//
// Responsibilities (this file only):
//   - Step 1: Export customer template (.xlsx) filtered by TSR Sub#
//   - Step 2: Upload and parse customer feedback Excel file
//   - Step 3: Auto-compare Actual Quantity + New Price per row by ID#
//             Match     → auto-set PO Status = "Approved"
//             Changed   → flag ⚠, show side-by-side for review
//             Rejected  → auto-set PO Status = "REJ"
//   - Step 4: Invoicing reviews changed rows (Accept / Reject each)
//             Accept    → update actual_quantity + new_price +
//                         new_total_price, PO Status = "Approved"
//             Reject    → PO Status = "REJ"
//   - Step 5: Batch-write all decisions, log the run
//
// Access: Invoicing + Manager only. Coordinators never see this.
//
// Excel I/O: SheetJS (xlsx.js) loaded on demand from CDN.
//
// Log storage: localStorage key 'reconcile_log' — rolling 50 entries.
//
// Public API:
//   Reconcile.init(role, userName)
//   Reconcile.openPanel()
//   Reconcile.wireToolbarButton()   — called by app.js after Grid.init
// ============================================================

var Reconcile = (function () {

  // ── Template columns exported to customer ─────────────────
  //
  // Only the fields the customer needs to verify are exported.
  // Three empty columns are appended for the customer to fill in.

  var TEMPLATE_COLS = [
    { key: 'id',              label: 'ID #'            },
    { key: 'tsr_sub',         label: 'TSR Sub#'        },
    { key: 'job_code',        label: 'Job Code'        },
    { key: 'logical_site_id', label: 'Logical Site ID' },
    { key: 'task_name',       label: 'Task Name'       },
    { key: 'line_item',       label: 'Line Item'       },
    { key: 'contractor',      label: 'Contractor'      },
    { key: 'actual_quantity', label: 'RC Quantity'     },
    { key: 'new_price',       label: 'New Price'       },
    { key: 'new_total_price', label: 'New Total Price' },
  ];

  // Labels for the three customer-fill columns appended to the template
  var COL_CUST_QTY      = 'Customer Quantity';
  var COL_CUST_PRICE    = 'Customer Price';
  var COL_CUST_DECISION = 'Decision';          // 'Approved' | 'Rejected'

  // Numeric tolerance for float comparisons
  var QTY_TOLERANCE   = 0.001;
  var PRICE_TOLERANCE = 0.01;

  // PO Status values written back to the sheet
  var PO_APPROVED = 'Approved';
  var PO_REJECTED = 'REJ';

  // Log rolling window (localStorage)
  var LOG_KEY      = 'reconcile_log';
  var LOG_MAX      = 50;

  // ── Internal state ────────────────────────────────────────

  var _role     = null;
  var _userName = null;

  // Active reconciliation run
  var _tsrSub      = '';         // TSR Sub# selected in Step 1
  var _tsrRows     = [];         // rows matching that TSR Sub#
  var _results     = [];         // [{ row, status, custQty, custPrice, decision }]
  var _reviewDecisions = {};     // { rowId: 'accept' | 'reject' } — Step 4 choices

  // Panel DOM root
  var _panelEl  = null;

  // ── Public: init ─────────────────────────────────────────

  function init(role, userName) {
    _role     = role;
    _userName = userName;
  }

  // ── Public: wire toolbar button ───────────────────────────
  //
  // Called by app.js after Grid.init(). Attaches the click handler
  // to the #tb-reconcile button that Grid already rendered.

  function wireToolbarButton() {
    var btn = document.getElementById('tb-reconcile');
    if (!btn) return;
    btn.addEventListener('click', function () { openPanel(); });
  }

  // ── Public: open panel ────────────────────────────────────

  function openPanel() {
    if (_role !== 'invoicing' && _role !== 'manager') return;
    _ensureStyles();
    _resetState();
    _buildPanel();
  }

  // ── State reset between runs ──────────────────────────────

  function _resetState() {
    _tsrSub          = '';
    _tsrRows         = [];
    _results         = [];
    _reviewDecisions = {};
  }

  // ── Panel builder — renders the full step-1 screen ────────

  function _buildPanel() {
    // Remove any existing panel
    if (_panelEl && _panelEl.parentNode) _panelEl.parentNode.removeChild(_panelEl);

    var overlay = document.createElement('div');
    overlay.id        = 'recon-overlay';
    overlay.className = 'recon-overlay';

    var panel = document.createElement('div');
    panel.className = 'recon-panel';
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    _panelEl = overlay;

    // Close on overlay background click
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) _closePanel();
    });

    _renderStep1(panel);
  }

  function _closePanel() {
    if (_panelEl && _panelEl.parentNode) {
      _panelEl.parentNode.removeChild(_panelEl);
    }
    _panelEl = null;
  }

  // ── Step 1: Select TSR Sub# + Export Template ─────────────

  function _renderStep1(panel) {
    panel.innerHTML = '';

    var html = [
      '<div class="recon-header">',
        '<div class="recon-title">',
          '<span class="recon-title-icon">&#9654;</span>',
          'TSR Reconciliation',
        '</div>',
        '<button class="recon-close" aria-label="Close">&times;</button>',
      '</div>',

      '<div class="recon-steps">',
        _stepPip(1, true), _stepPip(2, false), _stepPip(3, false),
        _stepPip(4, false), _stepPip(5, false),
      '</div>',

      '<div class="recon-body">',
        '<div class="recon-section-label">Step 1 — Export Customer Template</div>',

        '<div class="recon-row">',
          '<label class="recon-label" for="recon-tsr-input">TSR Sub#</label>',
          '<input id="recon-tsr-input" class="recon-input"',
            ' type="text" list="recon-tsr-list"',
            ' placeholder="e.g. TSR-2026-001" autocomplete="off">',
          '<datalist id="recon-tsr-list"></datalist>',
        '</div>',

        '<div id="recon-tsr-preview" class="recon-preview" hidden>',
          '<span id="recon-tsr-count" class="recon-count"></span>',
        '</div>',

        '<div class="recon-actions">',
          '<button class="recon-btn recon-btn--primary" id="recon-export-btn" disabled>',
            '&#8659; Export Template',
          '</button>',
          '<button class="recon-btn recon-btn--ghost recon-btn--right" id="recon-log-btn">',
            '&#9776; History',
          '</button>',
        '</div>',
      '</div>',

      '<div class="recon-footer">',
        'After exporting, send the file to the customer.',
        ' When they return it, continue to Step 2.',
        '<button class="recon-btn recon-btn--next" id="recon-to-step2" disabled>',
          'Next: Upload Feedback &#8658;',
        '</button>',
      '</div>',
    ].join('');

    panel.innerHTML = html;

    // Close button
    panel.querySelector('.recon-close').addEventListener('click', _closePanel);

    // Populate TSR Sub# datalist from IDB rows
    _loadTsrOptions(function (tsrList) {
      var dl = panel.querySelector('#recon-tsr-list');
      tsrList.forEach(function (t) {
        var opt = document.createElement('option');
        opt.value = t;
        dl.appendChild(opt);
      });
    });

    // TSR input → filter rows + enable export
    var tsrInput   = panel.querySelector('#recon-tsr-input');
    var exportBtn  = panel.querySelector('#recon-export-btn');
    var nextBtn    = panel.querySelector('#recon-to-step2');
    var preview    = panel.querySelector('#recon-tsr-preview');
    var countEl    = panel.querySelector('#recon-tsr-count');

    tsrInput.addEventListener('input', function () {
      var val = this.value.trim();
      _tsrSub  = val;

      if (!val) {
        _tsrRows = [];
        exportBtn.disabled = true;
        nextBtn.disabled   = true;
        preview.setAttribute('hidden', '');
        return;
      }

      _getRowsByTsr(val, function (rows) {
        _tsrRows = rows;
        var count = rows.length;
        exportBtn.disabled = (count === 0);
        nextBtn.disabled   = (count === 0);

        if (count > 0) {
          preview.removeAttribute('hidden');
          countEl.textContent = count + ' row' + (count !== 1 ? 's' : '') +
            ' found for TSR Sub# \u201c' + val + '\u201d';
        } else {
          preview.setAttribute('hidden', '');
        }
      });
    });

    // Export button
    exportBtn.addEventListener('click', function () {
      if (!_tsrRows.length) return;
      _loadXlsx(function () {
        _exportTemplate(_tsrSub, _tsrRows);
      });
    });

    // History button
    panel.querySelector('#recon-log-btn').addEventListener('click', function () {
      _renderLogPanel(panel);
    });

    // Next: go to Step 2
    nextBtn.addEventListener('click', function () {
      if (_tsrRows.length) _renderStep2(panel);
    });
  }

  // ── Step 2: Upload Customer Feedback ──────────────────────

  function _renderStep2(panel) {
    panel.innerHTML = '';

    var html = [
      '<div class="recon-header">',
        '<div class="recon-title">',
          '<span class="recon-title-icon">&#9654;</span>',
          'TSR Reconciliation &mdash; ' + _esc(_tsrSub),
        '</div>',
        '<button class="recon-close" aria-label="Close">&times;</button>',
      '</div>',

      '<div class="recon-steps">',
        _stepPip(1, false), _stepPip(2, true), _stepPip(3, false),
        _stepPip(4, false), _stepPip(5, false),
      '</div>',

      '<div class="recon-body">',
        '<div class="recon-section-label">Step 2 — Upload Customer Feedback</div>',

        '<div class="recon-upload-zone" id="recon-drop-zone">',
          '<div class="recon-upload-icon">&#8671;</div>',
          '<div class="recon-upload-text">',
            'Drop the customer\u2019s Excel file here, or',
          '</div>',
          '<label class="recon-btn recon-btn--primary recon-upload-label">',
            'Browse File',
            '<input type="file" id="recon-file-input"',
              ' accept=".xlsx,.xls,.csv" style="display:none">',
          '</label>',
          '<div id="recon-file-name" class="recon-file-name" hidden></div>',
        '</div>',

        '<div id="recon-parse-error" class="recon-error" hidden></div>',
      '</div>',

      '<div class="recon-footer">',
        '<button class="recon-btn recon-btn--ghost" id="recon-back-1">',
          '&#8592; Back',
        '</button>',
        '<button class="recon-btn recon-btn--next" id="recon-run-compare" disabled>',
          'Run Comparison &#8658;',
        '</button>',
      '</div>',
    ].join('');

    panel.innerHTML = html;

    panel.querySelector('.recon-close').addEventListener('click', _closePanel);
    panel.querySelector('#recon-back-1').addEventListener('click', function () {
      _renderStep1(panel);
    });

    var fileInput  = panel.querySelector('#recon-file-input');
    var fileNameEl = panel.querySelector('#recon-file-name');
    var errorEl    = panel.querySelector('#recon-parse-error');
    var runBtn     = panel.querySelector('#recon-run-compare');
    var dropZone   = panel.querySelector('#recon-drop-zone');

    var _parsedFeedback = null; // { [id]: feedbackRow }

    function handleFile(file) {
      if (!file) return;
      _loadXlsx(function () {
        fileNameEl.textContent = file.name;
        fileNameEl.removeAttribute('hidden');
        errorEl.setAttribute('hidden', '');
        runBtn.disabled = true;

        _parseFeedbackFile(file, function (err, feedbackMap) {
          if (err) {
            errorEl.textContent = err;
            errorEl.removeAttribute('hidden');
            _parsedFeedback = null;
            runBtn.disabled = true;
            return;
          }
          _parsedFeedback = feedbackMap;
          runBtn.disabled = false;
        });
      });
    }

    fileInput.addEventListener('change', function () {
      if (this.files && this.files[0]) handleFile(this.files[0]);
    });

    // Drag-and-drop
    dropZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dropZone.classList.add('recon-upload-zone--drag');
    });
    dropZone.addEventListener('dragleave', function () {
      dropZone.classList.remove('recon-upload-zone--drag');
    });
    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropZone.classList.remove('recon-upload-zone--drag');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) {
        fileInput.files; // access for completeness; use the drop file
        handleFile(f);
      }
    });

    runBtn.addEventListener('click', function () {
      if (!_parsedFeedback) return;
      _results         = _compareRows(_tsrRows, _parsedFeedback);
      _reviewDecisions = {};
      _renderStep3(panel);
    });
  }

  // ── Step 3: Show Comparison Results ───────────────────────

  function _renderStep3(panel) {
    var matched  = _results.filter(function (r) { return r.status === 'match';    });
    var changed  = _results.filter(function (r) { return r.status === 'changed';  });
    var rejected = _results.filter(function (r) { return r.status === 'rejected'; });
    var missing  = _results.filter(function (r) { return r.status === 'not_found';});

    panel.innerHTML = '';

    var html = [
      '<div class="recon-header">',
        '<div class="recon-title">',
          '<span class="recon-title-icon">&#9654;</span>',
          'TSR Reconciliation &mdash; ' + _esc(_tsrSub),
        '</div>',
        '<button class="recon-close" aria-label="Close">&times;</button>',
      '</div>',

      '<div class="recon-steps">',
        _stepPip(1, false), _stepPip(2, false), _stepPip(3, true),
        _stepPip(4, false), _stepPip(5, false),
      '</div>',

      '<div class="recon-body">',
        '<div class="recon-section-label">Step 3 — Comparison Results</div>',

        '<div class="recon-summary">',
          _summaryChip('match',    matched.length,  '&#10003; Matched',  'recon-chip--ok'),
          _summaryChip('changed',  changed.length,  '&#9888; Changed',   'recon-chip--warn'),
          _summaryChip('rejected', rejected.length, '&#10007; Rejected', 'recon-chip--err'),
          (missing.length
            ? _summaryChip('missing', missing.length, '? Not Found', 'recon-chip--muted')
            : ''),
        '</div>',
    ].join('');

    if (changed.length === 0) {
      // No manual review needed — show the auto-apply prompt
      html += [
        '<div class="recon-notice">',
          'No rows require review. ',
          matched.length + ' row' + (matched.length !== 1 ? 's' : '') + ' will be set to <strong>Approved</strong>',
          (rejected.length ? ' and ' + rejected.length + ' row' + (rejected.length !== 1 ? 's' : '') + ' to <strong>REJ</strong>' : ''),
          '.',
        '</div>',
      ].join('');
    } else {
      // Summarise what Step 4 will show
      html += [
        '<div class="recon-notice">',
          changed.length + ' row' + (changed.length !== 1 ? 's' : '') +
          ' require your review in Step 4.',
        '</div>',
      ].join('');
    }

    html += '</div>'; // end recon-body

    html += [
      '<div class="recon-footer">',
        '<button class="recon-btn recon-btn--ghost" id="recon-back-2">',
          '&#8592; Back',
        '</button>',
    ].join('');

    if (changed.length === 0) {
      html += '<button class="recon-btn recon-btn--apply" id="recon-apply-all">' +
              'Apply &amp; Finish &#8658;</button>';
    } else {
      html += '<button class="recon-btn recon-btn--next" id="recon-to-step4">' +
              'Review Changed Rows &#8658;</button>';
    }

    html += '</div>';
    panel.innerHTML = html;

    panel.querySelector('.recon-close').addEventListener('click', _closePanel);
    panel.querySelector('#recon-back-2').addEventListener('click', function () {
      _renderStep2(panel);
    });

    var reviewBtn = panel.querySelector('#recon-to-step4');
    if (reviewBtn) {
      reviewBtn.addEventListener('click', function () { _renderStep4(panel); });
    }

    var applyBtn = panel.querySelector('#recon-apply-all');
    if (applyBtn) {
      applyBtn.addEventListener('click', function () {
        _applyAndFinish(panel);
      });
    }
  }

  // ── Step 4: Review Changed Rows ───────────────────────────

  function _renderStep4(panel) {
    var changed = _results.filter(function (r) { return r.status === 'changed'; });

    panel.innerHTML = '';

    var rows = changed.map(function (r) {
      var rowId  = String(r.row.id || r.row._row_index || '');
      var ourQty    = _fmt(r.row.actual_quantity);
      var ourPrice  = _fmtCurrency(r.row.new_price);
      var custQty   = r.qtyChanged   ? _fmt(r.custQty)   : null;
      var custPrice = r.priceChanged ? _fmtCurrency(r.custPrice) : null;

      var rowHtml = [
        '<tr class="recon-review-row" data-row-id="' + _esc(rowId) + '">',
          '<td class="recon-review-id">' + _esc(String(r.row.id || '')) + '</td>',
          '<td class="recon-review-site">' + _esc(String(r.row.logical_site_id || '')) + '</td>',
          // RC Quantity column
          '<td class="recon-review-cell">',
            '<span class="recon-our-val">' + ourQty + '</span>',
            (custQty !== null
              ? '<span class="recon-arrow">&rarr;</span>' +
                '<span class="recon-cust-val recon-changed">' + custQty + '</span>'
              : '<span class="recon-same">(same)</span>'),
          '</td>',
          // New Price column
          '<td class="recon-review-cell">',
            '<span class="recon-our-val">' + ourPrice + '</span>',
            (custPrice !== null
              ? '<span class="recon-arrow">&rarr;</span>' +
                '<span class="recon-cust-val recon-changed">' + custPrice + '</span>'
              : '<span class="recon-same">(same)</span>'),
          '</td>',
          // Decision buttons
          '<td class="recon-review-dec">',
            '<button class="recon-dec-btn recon-dec-accept" data-id="' + _esc(rowId) + '">' +
              '&#10003; Accept</button>',
            '<button class="recon-dec-btn recon-dec-reject" data-id="' + _esc(rowId) + '">' +
              '&#10007; Reject</button>',
          '</td>',
        '</tr>',
      ].join('');

      return rowHtml;
    }).join('');

    var html = [
      '<div class="recon-header">',
        '<div class="recon-title">',
          '<span class="recon-title-icon">&#9654;</span>',
          'TSR Reconciliation &mdash; ' + _esc(_tsrSub),
        '</div>',
        '<button class="recon-close" aria-label="Close">&times;</button>',
      '</div>',

      '<div class="recon-steps">',
        _stepPip(1, false), _stepPip(2, false), _stepPip(3, false),
        _stepPip(4, true), _stepPip(5, false),
      '</div>',

      '<div class="recon-body recon-body--scroll">',
        '<div class="recon-section-label">Step 4 — Review Changed Rows</div>',
        '<div class="recon-bulk-actions">',
          '<button class="recon-btn recon-btn--sm" id="recon-accept-all">Accept All</button>',
          '<button class="recon-btn recon-btn--sm recon-btn--danger" id="recon-reject-all">Reject All</button>',
          '<span id="recon-review-progress" class="recon-review-progress"></span>',
        '</div>',
        '<table class="recon-review-table">',
          '<thead><tr>',
            '<th>ID #</th><th>Site</th>',
            '<th>RC Quantity <span class="recon-th-note">Ours &rarr; Customer</span></th>',
            '<th>New Price <span class="recon-th-note">Ours &rarr; Customer</span></th>',
            '<th>Decision</th>',
          '</tr></thead>',
          '<tbody id="recon-review-body">',
            rows,
          '</tbody>',
        '</table>',
      '</div>',

      '<div class="recon-footer">',
        '<button class="recon-btn recon-btn--ghost" id="recon-back-3">',
          '&#8592; Back',
        '</button>',
        '<button class="recon-btn recon-btn--apply" id="recon-apply-btn" disabled>',
          'Apply All Decisions &#8658;',
        '</button>',
      '</div>',
    ].join('');

    panel.innerHTML = html;
    panel.querySelector('.recon-close').addEventListener('click', _closePanel);
    panel.querySelector('#recon-back-3').addEventListener('click', function () {
      _renderStep3(panel);
    });

    // Wire decision buttons
    var tbody = panel.querySelector('#recon-review-body');
    tbody.addEventListener('click', function (e) {
      var btn = e.target.closest('.recon-dec-btn');
      if (!btn) return;
      var id  = btn.getAttribute('data-id');
      var dec = btn.classList.contains('recon-dec-accept') ? 'accept' : 'reject';
      _setDecision(panel, id, dec, changed);
    });

    // Bulk accept/reject
    panel.querySelector('#recon-accept-all').addEventListener('click', function () {
      changed.forEach(function (r) {
        var id = String(r.row.id || r.row._row_index || '');
        _setDecision(panel, id, 'accept', changed);
      });
    });
    panel.querySelector('#recon-reject-all').addEventListener('click', function () {
      changed.forEach(function (r) {
        var id = String(r.row.id || r.row._row_index || '');
        _setDecision(panel, id, 'reject', changed);
      });
    });

    panel.querySelector('#recon-apply-btn').addEventListener('click', function () {
      _applyAndFinish(panel);
    });

    _updateReviewProgress(panel, changed.length);
  }

  // Set a decision on a review row and update the UI state
  function _setDecision(panel, rowId, decision, changedResults) {
    _reviewDecisions[rowId] = decision;

    // Update row styling
    var row = panel.querySelector('[data-row-id="' + rowId + '"]');
    if (row) {
      row.classList.remove('recon-dec--accept', 'recon-dec--reject');
      row.classList.add(decision === 'accept' ? 'recon-dec--accept' : 'recon-dec--reject');

      // Toggle button active states
      row.querySelector('.recon-dec-accept').classList.toggle('active', decision === 'accept');
      row.querySelector('.recon-dec-reject').classList.toggle('active', decision === 'reject');
    }

    _updateReviewProgress(panel, changedResults.length);
  }

  function _updateReviewProgress(panel, total) {
    var decided   = Object.keys(_reviewDecisions).length;
    var progressEl = panel.querySelector('#recon-review-progress');
    var applyBtn   = panel.querySelector('#recon-apply-btn');

    if (progressEl) {
      progressEl.textContent = decided + ' of ' + total + ' reviewed';
    }
    if (applyBtn) {
      applyBtn.disabled = (decided < total);
    }
  }

  // ── Step 5: Apply Decisions + Log ─────────────────────────

  function _applyAndFinish(panel) {
    var rowsToWrite = _buildWritePayload();

    if (!rowsToWrite.length) {
      _renderStep5(panel, { approved: 0, rejected: 0, changed: 0, skipped: 0 });
      return;
    }

    // Show progress indicator
    _renderApplying(panel, rowsToWrite.length);

    var done = 0;
    function onProgress(d) {
      done = d;
      var el = document.getElementById('recon-apply-progress');
      if (el) el.textContent = 'Writing ' + done + ' of ' + rowsToWrite.length + ' rows\u2026';
    }

    Sheets.writeBatch(rowsToWrite, onProgress, function (result) {
      var counts = _countOutcomes();
      if (result.success) {
        // Refresh IDB so the grid reflects the new PO Status values immediately
        if (typeof Offline !== 'undefined' && Offline.storeRows) {
          var updatedRows = rowsToWrite.map(function (wr) {
            // Merge writes back into the original row object for IDB
            var orig = _tsrRows.find(function (r) {
              return String(r._row_index) === String(wr._row_index);
            });
            return orig ? Object.assign({}, orig, wr) : wr;
          }).filter(Boolean);
          Offline.storeRows(updatedRows);
        }
        _saveLog(counts);
        _renderStep5(panel, counts);
      } else {
        _renderApplyError(panel, result.error || 'Batch write failed.');
      }
    });
  }

  // Build the array of row objects to pass to Sheets.writeBatch
  function _buildWritePayload() {
    var payload = [];

    _results.forEach(function (r) {
      if (!r.row || !r.row._row_index) return; // skip new/uncommitted rows

      if (r.status === 'match') {
        payload.push({ _row_index: r.row._row_index, po_status: PO_APPROVED });

      } else if (r.status === 'rejected') {
        payload.push({ _row_index: r.row._row_index, po_status: PO_REJECTED });

      } else if (r.status === 'changed') {
        var rowId = String(r.row.id || r.row._row_index || '');
        var dec   = _reviewDecisions[rowId];
        if (!dec) return; // no decision yet — skip (should not happen in practice)

        if (dec === 'accept') {
          var update = { _row_index: r.row._row_index, po_status: PO_APPROVED };
          if (r.qtyChanged)   update.actual_quantity = r.custQty;
          if (r.priceChanged) {
            update.new_price       = r.custPrice;
            // Recalculate new_total_price: use accepted qty (our qty or customer qty)
            var finalQty   = r.qtyChanged ? r.custQty : Number(r.row.actual_quantity || 0);
            update.new_total_price = r.custPrice * finalQty;
          }
          payload.push(update);
        } else {
          // reject
          payload.push({ _row_index: r.row._row_index, po_status: PO_REJECTED });
        }
      }
    });

    return payload;
  }

  function _countOutcomes() {
    var matched  = _results.filter(function (r) { return r.status === 'match'; }).length;
    var rejected = _results.filter(function (r) { return r.status === 'rejected'; }).length;
    var accepted = 0;
    var rejectedChanged = 0;

    _results.filter(function (r) { return r.status === 'changed'; }).forEach(function (r) {
      var rowId = String(r.row.id || r.row._row_index || '');
      if (_reviewDecisions[rowId] === 'accept') accepted++;
      else                                       rejectedChanged++;
    });

    return {
      approved: matched + accepted,
      rejected: rejected + rejectedChanged,
      changed:  _results.filter(function (r) { return r.status === 'changed'; }).length,
      skipped:  _results.filter(function (r) { return r.status === 'not_found'; }).length
    };
  }

  // ── Step 5: Done screen ───────────────────────────────────

  function _renderStep5(panel, counts) {
    panel.innerHTML = '';

    var html = [
      '<div class="recon-header">',
        '<div class="recon-title">',
          '<span class="recon-title-icon">&#10003;</span>',
          'Reconciliation Complete',
        '</div>',
        '<button class="recon-close" aria-label="Close">&times;</button>',
      '</div>',

      '<div class="recon-steps">',
        _stepPip(1, false), _stepPip(2, false), _stepPip(3, false),
        _stepPip(4, false), _stepPip(5, true),
      '</div>',

      '<div class="recon-body recon-body--center">',
        '<div class="recon-done-icon">&#10003;</div>',
        '<div class="recon-done-title">TSR ' + _esc(_tsrSub) + ' Reconciled</div>',
        '<div class="recon-summary recon-summary--done">',
          _summaryChip('match',    counts.approved, '&#10003; Approved', 'recon-chip--ok'),
          _summaryChip('rejected', counts.rejected, '&#10007; Rejected', 'recon-chip--err'),
          (counts.skipped
            ? _summaryChip('skip', counts.skipped, '&#8213; Not Found', 'recon-chip--muted')
            : ''),
        '</div>',
        '<div class="recon-done-meta">',
          'Logged by ' + _esc(_userName) + ' on ' + _nowLabel(),
        '</div>',
      '</div>',

      '<div class="recon-footer">',
        '<button class="recon-btn recon-btn--ghost" id="recon-new-run">',
          'New Reconciliation',
        '</button>',
        '<button class="recon-btn recon-btn--primary" id="recon-done-close">',
          'Done',
        '</button>',
      '</div>',
    ].join('');

    panel.innerHTML = html;
    panel.querySelector('.recon-close').addEventListener('click', _closePanel);
    panel.querySelector('#recon-done-close').addEventListener('click', _closePanel);
    panel.querySelector('#recon-new-run').addEventListener('click', function () {
      _resetState();
      _renderStep1(panel);
    });
  }

  // ── Applying progress screen ──────────────────────────────

  function _renderApplying(panel, total) {
    var inner = panel.querySelector('.recon-body') || panel;
    inner.innerHTML = [
      '<div class="recon-body recon-body--center">',
        '<div class="recon-spinner"></div>',
        '<div id="recon-apply-progress" class="recon-apply-progress">',
          'Writing 0 of ' + total + ' rows\u2026',
        '</div>',
      '</div>',
    ].join('');
  }

  function _renderApplyError(panel, msg) {
    var inner = panel.querySelector('.recon-body') || panel;
    inner.innerHTML = [
      '<div class="recon-error recon-error--full">',
        '<strong>Write failed</strong><br>' + _esc(msg),
        '<br><br>',
        '<button class="recon-btn recon-btn--ghost" id="recon-err-close">Close</button>',
      '</div>',
    ].join('');
    var btn = inner.querySelector('#recon-err-close');
    if (btn) btn.addEventListener('click', _closePanel);
  }

  // ── Log panel ─────────────────────────────────────────────

  function _renderLogPanel(panel) {
    var log = _readLog();

    var rows = log.length === 0
      ? '<tr><td colspan="6" class="recon-log-empty">No reconciliation runs yet.</td></tr>'
      : log.slice().reverse().map(function (entry) {
          return [
            '<tr>',
              '<td>' + _esc(entry.tsrSub)   + '</td>',
              '<td>' + _esc(entry.who)       + '</td>',
              '<td>' + _esc(entry.when)      + '</td>',
              '<td class="recon-count-ok">'  + entry.approved  + '</td>',
              '<td class="recon-count-err">' + entry.rejected  + '</td>',
              '<td class="recon-count-muted">' + (entry.skipped || 0)  + '</td>',
            '</tr>',
          ].join('');
        }).join('');

    var html = [
      '<div class="recon-header">',
        '<div class="recon-title">Reconciliation History</div>',
        '<button class="recon-close" aria-label="Close">&times;</button>',
      '</div>',
      '<div class="recon-body recon-body--scroll">',
        '<table class="recon-log-table">',
          '<thead><tr>',
            '<th>TSR Sub#</th><th>By</th><th>When</th>',
            '<th>Approved</th><th>Rejected</th><th>Not Found</th>',
          '</tr></thead>',
          '<tbody>' + rows + '</tbody>',
        '</table>',
      '</div>',
      '<div class="recon-footer">',
        '<button class="recon-btn recon-btn--ghost" id="recon-log-back">&#8592; Back</button>',
      '</div>',
    ].join('');

    panel.innerHTML = html;
    panel.querySelector('.recon-close').addEventListener('click', _closePanel);
    panel.querySelector('#recon-log-back').addEventListener('click', function () {
      _resetState();
      _renderStep1(panel);
    });
  }

  // ── Comparison logic ──────────────────────────────────────

  function _compareRows(ourRows, feedbackMap) {
    return ourRows.map(function (row) {
      var id  = String(row.id || '').trim();
      var fbRow = feedbackMap[id];

      if (!fbRow) {
        return { row: row, status: 'not_found' };
      }

      // Check for explicit rejection
      var dec = String(fbRow[COL_CUST_DECISION] || '').trim().toLowerCase();
      if (dec === 'rejected' || dec === 'rej' || dec === 'reject') {
        return { row: row, status: 'rejected' };
      }

      var fbQtyCellRaw   = fbRow[COL_CUST_QTY];
      var fbPriceCellRaw = fbRow[COL_CUST_PRICE];

      var qtyProvided   = fbQtyCellRaw !== '' && fbQtyCellRaw !== null && fbQtyCellRaw !== undefined;
      var priceProvided = fbPriceCellRaw !== '' && fbPriceCellRaw !== null && fbPriceCellRaw !== undefined;

      var fbQty   = qtyProvided   ? Number(fbQtyCellRaw)   : NaN;
      var fbPrice = priceProvided ? Number(fbPriceCellRaw) : NaN;
      var ourQty  = Number(row.actual_quantity || 0);
      var ourPrice = Number(row.new_price      || 0);

      var qtyChanged   = qtyProvided   && !isNaN(fbQty)   && Math.abs(fbQty   - ourQty)   > QTY_TOLERANCE;
      var priceChanged = priceProvided && !isNaN(fbPrice) && Math.abs(fbPrice - ourPrice) > PRICE_TOLERANCE;

      if (qtyChanged || priceChanged) {
        return {
          row:          row,
          status:       'changed',
          custQty:      qtyProvided   ? fbQty   : ourQty,
          custPrice:    priceProvided ? fbPrice : ourPrice,
          qtyChanged:   qtyChanged,
          priceChanged: priceChanged
        };
      }

      return { row: row, status: 'match' };
    });
  }

  // ── Excel export ──────────────────────────────────────────

  function _exportTemplate(tsrSub, rows) {
    var XLSX = window.XLSX;
    var wb   = XLSX.utils.book_new();

    // ── Build header row ────────────────────────────────────
    var headers = TEMPLATE_COLS.map(function (c) { return c.label; });
    headers.push(COL_CUST_QTY, COL_CUST_PRICE, COL_CUST_DECISION);

    // ── Build data rows ─────────────────────────────────────
    var dataRows = rows.map(function (r) {
      var row = TEMPLATE_COLS.map(function (c) {
        var v = r[c.key];
        // Numeric fields: ensure number type
        if (c.key === 'actual_quantity' || c.key === 'new_price' || c.key === 'new_total_price') {
          return v !== '' && v !== null && v !== undefined ? Number(v) : '';
        }
        return v !== null && v !== undefined ? String(v) : '';
      });
      row.push('', '', ''); // Customer Quantity, Customer Price, Decision
      return row;
    });

    var wsData = [headers].concat(dataRows);
    var ws     = XLSX.utils.aoa_to_sheet(wsData);

    // ── Column widths ───────────────────────────────────────
    var colWidths = [18, 12, 14, 18, 32, 40, 18, 14, 12, 15, 16, 12, 14];
    ws['!cols'] = colWidths.map(function (w) { return { wch: w }; });

    // ── Style header row ─────────────────────────────────────
    // SheetJS CE doesn't support cell styles; header is identified by row 1
    // in most Excel readers. We add a note row explaining the customer columns.
    var noteRow = new Array(TEMPLATE_COLS.length).fill('');
    noteRow.push(
      'Fill in customer quantity',
      'Fill in customer price',
      'Enter Approved or Rejected'
    );
    // Append instruction row after headers at row 2 — uses a separate sheet
    var instructionWs = XLSX.utils.aoa_to_sheet([[
      'Instructions:',
      'Fill in columns "' + COL_CUST_QTY + '", "' + COL_CUST_PRICE + '", and "' + COL_CUST_DECISION + '".',
      'Decision must be "Approved" or "Rejected".',
      'Leave Decision blank if you have no objection but want to adjust quantity or price.',
      'Do not change the ID # column — it is used to match rows on import.',
    ]]);

    XLSX.utils.book_append_sheet(wb, ws, 'TSR ' + tsrSub.replace(/[/\\?*[\]]/g, '-'));
    XLSX.utils.book_append_sheet(wb, instructionWs, 'Instructions');

    var dateStamp = _dateStamp();
    var filename  = 'TSR_Reconciliation_' + tsrSub.replace(/[/\\?*[\]:]/g, '-') +
                    '_' + dateStamp + '.xlsx';
    XLSX.writeFile(wb, filename);
  }

  // ── Excel feedback file parsing ───────────────────────────

  function _parseFeedbackFile(file, callback) {
    var reader = new FileReader();
    reader.onerror = function () {
      callback('Could not read file. Make sure it is a valid Excel (.xlsx) or CSV file.');
    };
    reader.onload = function (e) {
      try {
        var XLSX     = window.XLSX;
        var data     = new Uint8Array(e.target.result);
        var workbook = XLSX.read(data, { type: 'array' });

        // Use the first sheet
        var sheetName = workbook.SheetNames[0];
        var ws        = workbook.Sheets[sheetName];
        var rows      = XLSX.utils.sheet_to_json(ws, {
          defval: '',
          raw:    false   // keep values as strings so dates don't become numbers
        });

        if (!rows.length) {
          callback('The uploaded file appears to be empty.');
          return;
        }

        // Build lookup map keyed by ID# (the 'ID #' header in the template)
        var feedbackMap = {};
        var idKey = _findColumnKey(rows[0], ['ID #', 'ID#', 'id', 'Id']);
        if (!idKey) {
          callback('Could not find an "ID #" column in the uploaded file. ' +
                   'Make sure you uploaded the template exported from this app.');
          return;
        }

        rows.forEach(function (row) {
          var id = String(row[idKey] || '').trim();
          if (id) feedbackMap[id] = row;
        });

        if (!Object.keys(feedbackMap).length) {
          callback('No rows with a valid ID # were found in the uploaded file.');
          return;
        }

        callback(null, feedbackMap);

      } catch (err) {
        callback('Failed to parse the file: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  // Find the column header key from an array of candidate names
  function _findColumnKey(firstRow, candidates) {
    for (var i = 0; i < candidates.length; i++) {
      if (firstRow.hasOwnProperty(candidates[i])) return candidates[i];
    }
    return null;
  }

  // ── IDB helpers ───────────────────────────────────────────

  // Get all distinct TSR Sub# values from IndexedDB (for the datalist)
  function _loadTsrOptions(callback) {
    if (typeof Offline === 'undefined' || !Offline.getAllRows) {
      callback([]);
      return;
    }
    Offline.getAllRows(function (rows) {
      var seen = {};
      var list = [];
      (rows || []).forEach(function (r) {
        var t = String(r.tsr_sub || '').trim();
        if (t && !seen[t]) { seen[t] = true; list.push(t); }
      });
      list.sort();
      callback(list);
    });
  }

  // Get rows matching a specific TSR Sub# from IndexedDB
  function _getRowsByTsr(tsrSub, callback) {
    if (typeof Offline === 'undefined' || !Offline.getAllRows) {
      callback([]);
      return;
    }
    var q = tsrSub.trim().toLowerCase();
    Offline.getAllRows(function (rows) {
      var matched = (rows || []).filter(function (r) {
        return String(r.tsr_sub || '').trim().toLowerCase() === q;
      });
      callback(matched);
    });
  }

  // ── Log helpers ───────────────────────────────────────────

  function _saveLog(counts) {
    var entry = {
      tsrSub:   _tsrSub,
      who:      _userName,
      when:     _nowLabel(),
      approved: counts.approved,
      rejected: counts.rejected,
      skipped:  counts.skipped
    };
    var log = _readLog();
    log.push(entry);
    if (log.length > LOG_MAX) log = log.slice(log.length - LOG_MAX);
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(log));
    } catch (e) { /* non-fatal */ }
  }

  function _readLog() {
    try {
      return JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    } catch (e) { return []; }
  }

  // ── SheetJS loader ────────────────────────────────────────

  function _loadXlsx(callback) {
    if (window.XLSX) { callback(); return; }
    var script  = document.createElement('script');
    script.src  = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    script.onload  = callback;
    script.onerror = function () {
      alert('Could not load the Excel library. Check your internet connection and try again.');
    };
    document.head.appendChild(script);
  }

  // ── Formatting helpers ────────────────────────────────────

  function _fmt(v) {
    var n = Number(v);
    if (isNaN(n)) return String(v || '');
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  function _fmtCurrency(v) {
    var n = Number(v);
    if (isNaN(n)) return String(v || '');
    return '$' + n.toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }

  function _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _nowLabel() {
    var d   = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function _dateStamp() {
    var d   = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  }

  // ── Step pip builder ──────────────────────────────────────

  function _stepPip(num, active) {
    var cls = 'recon-pip' + (active ? ' recon-pip--active' : '');
    return '<span class="' + cls + '">' + num + '</span>';
  }

  function _summaryChip(key, count, label, cls) {
    return '<span class="recon-chip ' + cls + '">' + label + ': <strong>' + count + '</strong></span>';
  }

  // ── Styles ────────────────────────────────────────────────

  function _ensureStyles() {
    if (document.getElementById('reconcile-styles')) return;
    var s = document.createElement('style');
    s.id  = 'reconcile-styles';
    s.textContent = [

      // ── Overlay ────────────────────────────────────────────

      '.recon-overlay {',
        'position: fixed;',
        'inset: 0;',
        'background: rgba(10, 18, 30, 0.72);',
        'z-index: 9000;',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        'padding: 24px;',
      '}',

      '.recon-panel {',
        'background: var(--bg-surface, #fff);',
        'border: 1px solid var(--border, #d0d7e2);',
        'width: 780px;',
        'max-width: 100%;',
        'max-height: calc(100vh - 48px);',
        'display: flex;',
        'flex-direction: column;',
        'box-shadow: 0 24px 64px rgba(0,0,0,0.28);',
      '}',

      // ── Header ─────────────────────────────────────────────

      '.recon-header {',
        'display: flex;',
        'align-items: center;',
        'justify-content: space-between;',
        'height: 48px;',
        'padding: 0 20px;',
        'background: var(--bg-navy, #1a2e4a);',
        'flex-shrink: 0;',
      '}',

      '.recon-title {',
        'font-family: var(--font-display, sans-serif);',
        'font-weight: 700;',
        'font-size: 13px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'color: var(--text-on-navy, #e8edf3);',
        'display: flex;',
        'align-items: center;',
        'gap: 8px;',
      '}',

      '.recon-title-icon {',
        'color: var(--accent, #c9973a);',
        'font-size: 11px;',
      '}',

      '.recon-close {',
        'background: none;',
        'border: none;',
        'color: var(--text-muted-navy, #8fa5bf);',
        'font-size: 22px;',
        'cursor: pointer;',
        'line-height: 1;',
        'padding: 0;',
        'transition: color 0.15s;',
      '}',
      '.recon-close:hover { color: var(--text-on-navy, #e8edf3); }',

      // ── Step pips ──────────────────────────────────────────

      '.recon-steps {',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        'gap: 6px;',
        'padding: 12px 20px;',
        'border-bottom: 1px solid var(--border, #d0d7e2);',
        'background: var(--bg-base, #f0f2f5);',
        'flex-shrink: 0;',
      '}',

      '.recon-pip {',
        'width: 28px;',
        'height: 28px;',
        'border-radius: 50%;',
        'border: 2px solid var(--border, #d0d7e2);',
        'color: var(--text-secondary, #5a6a80);',
        'font-family: var(--font-display, sans-serif);',
        'font-weight: 700;',
        'font-size: 11px;',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
      '}',

      '.recon-pip--active {',
        'background: var(--accent, #c9973a);',
        'border-color: var(--accent, #c9973a);',
        'color: #fff;',
      '}',

      // ── Body ───────────────────────────────────────────────

      '.recon-body {',
        'padding: 20px;',
        'flex: 1;',
        'min-height: 0;',
      '}',

      '.recon-body--scroll {',
        'overflow-y: auto;',
      '}',

      '.recon-body--center {',
        'display: flex;',
        'flex-direction: column;',
        'align-items: center;',
        'justify-content: center;',
        'text-align: center;',
        'padding: 36px 20px;',
      '}',

      '.recon-section-label {',
        'font-family: var(--font-mono, monospace);',
        'font-size: 10px;',
        'letter-spacing: 0.15em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary, #5a6a80);',
        'margin-bottom: 16px;',
        'padding-bottom: 8px;',
        'border-bottom: 1px solid var(--border, #d0d7e2);',
      '}',

      // ── Form controls ──────────────────────────────────────

      '.recon-row {',
        'display: flex;',
        'align-items: center;',
        'gap: 12px;',
        'margin-bottom: 14px;',
      '}',

      '.recon-label {',
        'font-family: var(--font-display, sans-serif);',
        'font-size: 12px;',
        'font-weight: 600;',
        'letter-spacing: 0.06em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary, #5a6a80);',
        'white-space: nowrap;',
      '}',

      '.recon-input {',
        'flex: 1;',
        'height: 34px;',
        'padding: 0 10px;',
        'font-family: var(--font-body, sans-serif);',
        'font-size: 13px;',
        'border: 1.5px solid var(--border, #d0d7e2);',
        'background: #fff;',
        'color: var(--text-primary, #1a2e4a);',
        'outline: none;',
        'transition: border-color 0.15s;',
      '}',
      '.recon-input:focus { border-color: var(--accent, #c9973a); }',

      '.recon-preview {',
        'font-family: var(--font-body, sans-serif);',
        'font-size: 13px;',
        'color: var(--text-secondary, #5a6a80);',
        'margin-bottom: 16px;',
      '}',

      '.recon-count {',
        'display: inline-block;',
        'padding: 4px 10px;',
        'background: var(--accent-dim, rgba(201,151,58,0.12));',
        'color: var(--accent, #c9973a);',
        'font-family: var(--font-mono, monospace);',
        'font-size: 11px;',
        'font-weight: 600;',
        'letter-spacing: 0.06em;',
      '}',

      // ── Upload zone ─────────────────────────────────────────

      '.recon-upload-zone {',
        'border: 2px dashed var(--border, #d0d7e2);',
        'padding: 40px 24px;',
        'text-align: center;',
        'display: flex;',
        'flex-direction: column;',
        'align-items: center;',
        'gap: 14px;',
        'transition: border-color 0.15s, background 0.15s;',
      '}',

      '.recon-upload-zone--drag {',
        'border-color: var(--accent, #c9973a);',
        'background: var(--accent-dim, rgba(201,151,58,0.06));',
      '}',

      '.recon-upload-icon {',
        'font-size: 36px;',
        'color: var(--text-secondary, #5a6a80);',
        'line-height: 1;',
      '}',

      '.recon-upload-text {',
        'font-family: var(--font-body, sans-serif);',
        'font-size: 13px;',
        'color: var(--text-secondary, #5a6a80);',
      '}',

      '.recon-upload-label {',
        'cursor: pointer;',
        'display: inline-flex;',
        'align-items: center;',
      '}',

      '.recon-file-name {',
        'font-family: var(--font-mono, monospace);',
        'font-size: 11px;',
        'color: var(--color-success, #2a7a4a);',
        'padding: 4px 10px;',
        'background: rgba(42,122,74,0.08);',
        'max-width: 100%;',
        'overflow: hidden;',
        'text-overflow: ellipsis;',
        'white-space: nowrap;',
      '}',

      // ── Summary chips ──────────────────────────────────────

      '.recon-summary {',
        'display: flex;',
        'gap: 10px;',
        'flex-wrap: wrap;',
        'margin-bottom: 18px;',
      '}',

      '.recon-summary--done {',
        'margin: 16px 0;',
        'justify-content: center;',
      '}',

      '.recon-chip {',
        'display: inline-flex;',
        'align-items: center;',
        'gap: 6px;',
        'padding: 7px 14px;',
        'font-family: var(--font-body, sans-serif);',
        'font-size: 13px;',
        'border: 1px solid transparent;',
      '}',

      '.recon-chip--ok {',
        'background: rgba(42,122,74,0.08);',
        'color: var(--color-success, #2a7a4a);',
        'border-color: rgba(42,122,74,0.25);',
      '}',

      '.recon-chip--warn {',
        'background: rgba(200,128,10,0.10);',
        'color: var(--color-conflict, #c8800a);',
        'border-color: rgba(200,128,10,0.30);',
      '}',

      '.recon-chip--err {',
        'background: rgba(192,57,43,0.08);',
        'color: var(--color-error, #c0392b);',
        'border-color: rgba(192,57,43,0.25);',
      '}',

      '.recon-chip--muted {',
        'background: rgba(90,106,128,0.08);',
        'color: var(--text-secondary, #5a6a80);',
        'border-color: rgba(90,106,128,0.2);',
      '}',

      // ── Notice ─────────────────────────────────────────────

      '.recon-notice {',
        'font-family: var(--font-body, sans-serif);',
        'font-size: 13px;',
        'color: var(--text-secondary, #5a6a80);',
        'padding: 12px 16px;',
        'background: var(--bg-base, #f0f2f5);',
        'border-left: 3px solid var(--border, #d0d7e2);',
        'margin-bottom: 8px;',
      '}',

      // ── Review table ───────────────────────────────────────

      '.recon-bulk-actions {',
        'display: flex;',
        'align-items: center;',
        'gap: 8px;',
        'margin-bottom: 12px;',
      '}',

      '.recon-review-progress {',
        'margin-left: auto;',
        'font-family: var(--font-mono, monospace);',
        'font-size: 10px;',
        'letter-spacing: 0.1em;',
        'color: var(--text-secondary, #5a6a80);',
      '}',

      '.recon-review-table {',
        'width: 100%;',
        'border-collapse: collapse;',
        'font-family: var(--font-body, sans-serif);',
        'font-size: 12px;',
      '}',

      '.recon-review-table th {',
        'background: var(--bg-base, #f0f2f5);',
        'padding: 8px 10px;',
        'text-align: left;',
        'font-family: var(--font-display, sans-serif);',
        'font-size: 11px;',
        'letter-spacing: 0.08em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary, #5a6a80);',
        'border-bottom: 1px solid var(--border, #d0d7e2);',
        'font-weight: 600;',
      '}',

      '.recon-th-note {',
        'font-family: var(--font-body, sans-serif);',
        'font-weight: 400;',
        'font-size: 10px;',
        'text-transform: none;',
        'letter-spacing: 0;',
        'color: var(--text-secondary, #5a6a80);',
      '}',

      '.recon-review-row td {',
        'padding: 8px 10px;',
        'border-bottom: 1px solid var(--border, #d0d7e2);',
        'vertical-align: middle;',
        'transition: background 0.15s;',
      '}',

      '.recon-review-row:hover td { background: var(--bg-base, #f0f2f5); }',

      '.recon-dec--accept td { background: rgba(42,122,74,0.05) !important; }',
      '.recon-dec--reject td { background: rgba(192,57,43,0.05) !important; }',

      '.recon-review-id {',
        'font-family: var(--font-mono, monospace);',
        'font-size: 11px;',
        'color: var(--text-secondary, #5a6a80);',
        'white-space: nowrap;',
      '}',

      '.recon-review-site {',
        'font-size: 12px;',
        'color: var(--text-secondary, #5a6a80);',
      '}',

      '.recon-review-cell {',
        'display: flex;',
        'align-items: center;',
        'gap: 6px;',
      '}',

      '.recon-review-table td.recon-review-cell {',
        'display: table-cell;',
      '}',

      '.recon-our-val {',
        'color: var(--text-secondary, #5a6a80);',
        'font-family: var(--font-mono, monospace);',
        'font-size: 11px;',
      '}',

      '.recon-arrow {',
        'color: var(--text-secondary, #5a6a80);',
        'font-size: 11px;',
      '}',

      '.recon-cust-val {',
        'font-family: var(--font-mono, monospace);',
        'font-size: 12px;',
        'font-weight: 600;',
      '}',

      '.recon-changed {',
        'color: var(--color-conflict, #c8800a);',
      '}',

      '.recon-same {',
        'font-size: 11px;',
        'color: var(--border, #d0d7e2);',
        'font-style: italic;',
      '}',

      '.recon-review-dec {',
        'white-space: nowrap;',
      '}',

      // ── Decision buttons ───────────────────────────────────

      '.recon-dec-btn {',
        'padding: 4px 10px;',
        'font-family: var(--font-display, sans-serif);',
        'font-size: 10px;',
        'font-weight: 600;',
        'letter-spacing: 0.08em;',
        'text-transform: uppercase;',
        'cursor: pointer;',
        'border: 1.5px solid var(--border, #d0d7e2);',
        'background: #fff;',
        'color: var(--text-secondary, #5a6a80);',
        'margin-right: 4px;',
        'transition: all 0.12s;',
      '}',

      '.recon-dec-accept.active {',
        'background: var(--color-success, #2a7a4a);',
        'border-color: var(--color-success, #2a7a4a);',
        'color: #fff;',
      '}',

      '.recon-dec-reject.active {',
        'background: var(--color-error, #c0392b);',
        'border-color: var(--color-error, #c0392b);',
        'color: #fff;',
      '}',

      '.recon-dec-accept:hover:not(.active) {',
        'border-color: var(--color-success, #2a7a4a);',
        'color: var(--color-success, #2a7a4a);',
      '}',

      '.recon-dec-reject:hover:not(.active) {',
        'border-color: var(--color-error, #c0392b);',
        'color: var(--color-error, #c0392b);',
      '}',

      // ── Toolbar buttons ────────────────────────────────────

      '.recon-actions {',
        'display: flex;',
        'align-items: center;',
        'gap: 10px;',
      '}',

      '.recon-btn {',
        'height: 34px;',
        'padding: 0 16px;',
        'font-family: var(--font-display, sans-serif);',
        'font-weight: 700;',
        'font-size: 11px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'cursor: pointer;',
        'border: 1.5px solid var(--border, #d0d7e2);',
        'background: #fff;',
        'color: var(--text-secondary, #5a6a80);',
        'display: inline-flex;',
        'align-items: center;',
        'gap: 6px;',
        'transition: all 0.12s;',
        'white-space: nowrap;',
      '}',

      '.recon-btn:disabled { opacity: 0.4; cursor: default; }',

      '.recon-btn--primary {',
        'background: var(--accent, #c9973a);',
        'border-color: var(--accent, #c9973a);',
        'color: #fff;',
      '}',
      '.recon-btn--primary:hover:not(:disabled) {',
        'background: var(--accent-bright, #e8b04a);',
        'border-color: var(--accent-bright, #e8b04a);',
      '}',

      '.recon-btn--next {',
        'background: var(--bg-navy, #1a2e4a);',
        'border-color: var(--bg-navy, #1a2e4a);',
        'color: var(--text-on-navy, #e8edf3);',
      '}',
      '.recon-btn--next:hover:not(:disabled) {',
        'background: var(--bg-navy-deep, #0f1e30);',
      '}',

      '.recon-btn--apply {',
        'background: var(--color-success, #2a7a4a);',
        'border-color: var(--color-success, #2a7a4a);',
        'color: #fff;',
      '}',
      '.recon-btn--apply:hover:not(:disabled) {',
        'background: #236340;',
      '}',

      '.recon-btn--ghost {',
        'background: transparent;',
      '}',
      '.recon-btn--ghost:hover:not(:disabled) {',
        'background: var(--bg-base, #f0f2f5);',
        'color: var(--text-primary, #1a2e4a);',
      '}',

      '.recon-btn--danger {',
        'border-color: var(--color-error, #c0392b);',
        'color: var(--color-error, #c0392b);',
      '}',
      '.recon-btn--danger:hover:not(:disabled) {',
        'background: rgba(192,57,43,0.06);',
      '}',

      '.recon-btn--sm { height: 28px; padding: 0 12px; font-size: 10px; }',

      '.recon-btn--right { margin-left: auto; }',

      // ── Footer ─────────────────────────────────────────────

      '.recon-footer {',
        'padding: 14px 20px;',
        'border-top: 1px solid var(--border, #d0d7e2);',
        'display: flex;',
        'align-items: center;',
        'gap: 10px;',
        'background: var(--bg-base, #f0f2f5);',
        'font-family: var(--font-body, sans-serif);',
        'font-size: 12px;',
        'color: var(--text-secondary, #5a6a80);',
        'flex-shrink: 0;',
      '}',

      '.recon-footer .recon-btn--next,',
      '.recon-footer .recon-btn--apply {',
        'margin-left: auto;',
      '}',

      // ── Error ──────────────────────────────────────────────

      '.recon-error {',
        'font-family: var(--font-body, sans-serif);',
        'font-size: 12px;',
        'color: var(--color-error, #c0392b);',
        'margin-top: 10px;',
        'padding: 8px 12px;',
        'background: rgba(192,57,43,0.07);',
        'border-left: 3px solid var(--color-error, #c0392b);',
      '}',

      '.recon-error--full {',
        'padding: 20px;',
        'text-align: center;',
        'font-size: 13px;',
      '}',

      // ── Spinner ────────────────────────────────────────────

      '.recon-spinner {',
        'width: 36px;',
        'height: 36px;',
        'border: 3px solid var(--border, #d0d7e2);',
        'border-top-color: var(--accent, #c9973a);',
        'border-radius: 50%;',
        'animation: recon-spin 0.7s linear infinite;',
        'margin-bottom: 16px;',
      '}',

      '.recon-apply-progress {',
        'font-family: var(--font-mono, monospace);',
        'font-size: 12px;',
        'color: var(--text-secondary, #5a6a80);',
        'letter-spacing: 0.06em;',
      '}',

      '@keyframes recon-spin {',
        'to { transform: rotate(360deg); }',
      '}',

      // ── Done screen ────────────────────────────────────────

      '.recon-done-icon {',
        'width: 64px;',
        'height: 64px;',
        'border-radius: 50%;',
        'background: var(--color-success, #2a7a4a);',
        'color: #fff;',
        'font-size: 30px;',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        'margin-bottom: 16px;',
      '}',

      '.recon-done-title {',
        'font-family: var(--font-display, sans-serif);',
        'font-size: 17px;',
        'font-weight: 700;',
        'letter-spacing: 0.06em;',
        'color: var(--text-primary, #1a2e4a);',
        'margin-bottom: 4px;',
      '}',

      '.recon-done-meta {',
        'font-family: var(--font-mono, monospace);',
        'font-size: 11px;',
        'color: var(--text-secondary, #5a6a80);',
        'margin-top: 16px;',
      '}',

      // ── Log table ──────────────────────────────────────────

      '.recon-log-table {',
        'width: 100%;',
        'border-collapse: collapse;',
        'font-family: var(--font-body, sans-serif);',
        'font-size: 12px;',
      '}',

      '.recon-log-table th {',
        'background: var(--bg-base, #f0f2f5);',
        'padding: 7px 10px;',
        'text-align: left;',
        'font-family: var(--font-display, sans-serif);',
        'font-size: 10px;',
        'letter-spacing: 0.1em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary, #5a6a80);',
        'border-bottom: 1px solid var(--border, #d0d7e2);',
      '}',

      '.recon-log-table td {',
        'padding: 7px 10px;',
        'border-bottom: 1px solid var(--border, #d0d7e2);',
        'color: var(--text-primary, #1a2e4a);',
      '}',

      '.recon-log-empty {',
        'text-align: center;',
        'padding: 24px;',
        'color: var(--text-secondary, #5a6a80);',
        'font-style: italic;',
      '}',

      '.recon-count-ok   { color: var(--color-success, #2a7a4a); font-weight: 700; }',
      '.recon-count-err  { color: var(--color-error, #c0392b);   font-weight: 700; }',
      '.recon-count-muted{ color: var(--text-secondary, #5a6a80); }',

    ].join('\n');
    document.head.appendChild(s);
  }

  // ── Expose ────────────────────────────────────────────────

  return {
    init:               init,
    openPanel:          openPanel,
    wireToolbarButton:  wireToolbarButton
  };

}());
