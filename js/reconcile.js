// ============================================================
// reconcile.js — TSR Reconciliation Workflow
// Telecom Coordinator Tracking App — Stage 4
// ============================================================
//
// Workflow (4 steps):
//   Step 1 — Enter TSR Sub# (e.g. "1262 sub-3")
//             Autocomplete from system tsr_sub values.
//             Filters matching rows from IndexedDB.
//   Step 2 — Upload customer feedback file (.xlsx / .xls / .csv)
//             Parses sheet "PO Break Down- Contractor & Acc".
//             Auto-detects header row (table does not start at A1).
//             Matches rows by: logical_site_id (col H) + line_item (col N).
//             Locates the correct submission column from the sub# suffix.
//             Each submission block = 3 sub-columns: Status | Amount | Qty.
//   Step 3 — Review comparison results before anything is written.
//             REJ        → po_status = 'REJ', no qty change.
//             FAC/PAC/TOC/other → accepted; qty updated if different.
//             User confirms — then changes are applied.
//   Step 4 — Done summary + log entry saved.
//
// Matching key:  logical_site_id  +  line_item  (both normalised lowercase)
// Fields written: actual_quantity (if changed), po_status ('Approved'/'REJ')
//
// Access: Invoicing + Manager only.
//
// Public API:
//   Reconcile.init(role, userName)
//   Reconcile.openPanel()
//   Reconcile.wireToolbarButton()
// ============================================================

var Reconcile = (function () {

  // ── Constants ─────────────────────────────────────────────

  var FEEDBACK_SHEET_PATTERN = /po\s*break\s*down/i;   // partial match on sheet name
  var QTY_TOLERANCE          = 0.001;

  var PO_APPROVED = 'Approved';
  var PO_REJECTED = 'REJ';

  // Ordinal labels used in the customer file headers
  var ORDINALS = ['', '1st', '2nd', '3rd', '4th', '5th', '6th',
                  '7th', '8th', '9th', '10th'];

  var LOG_KEY = 'reconcile_log';
  var LOG_MAX = 50;

  // ── State ─────────────────────────────────────────────────

  var _role      = null;
  var _userName  = null;
  var _panelEl   = null;

  // Active run
  var _tsrSubRaw    = '';   // raw input, e.g. "1262 sub-3"
  var _submNum      = 0;    // parsed submission number, e.g. 3
  var _tsrRows      = [];   // system rows matching tsr_sub
  var _compareResults = []; // [{ sysRow, status, custQty, ourQty, changed }]

  // ── Public ────────────────────────────────────────────────

  function init(role, userName) {
    _role     = role;
    _userName = userName;
  }

  function wireToolbarButton() {
    var btn = document.getElementById('tb-reconcile');
    if (btn) btn.addEventListener('click', openPanel);
  }

  function openPanel() {
    if (_role !== 'invoicing' && _role !== 'manager') return;
    _ensureStyles();
    _resetState();
    _buildOverlay();
    _renderStep1();
  }

  // ── State reset ───────────────────────────────────────────

  function _resetState() {
    _tsrSubRaw      = '';
    _submNum        = 0;
    _tsrRows        = [];
    _compareResults = [];
  }

  // ── Overlay shell ─────────────────────────────────────────

  function _buildOverlay() {
    if (_panelEl && _panelEl.parentNode) _panelEl.parentNode.removeChild(_panelEl);

    var overlay = document.createElement('div');
    overlay.className = 'rc-overlay';
    overlay.id        = 'rc-overlay';

    var panel = document.createElement('div');
    panel.className = 'rc-panel';
    panel.id        = 'rc-panel';
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    _panelEl = overlay;

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) _close();
    });
  }

  function _panel() { return document.getElementById('rc-panel'); }

  function _close() {
    if (_panelEl && _panelEl.parentNode) _panelEl.parentNode.removeChild(_panelEl);
    _panelEl = null;
  }

  // ── Header bar (shared across steps) ─────────────────────

  function _headerHtml(title, step) {
    var pips = [1, 2, 3, 4].map(function (n) {
      var cls = 'rc-pip' + (n === step ? ' rc-pip--on' : (n < step ? ' rc-pip--done' : ''));
      return '<span class="' + cls + '">' + n + '</span>';
    }).join('');

    return [
      '<div class="rc-header">',
        '<div class="rc-title">',
          '<span class="rc-title-arrow">&#9654;</span>',
          'TSR Reconciliation',
          (title ? ' &mdash; <span class="rc-title-sub">' + _esc(title) + '</span>' : ''),
        '</div>',
        '<button class="rc-close" id="rc-close-btn">&times;</button>',
      '</div>',
      '<div class="rc-pips">' + pips + '</div>',
    ].join('');
  }

  function _wireClose() {
    var btn = document.getElementById('rc-close-btn');
    if (btn) btn.addEventListener('click', _close);
  }

  // ══════════════════════════════════════════════════════════
  // STEP 1 — Enter TSR Sub#
  // ══════════════════════════════════════════════════════════

  function _renderStep1() {
    var panel = _panel();
    if (!panel) return;

    panel.innerHTML = [
      _headerHtml('', 1),
      '<div class="rc-body">',
        '<div class="rc-section-lbl">Step 1 — Enter TSR Sub#</div>',
        '<div class="rc-field-row">',
          '<label class="rc-lbl" for="rc-tsr-input">TSR Sub#</label>',
          '<input id="rc-tsr-input" class="rc-input" type="text"',
            ' list="rc-tsr-list" placeholder="e.g. 1262 sub-3" autocomplete="off">',
          '<datalist id="rc-tsr-list"></datalist>',
        '</div>',
        '<div id="rc-tsr-preview" class="rc-preview" hidden></div>',
      '</div>',
      '<div class="rc-footer">',
        '<span class="rc-footer-hint">Enter the TSR Sub# to find matching rows.</span>',
        '<button class="rc-btn rc-btn--next" id="rc-step1-next" disabled>',
          'Upload Feedback &#8658;',
        '</button>',
      '</div>',
    ].join('');

    _wireClose();

    // Populate datalist
    _loadTsrOptions(function (list) {
      var dl = document.getElementById('rc-tsr-list');
      if (!dl) return;
      list.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v;
        dl.appendChild(o);
      });
    });

    var input   = document.getElementById('rc-tsr-input');
    var preview = document.getElementById('rc-tsr-preview');
    var nextBtn = document.getElementById('rc-step1-next');

    input.addEventListener('input', function () {
      var val = this.value.trim();
      _tsrSubRaw = val;

      if (!val) {
        _tsrRows = [];
        nextBtn.disabled = true;
        preview.setAttribute('hidden', '');
        return;
      }

      _getRowsByTsr(val, function (rows) {
        _tsrRows = rows;
        nextBtn.disabled = (rows.length === 0);
        preview.removeAttribute('hidden');
        preview.textContent = rows.length
          ? rows.length + ' row' + (rows.length !== 1 ? 's' : '') +
            ' found for \u201c' + val + '\u201d'
          : 'No rows found for \u201c' + val + '\u201d';
        preview.className = 'rc-preview ' + (rows.length ? 'rc-preview--ok' : 'rc-preview--warn');
      });
    });

    nextBtn.addEventListener('click', function () {
      var parsed = _parseSubmissionNum(_tsrSubRaw);
      if (!parsed) {
        _showInlineError(preview, 'Could not detect a submission number. Use format: "1262 sub-3".');
        return;
      }
      _submNum = parsed;
      _renderStep2();
    });

    input.focus();
  }

  // ══════════════════════════════════════════════════════════
  // STEP 2 — Upload Customer Feedback File
  // ══════════════════════════════════════════════════════════

  function _renderStep2() {
    var panel = _panel();
    if (!panel) return;

    panel.innerHTML = [
      _headerHtml(_tsrSubRaw, 2),
      '<div class="rc-body">',
        '<div class="rc-section-lbl">Step 2 — Upload Customer Feedback</div>',
        '<div class="rc-upload-zone" id="rc-drop-zone">',
          '<div class="rc-upload-icon">&#8671;</div>',
          '<div class="rc-upload-text">Drop the customer file here, or</div>',
          '<label class="rc-btn rc-btn--primary rc-upload-lbl">',
            'Browse File',
            '<input type="file" id="rc-file-input" accept=".xlsx,.xls,.csv" style="display:none">',
          '</label>',
          '<div id="rc-file-name" class="rc-file-name" hidden></div>',
        '</div>',
        '<div id="rc-parse-area" class="rc-parse-area" hidden>',
          '<div class="rc-prog-label-row">',
            '<span id="rc-prog-label" class="rc-prog-label">Reading file\u2026</span>',
            '<span id="rc-prog-pct"   class="rc-prog-pct">0%</span>',
          '</div>',
          '<div class="rc-prog-track">',
            '<div id="rc-prog-bar" class="rc-prog-bar" style="width:0%"></div>',
          '</div>',
          '<div id="rc-parse-msg" class="rc-parse-msg" hidden></div>',
        '</div>',
      '</div>',
      '<div class="rc-footer">',
        '<button class="rc-btn rc-btn--ghost" id="rc-back-1">&#8592; Back</button>',
        '<button class="rc-btn rc-btn--next" id="rc-step2-next" disabled>',
          'Review Results &#8658;',
        '</button>',
      '</div>',
    ].join('');

    _wireClose();
    document.getElementById('rc-back-1').addEventListener('click', _renderStep1);

    var fileInput  = document.getElementById('rc-file-input');
    var fileNameEl = document.getElementById('rc-file-name');
    var parseArea  = document.getElementById('rc-parse-area');
    var parseMsg   = document.getElementById('rc-parse-msg');
    var progBar    = document.getElementById('rc-prog-bar');
    var progPct    = document.getElementById('rc-prog-pct');
    var progLabel  = document.getElementById('rc-prog-label');
    var nextBtn    = document.getElementById('rc-step2-next');
    var dropZone   = document.getElementById('rc-drop-zone');

    var _feedbackData = null;

    function _setProgress(pct, label) {
      var p = Math.round(pct);
      progBar.style.width   = p + '%';
      progBar.style.background = p === 100
        ? 'var(--color-success, #2a7a4a)'
        : 'var(--accent, #c9973a)';
      progPct.textContent   = p + '%';
      if (label) progLabel.textContent = label;
    }

    function handleFile(file) {
      if (!file) return;
      fileNameEl.textContent = file.name;
      fileNameEl.removeAttribute('hidden');
      parseMsg.setAttribute('hidden', '');
      parseArea.removeAttribute('hidden');
      nextBtn.disabled  = true;
      _feedbackData     = null;

      _setProgress(0, 'Reading file\u2026');

      _loadXlsx(function () {
        var reader = new FileReader();

        reader.onprogress = function (e) {
          if (e.lengthComputable) {
            _setProgress((e.loaded / e.total) * 70, 'Reading file\u2026');
          }
        };

        reader.onload = function (e) {
          _setProgress(75, 'Parsing rows\u2026');
          // Yield to the browser so the bar repaints before the sync XLSX parse
          setTimeout(function () {
            _parseFeedbackFile(e, _submNum, function (err, data) {
              if (err) {
                _setProgress(100, 'Error');
                progBar.style.background = 'var(--color-error, #c0392b)';
                _showParseMsg(parseMsg, err, 'error');
                return;
              }
              _setProgress(100, 'Done');
              _feedbackData = data;
              _showParseMsg(parseMsg,
                data.rows.length + ' rows parsed from ' +
                (ORDINALS[_submNum] || _submNum + 'th') +
                ' submission column.', 'ok');
              nextBtn.disabled = false;
            });
          }, 30);
        };

        reader.onerror = function () {
          _setProgress(100, 'Read error');
          progBar.style.background = 'var(--color-error, #c0392b)';
          _showParseMsg(parseMsg,
            'Could not read the file. Make sure it is a valid Excel or CSV file.',
            'error');
        };

        reader.readAsArrayBuffer(file);
      });
    }

    fileInput.addEventListener('change', function () {
      if (this.files && this.files[0]) handleFile(this.files[0]);
    });

    dropZone.addEventListener('dragover', function (e) {
      e.preventDefault();
      dropZone.classList.add('rc-upload-zone--drag');
    });
    dropZone.addEventListener('dragleave', function () {
      dropZone.classList.remove('rc-upload-zone--drag');
    });
    dropZone.addEventListener('drop', function (e) {
      e.preventDefault();
      dropZone.classList.remove('rc-upload-zone--drag');
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    nextBtn.addEventListener('click', function () {
      if (!_feedbackData) return;
      _compareResults = _buildComparison(_tsrRows, _feedbackData.rows);
      _renderStep3();
    });
  }

  // ══════════════════════════════════════════════════════════
  // STEP 3 — Review & Confirm
  // ══════════════════════════════════════════════════════════

  function _renderStep3() {
    var panel = _panel();
    if (!panel) return;

    var results     = _compareResults;
    var accepted    = results.filter(function (r) { return r.status === 'accepted'; });
    var rejected    = results.filter(function (r) { return r.status === 'rejected'; });
    var rcChanged   = accepted.filter(function (r) { return r.rcChanged; });
    var notFound    = results.filter(function (r) { return r.status === 'not_found'; });

    var tableRows = results.map(function (r) {
      var rowCls = r.status === 'rejected'  ? 'rc-row--rej'
                 : r.status === 'not_found' ? 'rc-row--missing'
                 : r.rcChanged             ? 'rc-row--changed'
                 :                            'rc-row--ok';

      // RC Quantity column
      var qtyCellHtml;
      if (r.status === 'not_found') {
        qtyCellHtml = '<span class="rc-muted">&#8213;</span>';
      } else if (r.status === 'rejected') {
        qtyCellHtml = '<span class="rc-muted">' + _fmt(r.ourRcQty) + '</span>';
      } else if (r.rcChanged) {
        qtyCellHtml = '<span class="rc-old-val">' + _fmt(r.ourRcQty) + '</span>' +
                      ' <span class="rc-arrow">&#8594;</span> ' +
                      '<span class="rc-new-val">' + _fmt(r.custRcQty) + '</span>';
      } else {
        qtyCellHtml = '<span class="rc-ok-val">' + _fmt(r.ourRcQty) + '</span>';
      }

      // Distance + Abs Qty change column (only shown when RC changed)
      var changeCellHtml = '';
      if (r.rcChanged) {
        var currentDist  = String(r.sysRow.distance          || '').trim();
        var currentAbsQty = Number(r.sysRow.absolute_quantity || 0);

        if (r.distChanged) {
          changeCellHtml += '<span class="rc-change-item">' +
            '<span class="rc-change-lbl">Dist:</span> ' +
            '<span class="rc-old-val">' + _esc(currentDist) + '</span>' +
            ' <span class="rc-arrow">&#8594;</span> ' +
            '<span class="rc-new-val">' + _esc(r.newDistance) + '</span>' +
            '</span>';
        }
        if (r.absQtyChanged) {
          changeCellHtml += '<span class="rc-change-item">' +
            '<span class="rc-change-lbl">Qty:</span> ' +
            '<span class="rc-old-val">' + _fmt(currentAbsQty) + '</span>' +
            ' <span class="rc-arrow">&#8594;</span> ' +
            '<span class="rc-new-val">' + _fmt(r.newAbsQty) + '</span>' +
            '</span>';
        }
      }

      var statusBadgeHtml = r.status === 'not_found'
        ? '<span class="rc-badge rc-badge--missing">Not Found</span>'
        : r.status === 'rejected'
        ? '<span class="rc-badge rc-badge--rej">REJ</span>'
        : r.rcChanged
        ? '<span class="rc-badge rc-badge--changed">Updated</span>'
        : '<span class="rc-badge rc-badge--ok">Approved</span>';

      return [
        '<tr class="' + rowCls + '">',
          '<td class="rc-td-mono">' + _esc(String(r.sysRow.logical_site_id || '')) + '</td>',
          '<td class="rc-td-desc">' + _esc(String(r.sysRow.line_item || '')) + '</td>',
          '<td>' + qtyCellHtml + '</td>',
          '<td class="rc-td-changes">' + (changeCellHtml || '<span class="rc-muted">&#8213;</span>') + '</td>',
          '<td>' + _esc(r.custStatus || '') + '</td>',
          '<td>' + statusBadgeHtml + '</td>',
        '</tr>',
      ].join('');
    }).join('');

    panel.innerHTML = [
      _headerHtml(_tsrSubRaw, 3),
      '<div class="rc-body rc-body--scroll">',
        '<div class="rc-section-lbl">Step 3 — Review Changes</div>',
        '<div class="rc-chips">',
          _chip(accepted.length - rcChanged.length, 'Approved',    'chip--ok'),
          _chip(rcChanged.length,                   'Updated',     'chip--changed'),
          _chip(rejected.length,                    'Rejected',    'chip--rej'),
          notFound.length ? _chip(notFound.length,  'Not Found',   'chip--missing') : '',
        '</div>',
        '<div class="rc-notice">Review the changes below. Click <strong>Apply</strong> to write them to the system.</div>',
        '<table class="rc-table">',
          '<thead><tr>',
            '<th>Site ID</th>',
            '<th>Line Item</th>',
            '<th>RC Quantity <span class="rc-th-note">Ours &rarr; Customer</span></th>',
            '<th>Field Changes <span class="rc-th-note">Dist / Qty</span></th>',
            '<th>Status</th>',
            '<th>Outcome</th>',
          '</tr></thead>',
          '<tbody>' + tableRows + '</tbody>',
        '</table>',
      '</div>',
      '<div class="rc-footer">',
        '<button class="rc-btn rc-btn--ghost" id="rc-back-2">&#8592; Back</button>',
        '<button class="rc-btn rc-btn--apply" id="rc-apply-btn">',
          'Apply Changes &#8658;',
        '</button>',
      '</div>',
    ].join('');

    _wireClose();
    document.getElementById('rc-back-2').addEventListener('click', _renderStep2);
    document.getElementById('rc-apply-btn').addEventListener('click', _applyChanges);
  }

  // ══════════════════════════════════════════════════════════
  // STEP 4 — Apply + Done
  // ══════════════════════════════════════════════════════════

  function _applyChanges() {
    var payload = _buildWritePayload();

    if (!payload.length) {
      _renderDone({ approved: 0, rejected: 0, qtyUpdated: 0, notFound: 0 });
      return;
    }

    // Show spinner
    var panel = _panel();
    if (panel) {
      var body = panel.querySelector('.rc-body');
      if (body) {
        body.innerHTML = [
          '<div class="rc-applying">',
            '<div class="rc-spinner"></div>',
            '<div id="rc-apply-prog" class="rc-apply-prog">',
              'Writing ' + payload.length + ' rows\u2026',
            '</div>',
          '</div>',
        ].join('');
      }
    }

    Sheets.writeBatch(payload, function (done, total) {
      var el = document.getElementById('rc-apply-prog');
      if (el) el.textContent = 'Writing ' + done + ' of ' + total + ' rows\u2026';
    }, function (result) {
      if (!result.success) {
        _renderApplyError(result.error || 'Batch write failed.');
        return;
      }

      // Update IDB so the grid reflects changes immediately
      var updatedRows = payload.map(function (wr) {
        var orig = _tsrRows.find(function (r) {
          return String(r._row_index) === String(wr._row_index);
        });
        return orig ? Object.assign({}, orig, wr) : null;
      }).filter(Boolean);

      if (typeof Offline !== 'undefined' && Offline.storeRows) {
        Offline.storeRows(updatedRows);
      }

      var counts = _countOutcomes();
      _saveLog(counts);
      _renderDone(counts);
    });
  }

  function _buildWritePayload() {
    var payload = [];
    _compareResults.forEach(function (r) {
      if (!r.sysRow || !r.sysRow._row_index) return;
      if (r.status === 'not_found') return;

      var update = { _row_index: r.sysRow._row_index };

      if (r.status === 'rejected') {
        update.po_status = PO_REJECTED;
      } else {
        update.po_status = PO_APPROVED;

        if (r.rcChanged) {
          // Always write the resolved distance + absolute_quantity + actual_quantity
          update.distance          = r.newDistance;
          update.absolute_quantity = r.newAbsQty;
          update.actual_quantity   = r.custRcQty;

          // Recalculate new_total_price = unit_price × RC_quantity
          var price = Number(r.sysRow.new_price || 0);
          if (price) update.new_total_price = _round4(price * r.custRcQty);
        }
      }

      payload.push(update);
    });
    return payload;
  }

  function _countOutcomes() {
    var approved   = 0, rejected = 0, qtyUpdated = 0, notFound = 0;
    _compareResults.forEach(function (r) {
      if      (r.status === 'not_found') notFound++;
      else if (r.status === 'rejected')  rejected++;
      else {
        approved++;
        if (r.rcChanged) qtyUpdated++;
      }
    });
    return { approved: approved, rejected: rejected, qtyUpdated: qtyUpdated, notFound: notFound };
  }

  function _renderDone(counts) {
    var panel = _panel();
    if (!panel) return;

    panel.innerHTML = [
      _headerHtml(_tsrSubRaw, 4),
      '<div class="rc-body rc-body--center">',
        '<div class="rc-done-icon">&#10003;</div>',
        '<div class="rc-done-title">Reconciliation Complete</div>',
        '<div class="rc-chips rc-chips--center">',
          _chip(counts.approved,   'Approved', 'chip--ok'),
          _chip(counts.qtyUpdated, 'Updated',  'chip--changed'),
          _chip(counts.rejected,   'Rejected', 'chip--rej'),
          counts.notFound ? _chip(counts.notFound, 'Not Found', 'chip--missing') : '',
        '</div>',
        '<div class="rc-done-meta">',
          'Logged by ' + _esc(_userName) + ' &mdash; ' + _nowLabel(),
        '</div>',
      '</div>',
      '<div class="rc-footer">',
        '<button class="rc-btn rc-btn--ghost" id="rc-new-run">New Reconciliation</button>',
        '<button class="rc-btn rc-btn--primary" id="rc-done-close">Done</button>',
      '</div>',
    ].join('');

    _wireClose();
    document.getElementById('rc-done-close').addEventListener('click', _close);
    document.getElementById('rc-new-run').addEventListener('click', function () {
      _resetState();
      _renderStep1();
    });
  }

  function _renderApplyError(msg) {
    var panel = _panel();
    var body  = panel && panel.querySelector('.rc-body');
    if (!body) return;
    body.innerHTML = [
      '<div class="rc-error-full">',
        '<strong>Write failed</strong><br>' + _esc(msg),
        '<br><br>',
        '<button class="rc-btn rc-btn--ghost" id="rc-err-close">Close</button>',
      '</div>',
    ].join('');
    document.getElementById('rc-err-close').addEventListener('click', _close);
  }

  // ══════════════════════════════════════════════════════════
  // Comparison logic
  // ══════════════════════════════════════════════════════════

  function _buildComparison(sysRows, feedbackRows) {
    var feedMap = {};
    feedbackRows.forEach(function (fr) {
      var key = _matchKey(fr.siteId, fr.lineItem);
      if (key) feedMap[key] = fr;
    });

    return sysRows.map(function (sysRow) {
      var key = _matchKey(
        String(sysRow.logical_site_id || ''),
        String(sysRow.line_item       || '')
      );
      var fr = feedMap[key];

      if (!fr) {
        return {
          sysRow: sysRow, status: 'not_found', custStatus: '',
          ourRcQty: Number(sysRow.actual_quantity || 0)
        };
      }

      var custStatus = String(fr.status || '').trim().toUpperCase();
      var ourRcQty   = Number(sysRow.actual_quantity   || 0);

      if (custStatus === 'REJ') {
        return { sysRow: sysRow, status: 'rejected', custStatus: custStatus, ourRcQty: ourRcQty };
      }

      // Accepted — compare RC quantities
      var custRcQty   = fr.quantity !== '' && fr.quantity !== null ? Number(fr.quantity) : NaN;
      var rcChanged   = !isNaN(custRcQty) && Math.abs(custRcQty - ourRcQty) > QTY_TOLERANCE;

      if (!rcChanged) {
        return {
          sysRow: sysRow, status: 'accepted', custStatus: custStatus,
          ourRcQty: ourRcQty, custRcQty: ourRcQty, rcChanged: false
        };
      }

      // Reverse-engineer which (distance, absQty) pair produces custRcQty
      var resolved = _resolveDistanceAndQty(custRcQty, sysRow);

      return {
        sysRow:       sysRow,
        status:       'accepted',
        custStatus:   custStatus,
        ourRcQty:     ourRcQty,
        custRcQty:    custRcQty,
        rcChanged:    true,
        // resolved fields to write back
        newDistance:  resolved.distance,
        newAbsQty:    resolved.absQty,
        distChanged:  resolved.distance !== String(sysRow.distance || '').trim(),
        absQtyChanged: Math.abs(resolved.absQty - Number(sysRow.absolute_quantity || 0)) > QTY_TOLERANCE
      };
    });
  }

  // ── Reverse-engineering: custRCQty → (distance, absolute_quantity) ──
  //
  // RC Quantity = absolute_quantity × distance_multiplier
  //
  // Step 1: Try every distance multiplier.  If custRCQty / multiplier is
  //         a whole number, that multiplier is the right distance bracket
  //         and the absolute_quantity = that whole number.
  //
  // Step 2: Among whole-number candidates, prefer the one where the
  //         resulting absQty is closest to the row's current absQty.
  //
  // Step 3: If no multiplier gives a whole number, keep the row's current
  //         distance bracket and compute absQty = custRCQty / currentMult.
  //
  // Returns { distance: string, absQty: number }

  function _resolveDistanceAndQty(custRcQty, sysRow) {
    var distMults    = (typeof Pricing !== 'undefined' && Pricing.getAllDistanceMults)
                       ? Pricing.getAllDistanceMults()
                       : [];

    var currentDist  = String(sysRow.distance || '').trim();
    var currentAbsQty = Number(sysRow.absolute_quantity || 0);

    // Current multiplier (fallback to 1 if distance not found)
    var currentMult  = (typeof Pricing !== 'undefined' && Pricing.getDistanceMultiplier)
                       ? Pricing.getDistanceMultiplier(currentDist)
                       : 1;

    // Look for a multiplier that produces a whole-number absolute quantity
    var integerCandidates = [];
    distMults.forEach(function (dm) {
      var implied = custRcQty / dm.multiplier;
      var rounded = Math.round(implied);
      if (Math.abs(implied - rounded) < QTY_TOLERANCE) {
        integerCandidates.push({
          distance: dm.range,
          absQty:   rounded,
          delta:    Math.abs(rounded - currentAbsQty)
        });
      }
    });

    if (integerCandidates.length) {
      // Pick the candidate whose absolute qty is closest to the current one
      integerCandidates.sort(function (a, b) { return a.delta - b.delta; });
      return {
        distance: integerCandidates[0].distance,
        absQty:   integerCandidates[0].absQty
      };
    }

    // No whole-number result — keep current distance, compute fractional absQty
    var newAbsQty = currentMult > 0
      ? _round4(custRcQty / currentMult)
      : custRcQty;

    return { distance: currentDist, absQty: newAbsQty };
  }

  function _round4(n) {
    return Math.round(n * 10000) / 10000;
  }

  function _matchKey(siteId, lineItem) {
    var s = String(siteId  || '').trim().toLowerCase();
    var l = String(lineItem|| '').trim().toLowerCase();
    if (!s && !l) return null;
    return s + '|' + l;
  }

  // ══════════════════════════════════════════════════════════
  // File parsing
  // ══════════════════════════════════════════════════════════

  // Accepts either a File object (old callers) or a FileReader onload event
  // (new path — handleFile now owns the FileReader for progress tracking).
  function _parseFeedbackFile(fileOrEvent, submNum, callback) {
    // If called with a FileReader onload event, parse directly from the buffer
    if (fileOrEvent && fileOrEvent.target && fileOrEvent.target.result) {
      _doParse(fileOrEvent.target.result, submNum, callback);
      return;
    }
    // Legacy path: called with a File object — read it here
    var reader = new FileReader();
    reader.onerror = function () {
      callback('Could not read the file. Make sure it is a valid Excel or CSV file.');
    };
    reader.onload = function (e) { _doParse(e.target.result, submNum, callback); };
    reader.readAsArrayBuffer(fileOrEvent);
  }

  function _doParse(buffer, submNum, callback) {
      try {
        var XLSX     = window.XLSX;
        var data     = new Uint8Array(buffer);
        var workbook = XLSX.read(data, { type: 'array' });

        // Find the target sheet
        var sheetName = _findSheetName(workbook.SheetNames, FEEDBACK_SHEET_PATTERN);
        if (!sheetName) {
          // Fall back to first sheet if no matching tab found
          sheetName = workbook.SheetNames[0];
          if (!sheetName) { callback('No sheets found in the uploaded file.'); return; }
        }

        var ws   = workbook.Sheets[sheetName];
        // raw: array of arrays (each inner array = one row, values by column index)
        var raw  = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

        if (!raw || raw.length < 2) {
          callback('The sheet "' + sheetName + '" appears to be empty.');
          return;
        }

        // Find the data header row
        var headerIdx = _findHeaderRow(raw);
        if (headerIdx < 0) {
          callback('Could not find the data header row (expected "Site ID" near column H).');
          return;
        }

        var headerRow  = raw[headerIdx];
        var siteIdCol  = _findCol(headerRow, ['site id', 'site_id'], 7);  // default col H = 7
        var lineItemCol= _findCol(headerRow, ['item description', 'description', 'item desc', 'catalogue'], 13); // default col N = 13

        // Find submission feedback columns.
        // _findSubmissionCol scans the header area BOTTOM-UP so the label row
        // nearest the data (not the summary banner at the top) is used.
        var submColIdx = _findSubmissionCol(raw, submNum, 0, headerIdx + 2);
        if (submColIdx < 0) {
          callback(
            'Could not find the ' + (ORDINALS[submNum] || submNum + 'th') +
            ' Submission FeedBack column in the file.'
          );
          return;
        }

        // The "Nth Submission FeedBack" label may be in a merged/summary cell that
        // sits 1–2 columns to the LEFT of where FAC/REJ values actually appear in
        // data rows.  _resolveStatusCol checks data rows near submColIdx to find
        // the real status column, then qty = statusCol + 2 (Status | Amount | Qty).
        var statusCol = _resolveStatusCol(raw, headerIdx, submColIdx);
        var qtyCol    = statusCol + 2;

        // Parse data rows
        var rows = [];
        for (var i = headerIdx + 1; i < raw.length; i++) {
          var row     = raw[i];
          var siteVal = String(row[siteIdCol]   || '').trim();
          var descVal = String(row[lineItemCol] || '').trim();
          if (!siteVal && !descVal) continue; // blank row

          rows.push({
            siteId:   siteVal,
            lineItem: descVal,
            status:   String(row[statusCol] || '').trim(),
            quantity: row[qtyCol] !== '' ? row[qtyCol] : ''
          });
        }

        if (!rows.length) {
          callback('No data rows found in the sheet after the header row.');
          return;
        }

        callback(null, { rows: rows, sheetName: sheetName });

      } catch (err) {
        callback('Failed to parse the file: ' + err.message);
      }
  }

  function _findSheetName(names, pattern) {
    for (var i = 0; i < names.length; i++) {
      if (pattern.test(names[i])) return names[i];
    }
    return null;
  }

  // Scan rows 0..maxRow for a row that has something like "Site ID" near index 7
  function _findHeaderRow(raw) {
    for (var i = 0; i < Math.min(raw.length, 25); i++) {
      var row = raw[i] || [];
      for (var c = 5; c <= 10; c++) {
        var cell = String(row[c] || '').trim().toLowerCase();
        if (cell === 'site id' || cell === 'site_id' || cell === 'siteid') {
          return i;
        }
      }
    }
    // Broader fallback: look for any row with "site" + "item description"
    for (var i = 0; i < Math.min(raw.length, 30); i++) {
      var row = raw[i] || [];
      var hasSite = false, hasItem = false;
      for (var c = 0; c < row.length; c++) {
        var cell = String(row[c] || '').toLowerCase();
        if (cell.includes('site id')) hasSite = true;
        if (cell.includes('item desc') || cell.includes('description')) hasItem = true;
      }
      if (hasSite && hasItem) return i;
    }
    return -1;
  }

  // Find column index for a header; candidates are lowercase search terms.
  // defaultCol is returned if no match found (positional fallback).
  function _findCol(headerRow, candidates, defaultCol) {
    for (var c = 0; c < headerRow.length; c++) {
      var h = String(headerRow[c] || '').trim().toLowerCase();
      for (var k = 0; k < candidates.length; k++) {
        if (h.includes(candidates[k])) return c;
      }
    }
    return defaultCol;
  }

  // Scan rows[startRow..endRow] for "Nth Submission FeedBack" (or similar).
  // Scans BOTTOM-UP so the label row nearest the data area is matched first,
  // avoiding the summary/total banner rows near the top of the file.
  // Returns the column index of the matching cell, or -1 if not found.
  function _findSubmissionCol(raw, submNum, startRow, endRow) {
    var ordinal = (ORDINALS[submNum] || (submNum + 'th')).toLowerCase(); // "3rd"
    endRow = Math.min(endRow, raw.length - 1);

    // Primary: bottom-up ordinal match
    for (var i = endRow; i >= startRow; i--) {
      var row = raw[i] || [];
      for (var c = 0; c < row.length; c++) {
        var cell = String(row[c] || '').trim().toLowerCase();
        if (cell.indexOf(ordinal) === 0 &&
            (cell.includes('feedback') || cell.includes('submission') ||
             cell.includes('receiving') || cell.includes('sub'))) {
          return c;
        }
      }
    }

    // Fallback: find the row with the MOST submission-related headers (the main
    // submission header row), then return the Nth column in that row left-to-right.
    var bestRow = -1, bestCount = 0;
    for (var i = startRow; i <= endRow; i++) {
      var count = 0;
      var row   = raw[i] || [];
      for (var c = 0; c < row.length; c++) {
        var cell = String(row[c] || '').trim().toLowerCase();
        if (cell && (cell.includes('submission') || cell.includes('feedback') ||
                     cell.includes('receiving'))) count++;
      }
      if (count > bestCount) { bestCount = count; bestRow = i; }
    }

    if (bestRow >= 0) {
      var row = raw[bestRow] || [];
      var nth = 0;
      for (var c = 0; c < row.length; c++) {
        var cell = String(row[c] || '').trim().toLowerCase();
        if (cell && (cell.includes('submission') || cell.includes('feedback') ||
                     cell.includes('receiving'))) {
          nth++;
          if (nth === submNum) return c;
        }
      }
    }

    return -1;
  }

  // After finding the candidate column from headers, verify it against actual data rows.
  // The "Nth Submission FeedBack" label is sometimes in a merged/summary cell that sits
  // 1–2 columns to the LEFT of where FAC/REJ values actually appear in data rows.
  // Scans candidateCol to candidateCol+3 and returns the first column that has
  // recognisable status values (FAC, PAC, TOC, REJ, or blank) in data rows.
  function _resolveStatusCol(raw, headerIdx, candidateCol) {
    var statusPattern = /^(fac|pac|toc|rej|reject|)$/i;

    for (var offset = 0; offset <= 3; offset++) {
      var col = candidateCol + offset;
      var hasStatus = false;

      for (var i = headerIdx + 1; i < Math.min(raw.length, headerIdx + 20); i++) {
        var row = raw[i] || [];
        var val = String(row[col] || '').trim();
        // Must have at least one non-blank status value in this column
        if (val && statusPattern.test(val)) {
          hasStatus = true;
          break;
        }
      }

      if (hasStatus) return col;
    }

    return candidateCol; // fallback — keep original if nothing found
  }

  // ══════════════════════════════════════════════════════════
  // IDB helpers
  // ══════════════════════════════════════════════════════════

  function _loadTsrOptions(callback) {
    if (typeof Offline === 'undefined' || !Offline.getAllRows) { callback([]); return; }
    Offline.getAllRows(function (rows) {
      var seen = {}, list = [];
      (rows || []).forEach(function (r) {
        var t = String(r.tsr_sub || '').trim();
        if (t && !seen[t]) { seen[t] = true; list.push(t); }
      });
      list.sort();
      callback(list);
    });
  }

  function _getRowsByTsr(tsrSub, callback) {
    if (typeof Offline === 'undefined' || !Offline.getAllRows) { callback([]); return; }
    var q = tsrSub.trim().toLowerCase();
    Offline.getAllRows(function (rows) {
      callback((rows || []).filter(function (r) {
        return String(r.tsr_sub || '').trim().toLowerCase() === q;
      }));
    });
  }

  // ══════════════════════════════════════════════════════════
  // Log
  // ══════════════════════════════════════════════════════════

  function _saveLog(counts) {
    var log = _readLog();
    log.push({
      tsrSub:     _tsrSubRaw,
      who:        _userName,
      when:       _nowLabel(),
      approved:   counts.approved,
      rejected:   counts.rejected,
      qtyUpdated: counts.qtyUpdated,
      notFound:   counts.notFound
    });
    if (log.length > LOG_MAX) log = log.slice(-LOG_MAX);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch (e) {}
  }

  function _readLog() {
    try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; }
  }

  // ══════════════════════════════════════════════════════════
  // SheetJS loader
  // ══════════════════════════════════════════════════════════

  function _loadXlsx(callback) {
    if (window.XLSX) { callback(); return; }
    var s   = document.createElement('script');
    s.src   = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = callback;
    s.onerror = function () {
      alert('Could not load the Excel library. Check your internet connection and try again.');
    };
    document.head.appendChild(s);
  }

  // ══════════════════════════════════════════════════════════
  // Helpers
  // ══════════════════════════════════════════════════════════

  // Extract submission number from "1262 sub-3" → 3
  function _parseSubmissionNum(str) {
    var m = str.match(/sub[-\s]*(\d+)/i);
    if (m) return parseInt(m[1], 10);
    // Fallback: last number in the string
    var nums = str.match(/\d+/g);
    if (nums && nums.length >= 2) return parseInt(nums[nums.length - 1], 10);
    return 0;
  }

  function _fmt(v) {
    var n = Number(v);
    if (isNaN(n)) return String(v || '');
    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }

  function _esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _nowLabel() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function _chip(count, label, cls) {
    return '<span class="rc-chip ' + cls + '">' +
             label + ': <strong>' + count + '</strong>' +
           '</span>';
  }

  function _showParseMsg(el, msg, type) {
    el.textContent = msg;
    el.className   = 'rc-parse-msg rc-parse-msg--' + type;
    el.removeAttribute('hidden');
  }

  function _showInlineError(el, msg) {
    el.textContent = msg;
    el.className   = 'rc-preview rc-preview--warn';
    el.removeAttribute('hidden');
  }

  // ══════════════════════════════════════════════════════════
  // Styles
  // ══════════════════════════════════════════════════════════

  function _ensureStyles() {
    if (document.getElementById('rc-styles')) return;
    var s = document.createElement('style');
    s.id  = 'rc-styles';
    s.textContent = [

      '.rc-overlay{position:fixed;inset:0;background:rgba(10,18,30,0.72);z-index:9000;',
        'display:flex;align-items:center;justify-content:center;padding:24px;}',

      '.rc-panel{background:var(--bg-surface,#fff);border:1px solid var(--border,#d0d7e2);',
        'width:800px;max-width:100%;max-height:calc(100vh - 48px);',
        'display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,0.28);}',

      // Header
      '.rc-header{display:flex;align-items:center;justify-content:space-between;',
        'height:48px;padding:0 20px;background:var(--bg-navy,#1a2e4a);flex-shrink:0;}',
      '.rc-title{font-family:var(--font-display,sans-serif);font-weight:700;font-size:13px;',
        'letter-spacing:0.12em;text-transform:uppercase;color:var(--text-on-navy,#e8edf3);',
        'display:flex;align-items:center;gap:8px;}',
      '.rc-title-arrow{color:var(--accent,#c9973a);font-size:11px;}',
      '.rc-title-sub{font-weight:500;color:var(--text-muted-navy,#8fa5bf);',
        'letter-spacing:0.06em;}',
      '.rc-close{background:none;border:none;color:var(--text-muted-navy,#8fa5bf);',
        'font-size:22px;cursor:pointer;line-height:1;padding:0;transition:color 0.15s;}',
      '.rc-close:hover{color:var(--text-on-navy,#e8edf3);}',

      // Pips
      '.rc-pips{display:flex;align-items:center;justify-content:center;gap:8px;',
        'padding:12px 20px;border-bottom:1px solid var(--border,#d0d7e2);',
        'background:var(--bg-base,#f0f2f5);flex-shrink:0;}',
      '.rc-pip{width:30px;height:30px;border-radius:50%;border:2px solid var(--border,#d0d7e2);',
        'color:var(--text-secondary,#5a6a80);font-family:var(--font-display,sans-serif);',
        'font-weight:700;font-size:12px;display:flex;align-items:center;justify-content:center;}',
      '.rc-pip--on{background:var(--accent,#c9973a);border-color:var(--accent,#c9973a);color:#fff;}',
      '.rc-pip--done{background:var(--bg-navy,#1a2e4a);border-color:var(--bg-navy,#1a2e4a);color:var(--text-on-navy,#e8edf3);}',

      // Body
      '.rc-body{padding:20px;flex:1;min-height:0;overflow-y:auto;}',
      '.rc-body--scroll{overflow-y:auto;}',
      '.rc-body--center{display:flex;flex-direction:column;align-items:center;',
        'justify-content:center;text-align:center;padding:40px 20px;}',

      '.rc-section-lbl{font-family:var(--font-mono,monospace);font-size:10px;',
        'letter-spacing:0.15em;text-transform:uppercase;color:var(--text-secondary,#5a6a80);',
        'margin-bottom:18px;padding-bottom:8px;border-bottom:1px solid var(--border,#d0d7e2);}',

      // Form
      '.rc-field-row{display:flex;align-items:center;gap:12px;margin-bottom:12px;}',
      '.rc-lbl{font-family:var(--font-display,sans-serif);font-size:11px;font-weight:700;',
        'letter-spacing:0.1em;text-transform:uppercase;color:var(--text-secondary,#5a6a80);',
        'white-space:nowrap;}',
      '.rc-input{flex:1;height:36px;padding:0 12px;font-family:var(--font-body,sans-serif);',
        'font-size:13px;border:1.5px solid var(--border,#d0d7e2);background:#fff;',
        'color:var(--text-primary,#1a2e4a);outline:none;transition:border-color 0.15s;}',
      '.rc-input:focus{border-color:var(--accent,#c9973a);}',

      '.rc-preview{font-family:var(--font-body,sans-serif);font-size:12px;',
        'padding:8px 12px;margin-top:4px;}',
      '.rc-preview--ok{background:rgba(42,122,74,0.08);color:var(--color-success,#2a7a4a);}',
      '.rc-preview--warn{background:rgba(192,57,43,0.08);color:var(--color-error,#c0392b);}',

      // Upload
      '.rc-upload-zone{border:2px dashed var(--border,#d0d7e2);padding:40px;',
        'text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px;',
        'transition:border-color 0.15s,background 0.15s;}',
      '.rc-upload-zone--drag{border-color:var(--accent,#c9973a);',
        'background:rgba(201,151,58,0.05);}',
      '.rc-upload-icon{font-size:36px;color:var(--text-secondary,#5a6a80);line-height:1;}',
      '.rc-upload-text{font-family:var(--font-body,sans-serif);font-size:13px;',
        'color:var(--text-secondary,#5a6a80);}',
      '.rc-upload-lbl{cursor:pointer;}',
      '.rc-file-name{font-family:var(--font-mono,monospace);font-size:11px;',
        'color:var(--color-success,#2a7a4a);padding:4px 10px;',
        'background:rgba(42,122,74,0.08);}',

      // Progress bar
      '.rc-parse-area{margin-top:14px;}',
      '.rc-prog-label-row{display:flex;align-items:center;justify-content:space-between;',
        'margin-bottom:5px;}',
      '.rc-prog-label{font-family:var(--font-mono,monospace);font-size:10px;',
        'letter-spacing:0.1em;text-transform:uppercase;color:var(--text-secondary,#5a6a80);}',
      '.rc-prog-pct{font-family:var(--font-mono,monospace);font-size:10px;font-weight:700;',
        'color:var(--accent,#c9973a);}',
      '.rc-prog-track{height:6px;background:var(--border,#d0d7e2);overflow:hidden;}',
      '.rc-prog-bar{height:100%;width:0%;background:var(--accent,#c9973a);',
        'transition:width 0.2s ease,background 0.3s ease;}',

      '.rc-parse-msg{font-family:var(--font-body,sans-serif);font-size:12px;',
        'padding:8px 12px;margin-top:10px;}',
      '.rc-parse-msg--ok{background:rgba(42,122,74,0.08);color:var(--color-success,#2a7a4a);}',
      '.rc-parse-msg--error{background:rgba(192,57,43,0.08);color:var(--color-error,#c0392b);}',
      '.rc-parse-msg--info{background:rgba(201,151,58,0.10);color:var(--accent,#c9973a);}',

      // Chips
      '.rc-chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;}',
      '.rc-chips--center{justify-content:center;margin:16px 0;}',
      '.rc-chip{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;',
        'font-family:var(--font-body,sans-serif);font-size:13px;border:1px solid transparent;}',
      '.chip--ok{background:rgba(42,122,74,0.08);color:var(--color-success,#2a7a4a);',
        'border-color:rgba(42,122,74,0.25);}',
      '.chip--changed{background:rgba(200,128,10,0.10);color:var(--color-conflict,#c8800a);',
        'border-color:rgba(200,128,10,0.30);}',
      '.chip--rej{background:rgba(192,57,43,0.08);color:var(--color-error,#c0392b);',
        'border-color:rgba(192,57,43,0.25);}',
      '.chip--missing{background:rgba(90,106,128,0.08);color:var(--text-secondary,#5a6a80);',
        'border-color:rgba(90,106,128,0.2);}',

      // Notice
      '.rc-notice{font-family:var(--font-body,sans-serif);font-size:13px;',
        'color:var(--text-secondary,#5a6a80);padding:10px 14px;margin-bottom:14px;',
        'background:var(--bg-base,#f0f2f5);border-left:3px solid var(--accent,#c9973a);}',

      // Review table
      '.rc-table{width:100%;border-collapse:collapse;font-family:var(--font-body,sans-serif);',
        'font-size:12px;}',
      '.rc-table th{background:var(--bg-base,#f0f2f5);padding:8px 10px;text-align:left;',
        'font-family:var(--font-display,sans-serif);font-size:10px;letter-spacing:0.1em;',
        'text-transform:uppercase;color:var(--text-secondary,#5a6a80);',
        'border-bottom:1px solid var(--border,#d0d7e2);font-weight:600;}',
      '.rc-table td{padding:7px 10px;border-bottom:1px solid var(--border,#d0d7e2);',
        'vertical-align:middle;}',
      '.rc-td-mono{font-family:var(--font-mono,monospace);font-size:11px;}',
      '.rc-td-desc{max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.rc-td-changes{min-width:180px;}',
      '.rc-change-item{display:block;white-space:nowrap;margin-bottom:2px;}',
      '.rc-change-lbl{font-family:var(--font-display,sans-serif);font-size:9px;',
        'font-weight:700;letter-spacing:0.1em;text-transform:uppercase;',
        'color:var(--text-secondary,#5a6a80);margin-right:3px;}',
      '.rc-th-note{font-family:var(--font-body,sans-serif);font-weight:400;',
        'font-size:9px;text-transform:none;letter-spacing:0;',
        'color:var(--text-secondary,#5a6a80);}',

      // Row states
      '.rc-row--rej td{background:rgba(192,57,43,0.04);}',
      '.rc-row--changed td{background:rgba(200,128,10,0.05);}',
      '.rc-row--missing td{opacity:0.55;}',

      // Value display
      '.rc-old-val{color:var(--text-secondary,#5a6a80);',
        'font-family:var(--font-mono,monospace);font-size:11px;}',
      '.rc-new-val{color:var(--color-conflict,#c8800a);font-weight:700;',
        'font-family:var(--font-mono,monospace);font-size:12px;}',
      '.rc-ok-val{color:var(--text-primary,#1a2e4a);',
        'font-family:var(--font-mono,monospace);font-size:11px;}',
      '.rc-arrow{color:var(--text-secondary,#5a6a80);font-size:11px;margin:0 2px;}',
      '.rc-muted{color:var(--border,#d0d7e2);font-size:11px;font-style:italic;}',

      // Badges
      '.rc-badge{display:inline-block;padding:2px 8px;font-family:var(--font-display,sans-serif);',
        'font-size:10px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;}',
      '.rc-badge--ok{background:rgba(42,122,74,0.10);color:var(--color-success,#2a7a4a);}',
      '.rc-badge--changed{background:rgba(200,128,10,0.12);color:var(--color-conflict,#c8800a);}',
      '.rc-badge--rej{background:rgba(192,57,43,0.10);color:var(--color-error,#c0392b);}',
      '.rc-badge--missing{background:rgba(90,106,128,0.10);color:var(--text-secondary,#5a6a80);}',

      // Buttons
      '.rc-btn{height:34px;padding:0 16px;font-family:var(--font-display,sans-serif);',
        'font-weight:700;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;',
        'cursor:pointer;border:1.5px solid var(--border,#d0d7e2);background:#fff;',
        'color:var(--text-secondary,#5a6a80);display:inline-flex;align-items:center;',
        'gap:6px;transition:all 0.12s;white-space:nowrap;}',
      '.rc-btn:disabled{opacity:0.4;cursor:default;}',
      '.rc-btn--primary{background:var(--accent,#c9973a);border-color:var(--accent,#c9973a);color:#fff;}',
      '.rc-btn--primary:hover:not(:disabled){background:var(--accent-bright,#e8b04a);}',
      '.rc-btn--next{background:var(--bg-navy,#1a2e4a);border-color:var(--bg-navy,#1a2e4a);',
        'color:var(--text-on-navy,#e8edf3);}',
      '.rc-btn--next:hover:not(:disabled){background:var(--bg-navy-deep,#0f1e30);}',
      '.rc-btn--apply{background:var(--color-success,#2a7a4a);',
        'border-color:var(--color-success,#2a7a4a);color:#fff;}',
      '.rc-btn--apply:hover:not(:disabled){background:#236340;}',
      '.rc-btn--ghost{background:transparent;}',
      '.rc-btn--ghost:hover:not(:disabled){background:var(--bg-base,#f0f2f5);',
        'color:var(--text-primary,#1a2e4a);}',

      // Footer
      '.rc-footer{padding:14px 20px;border-top:1px solid var(--border,#d0d7e2);',
        'display:flex;align-items:center;gap:10px;background:var(--bg-base,#f0f2f5);',
        'font-family:var(--font-body,sans-serif);font-size:12px;',
        'color:var(--text-secondary,#5a6a80);flex-shrink:0;}',
      '.rc-footer .rc-btn--next,.rc-footer .rc-btn--apply{margin-left:auto;}',
      '.rc-footer-hint{flex:1;}',

      // Spinner / applying
      '.rc-applying{display:flex;flex-direction:column;align-items:center;',
        'justify-content:center;padding:60px 20px;}',
      '.rc-spinner{width:36px;height:36px;border:3px solid var(--border,#d0d7e2);',
        'border-top-color:var(--accent,#c9973a);border-radius:50%;',
        'animation:rc-spin 0.7s linear infinite;margin-bottom:16px;}',
      '.rc-apply-prog{font-family:var(--font-mono,monospace);font-size:12px;',
        'color:var(--text-secondary,#5a6a80);letter-spacing:0.06em;}',
      '@keyframes rc-spin{to{transform:rotate(360deg);}}',

      // Done screen
      '.rc-done-icon{width:64px;height:64px;border-radius:50%;',
        'background:var(--color-success,#2a7a4a);color:#fff;font-size:30px;',
        'display:flex;align-items:center;justify-content:center;margin-bottom:16px;}',
      '.rc-done-title{font-family:var(--font-display,sans-serif);font-size:18px;',
        'font-weight:700;letter-spacing:0.06em;color:var(--text-primary,#1a2e4a);',
        'margin-bottom:4px;}',
      '.rc-done-meta{font-family:var(--font-mono,monospace);font-size:11px;',
        'color:var(--text-secondary,#5a6a80);margin-top:16px;}',

      // Error
      '.rc-error-full{padding:28px;text-align:center;font-family:var(--font-body,sans-serif);',
        'font-size:13px;color:var(--color-error,#c0392b);}',

    ].join('');
    document.head.appendChild(s);
  }

  // ── Expose ────────────────────────────────────────────────

  return {
    init:              init,
    openPanel:         openPanel,
    wireToolbarButton: wireToolbarButton
  };

}());
