// ============================================================
// delete.js — Soft delete workflow and Manager panel
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Show delete confirmation modal (coordinator / manager)
//   - Call Sheets.softDeleteRow → remove from IDB + grid
//   - Manager panel: view Deleted Records, hard-delete, Clear All Data
//   - Wire the #tb-manager toolbar button (manager only)
//
// Role rules:
//   Coordinator — can delete own rows if not locked
//   Invoicing   — cannot delete (blocked server-side and in grid)
//   Manager     — can delete any row, view Deleted tab, Clear All Data
//
// Depends on:
//   Sheets.softDeleteRow / getDeletedRows / hardDeleteRow / restoreRow / clearAllData
//   Offline.removeRow / storeRows
//   Grid.removeRow / applyDelta
// ============================================================

var Delete = (function () {

  // ── State ─────────────────────────────────────────────────

  var _role           = null;
  var _name           = null;
  var _overlayHandler = null;

  // ── Public API ────────────────────────────────────────────

  function init(role, name) {
    _role = role;
    _name = name;

    // Manager panel button
    if (role === 'manager') {
      var btn = document.getElementById('tb-manager');
      if (btn) btn.addEventListener('click', openManagerPanel);
    }
  }

  /**
   * Show the delete confirmation modal.
   * Called by grid.js context menu when the user clicks "Delete row".
   *
   * rowData          — the full row object from _data[]
   * physicalRowIndex — index in grid's _data array
   */
  function confirmDelete(rowData, physicalRowIndex) {
    _renderDeleteModal(rowData, physicalRowIndex);
    _showModal();
  }

  /**
   * Open the Manager panel (Deleted Records + Danger Zone).
   * Called by the #tb-manager toolbar button.
   */
  function openManagerPanel() {
    _renderManagerPanel();
    _showModal();
  }

  // ── Delete confirmation modal ─────────────────────────────

  function _renderDeleteModal(rowData, physRowIdx) {
    var container = document.getElementById('modal-container');
    if (!container) return;

    var rowId = (rowData.id || rowData.job_code || '').trim() || ('Row ' + (physRowIdx + 1));

    container.innerHTML = [
      '<div class="del-modal">',

        '<div class="del-modal-header">',
          '<span class="del-modal-title">Delete Record</span>',
          '<button class="del-modal-close" id="del-close-btn" aria-label="Close">&times;</button>',
        '</div>',

        '<div class="del-modal-body">',
          '<div class="del-warn-icon" aria-hidden="true">&#9888;</div>',
          '<p class="del-warn-heading">Are you sure you want to delete this record?</p>',
          '<p class="del-row-id">' + _esc(rowId) + '</p>',
          '<p class="del-warn-sub">',
            'This record will be moved to the Deleted tab and removed from your view.',
            _role === 'manager'
              ? ' You can permanently delete it from the Manager panel.'
              : ' Contact your manager if you need it restored.',
          '</p>',
        '</div>',

        '<div class="del-modal-footer">',
          '<button class="del-btn-cancel" id="del-cancel-btn">Cancel</button>',
          '<button class="del-btn-danger" id="del-confirm-btn">Delete Record</button>',
        '</div>',

      '</div>',
    ].join('');

    _wireDeleteModalEvents(rowData, physRowIdx);
  }

  function _wireDeleteModalEvents(rowData, physRowIdx) {
    var closeBtn   = document.getElementById('del-close-btn');
    var cancelBtn  = document.getElementById('del-cancel-btn');
    var confirmBtn = document.getElementById('del-confirm-btn');

    if (closeBtn)  closeBtn.addEventListener('click', _hideModal);
    if (cancelBtn) cancelBtn.addEventListener('click', _hideModal);
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function () {
        _performDelete(rowData, physRowIdx);
      });
    }
  }

  function _performDelete(rowData, physRowIdx) {
    var confirmBtn = document.getElementById('del-confirm-btn');
    var cancelBtn  = document.getElementById('del-cancel-btn');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Deleting\u2026'; }
    if (cancelBtn)  { cancelBtn.disabled  = true; }

    var rowIndex = rowData._row_index;

    // ── Unsaved new row (no server index yet) ──────────────
    // Just remove from grid — nothing to delete on the server.
    if (!rowIndex) {
      Grid.removeRow(physRowIdx);
      _hideModal();
      _toast('Row removed.', 'success');
      return;
    }

    // ── Saved row — soft delete via Apps Script ────────────
    Sheets.softDeleteRow(rowIndex, function (result) {
      if (!result.success) {
        _hideModal();
        _toast(result.error || 'Delete failed. Please try again.', 'error');
        return;
      }

      // Remove from grid immediately (visual feedback)
      Grid.removeRow(physRowIdx);

      // Mark as deleted in DuckDB so it doesn't re-appear from cache on next startup
      if (typeof Db !== 'undefined') {
        Db.init().then(function () {
          return Db.query(
            "UPDATE rows SET _is_deleted = true WHERE _row_id = 'row_" + rowIndex + "'"
          );
        }).catch(function () {});
      }

      _hideModal();
      _toast('Record deleted.', 'success');
    });
  }

  // ── Manager panel ─────────────────────────────────────────

  function _renderManagerPanel() {
    var container = document.getElementById('modal-container');
    if (!container) return;

    container.innerHTML = [
      '<div class="mgr-panel">',

        // ── Header ──────────────────────────────────────────
        '<div class="mgr-panel-header">',
          '<span class="mgr-panel-title">&#9881; Manager Panel</span>',
          '<button class="mgr-panel-close" id="mgr-close-btn" aria-label="Close">&times;</button>',
        '</div>',

        '<div class="mgr-panel-body">',

          // ── Conflicts ───────────────────────────────────
          '<div class="mgr-section" id="mgr-conflicts-section">',
            '<div class="mgr-section-heading mgr-conflicts-heading">',
              'Conflicts ',
              '<span class="mgr-conflict-count" id="mgr-conflict-count" hidden></span>',
            '</div>',
            '<div id="mgr-conflicts-content" class="mgr-loading">Loading…</div>',
          '</div>',

          // ── Deleted Records ─────────────────────────────
          '<div class="mgr-section">',
            '<div class="mgr-section-heading">Deleted Records</div>',
            '<div id="mgr-deleted-content" class="mgr-loading">',
              'Loading\u2026',
            '</div>',
          '</div>',

          // ── Import Tracking Data ────────────────────────
          '<div class="mgr-section">',
            '<div class="mgr-section-heading">Import Tracking Data</div>',
            '<div class="mgr-danger-row">',
              '<div class="mgr-danger-info">',
                '<div class="mgr-danger-label">Upload from Excel</div>',
                '<div class="mgr-danger-desc">',
                  'Import rows from the original tracking spreadsheet (.xlsx\u00a0/\u00a0.xlsm). ',
                  'Opens the standalone import tool — you can preview rows before uploading.',
                '</div>',
              '</div>',
              '<a class="mgr-import-btn" id="mgr-import-link" href="tools/restore.html?mode=import" target="_blank" rel="noopener">',
                '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="flex-shrink:0">',
                  '<path d="M7 1v8M3 6l4 4 4-4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>',
                  '<path d="M1 11h12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
                '</svg>',
                'Open Import Tool',
              '</a>',
            '</div>',
          '</div>',

          // ── Danger Zone ──────────────────────────────────
          '<div class="mgr-section mgr-danger">',
            '<div class="mgr-section-heading mgr-danger-heading">',
              '&#9888; Danger Zone',
            '</div>',

            '<div class="mgr-danger-row">',
              '<div class="mgr-danger-info">',
                '<div class="mgr-danger-label">Clear All Data</div>',
                '<div class="mgr-danger-desc">',
                  'Permanently deletes all tracking records from the Data and Deleted tabs ',
                  'and clears the local cache. The Config tab and team settings are preserved. ',
                  'The app reloads fresh after completion.',
                '</div>',
              '</div>',

              // Trigger button (shown first)
              '<button class="mgr-clear-trigger" id="mgr-clear-trigger">',
                'Clear All Data',
              '</button>',
            '</div>',

            // Confirmation section (hidden until trigger clicked)
            '<div class="mgr-clear-confirm" id="mgr-clear-confirm" hidden>',
              '<p class="mgr-clear-prompt">',
                'This cannot be undone. Type <strong>DELETE ALL DATA</strong> below to confirm:',
              '</p>',
              '<input id="mgr-clear-input" class="mgr-clear-input" type="text" ',
                'autocomplete="off" spellcheck="false" placeholder="DELETE ALL DATA">',
              '<div class="mgr-clear-actions">',
                '<button class="del-btn-cancel" id="mgr-clear-cancel">Cancel</button>',
                '<button class="del-btn-danger" id="mgr-clear-go" disabled>',
                  'Clear All Data',
                '</button>',
              '</div>',
            '</div>',

          '</div>', // /.mgr-danger

        '</div>', // /.mgr-panel-body

      '</div>', // /.mgr-panel
    ].join('');

    _wireMgrPanelEvents();
    _loadConflicts();
    _loadDeletedRecords();
  }

  function _wireMgrPanelEvents() {
    var closeBtn = document.getElementById('mgr-close-btn');
    if (closeBtn) closeBtn.addEventListener('click', _hideModal);

    // ── Danger Zone toggle ────────────────────────────────
    var triggerBtn = document.getElementById('mgr-clear-trigger');
    if (triggerBtn) {
      triggerBtn.addEventListener('click', function () {
        triggerBtn.setAttribute('hidden', '');
        document.getElementById('mgr-clear-confirm').removeAttribute('hidden');
        document.getElementById('mgr-clear-input').focus();
      });
    }

    var cancelBtn = document.getElementById('mgr-clear-cancel');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        document.getElementById('mgr-clear-confirm').setAttribute('hidden', '');
        document.getElementById('mgr-clear-trigger').removeAttribute('hidden');
        document.getElementById('mgr-clear-input').value = '';
        document.getElementById('mgr-clear-go').disabled = true;
      });
    }

    // Unlock "Clear All Data" button only when exact phrase is typed
    var clearInput = document.getElementById('mgr-clear-input');
    if (clearInput) {
      clearInput.addEventListener('input', function () {
        var goBtn = document.getElementById('mgr-clear-go');
        if (goBtn) goBtn.disabled = (clearInput.value !== 'DELETE ALL DATA');
      });
    }

    var goBtn = document.getElementById('mgr-clear-go');
    if (goBtn) {
      goBtn.addEventListener('click', _performClearAll);
    }
  }

  // ── Load and render conflicts ─────────────────────────────

  function _loadConflicts() {
    var content = document.getElementById('mgr-conflicts-content');
    if (!content) return;

    if (typeof Db === 'undefined' || !Db.getUnresolvedConflicts) {
      content.innerHTML = '<div class="mgr-empty">Conflict tracking not available.</div>';
      return;
    }

    Db.getUnresolvedConflicts().then(function (conflicts) {
      // Update the count badge in the section heading
      var countEl = document.getElementById('mgr-conflict-count');
      if (countEl) {
        if (conflicts.length > 0) {
          countEl.textContent = String(conflicts.length);
          countEl.removeAttribute('hidden');
        } else {
          countEl.setAttribute('hidden', '');
        }
      }

      if (!conflicts.length) {
        content.innerHTML = '<div class="mgr-empty">No conflicts. All edits synced cleanly.</div>';
        return;
      }

      var html = ['<div class="mgr-conflict-list">'];

      conflicts.forEach(function (conflict) {
        var localRow, serverRow;
        try { localRow  = JSON.parse(conflict.local_payload);  } catch (_) { localRow  = {}; }
        try { serverRow = JSON.parse(conflict.server_payload); } catch (_) { serverRow = {}; }

        var rowLabel = _esc(localRow.id || localRow.job_code || conflict.row_id || 'Unknown');
        var detectedAt = conflict.detected_at
          ? new Date(conflict.detected_at).toLocaleString('en-GB', {
              day:'2-digit', month:'short', year:'numeric',
              hour:'2-digit', minute:'2-digit'
            })
          : '';

        // Find fields that differ (skip system fields and identical values)
        var diffFields = _getDiffFields(localRow, serverRow);

        html.push(
          '<div class="mgr-conflict-card" data-row-id="' + _esc(conflict.row_id) + '"',
            ' data-conflict-sheet-row="' + _esc(String(conflict.conflict_sheet_row || '')) + '"',
            ' data-live-row-index="'     + _esc(String(conflict.live_row_index || ''))     + '">',

          '<div class="mgr-conflict-card-header">',
            '<span class="mgr-conflict-row-id">⚠︎ Row: ' + rowLabel + '</span>',
            '<span class="mgr-conflict-detected">Detected: ' + _esc(detectedAt) + '</span>',
          '</div>',

          '<div class="mgr-conflict-cols">',
            '<div class="mgr-conflict-col mgr-conflict-col--local">',
              '<div class="mgr-conflict-col-header">Your version (offline)</div>',
              _renderConflictFields(diffFields, localRow, 'local'),
            '</div>',
            '<div class="mgr-conflict-col mgr-conflict-col--server">',
              '<div class="mgr-conflict-col-header">Server version (other user)</div>',
              _renderConflictFields(diffFields, serverRow, 'server'),
            '</div>',
          '</div>',

          '<div class="mgr-conflict-actions">',
            '<button class="mgr-keep-local-btn"',
              ' data-row-id="' + _esc(conflict.row_id) + '">',
              'Keep Mine',
            '</button>',
            '<button class="mgr-keep-server-btn"',
              ' data-row-id="' + _esc(conflict.row_id) + '">',
              'Keep Server Version',
            '</button>',
          '</div>',

          '</div>'  // /.mgr-conflict-card
        );
      });

      html.push('</div>');
      content.innerHTML = html.join('');

      // Wire resolution buttons
      content.querySelectorAll('.mgr-keep-local-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var rowId = btn.getAttribute('data-row-id');
          _resolveConflict(rowId, 'local', btn);
        });
      });

      content.querySelectorAll('.mgr-keep-server-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var rowId = btn.getAttribute('data-row-id');
          _resolveConflict(rowId, 'server', btn);
        });
      });

    }).catch(function (e) {
      var content2 = document.getElementById('mgr-conflicts-content');
      if (content2) content2.innerHTML = '<div class="mgr-error">Could not load conflicts: ' + _esc(String(e.message || e)) + '</div>';
    });
  }

  // Return an array of { key, label } for fields that differ between localRow and serverRow.
  // System columns (prefixed _) and unset fields on both sides are excluded.
  var _FIELD_LABELS = {
    id: 'ID #', job_code: 'Job Code', tx_rf: 'TX/RF', vendor: 'Vendor',
    physical_site_id: 'Physical Site ID', logical_site_id: 'Logical Site ID',
    site_option: 'Site Option', facing: 'Facing', region: 'Region',
    sub_region: 'Sub Region', distance: 'Distance',
    absolute_quantity: 'Abs Qty', actual_quantity: 'Actual Qty',
    general_stream: 'General Stream', task_name: 'Task Name',
    contractor: 'Contractor', engineer_name: 'Engineer',
    line_item: 'Line Item', new_price: 'New Price',
    new_total_price: 'New Total Price', comments: 'Comments',
    status: 'Status', task_date: 'Task Date',
    vf_task_owner: 'VF Task Owner', prq: 'PRQ',
    coordinator_name: 'Coordinator',
    acceptance_status: 'Acceptance Status', fac_date: 'FAC Date',
    certificate_num: 'Certificate #', acceptance_week: 'Acceptance Week',
    tsr_sub: 'TSR Sub', po_status: 'PO Status', po_number: 'PO Number',
    vf_invoice_num: 'VF Invoice #', first_receiving_date: 'First Receiving Date',
    lmp_portion: 'LMP Portion', contractor_portion: 'Contractor Portion',
    sent_to_cost_control: 'Sent to CC', received_from_cc: 'Received from CC',
    contractor_invoice_num: 'Contractor Invoice #',
    vf_invoice_submission_date: 'VF Invoice Sub Date',
    cash_received_date: 'Cash Received Date'
  };

  function _getDiffFields(local, server) {
    var seen = {};
    var diffs = [];
    var keys = Object.keys(_FIELD_LABELS);
    keys.forEach(function (key) {
      var lv = String(local[key]  == null ? '' : local[key]);
      var sv = String(server[key] == null ? '' : server[key]);
      if (lv === sv) return;          // identical — no diff
      if (!lv && !sv) return;         // both empty — skip
      diffs.push({ key: key, label: _FIELD_LABELS[key] || key });
    });
    return diffs;
  }

  function _renderConflictFields(diffFields, rowData, side) {
    if (!diffFields.length) {
      return '<div class="mgr-conflict-nodiff">No field differences found.</div>';
    }
    var rows = diffFields.map(function (f) {
      var val = rowData[f.key];
      var display = (val == null || val === '') ? '—' : String(val);
      return '<div class="mgr-conflict-field">' +
        '<span class="mgr-conflict-field-label">' + _esc(f.label) + '</span>' +
        '<span class="mgr-conflict-field-value">' + _esc(display) + '</span>' +
        '</div>';
    });
    return rows.join('');
  }

  // Resolve a conflict — called by Keep Mine / Keep Server buttons.
  function _resolveConflict(rowId, keepVersion, clickedBtn) {
    var card = clickedBtn.closest('.mgr-conflict-card');
    if (!card) return;

    // Disable both buttons in this card
    card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    clickedBtn.textContent = 'Resolving…';

    Db.getUnresolvedConflicts().then(function (conflicts) {
      var conflict = null;
      for (var i = 0; i < conflicts.length; i++) {
        if (conflicts[i].row_id === rowId) { conflict = conflicts[i]; break; }
      }
      if (!conflict) {
        _toast('Conflict not found — may have been resolved already.', 'error');
        _loadConflicts();
        return;
      }

      var localRow, serverRow;
      try { localRow  = JSON.parse(conflict.local_payload);  } catch (_) { localRow  = {}; }
      try { serverRow = JSON.parse(conflict.server_payload); } catch (_) { serverRow = {}; }

      var conflictSheetRow = conflict.conflict_sheet_row;
      var liveRowIndex     = conflict.live_row_index;

      if (keepVersion === 'local') {
        // Write our local version to Apps Script, then resolve locally.
        // Pass conflictSheetRow so the server knows to delete the conflict copy.
        Sheets.resolveConflict(
          conflictSheetRow, liveRowIndex, 'offline', localRow,
          function (result) {
            if (!result.success) {
              card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
              clickedBtn.textContent = 'Keep Mine';
              _toast(result.error || 'Could not resolve. Try again.', 'error');
              return;
            }
            // Local DuckDB already has our version — just clear pending_sync flag
            var updated = Object.assign({}, localRow, { _pending_sync: false });
            Db.upsertRow(updated).catch(function () {});
            Db.markConflictResolved(rowId).then(function () {
              _afterResolve(card, rowId, 'Your version saved.');
            });
          }
        );
      } else {
        // Keep the server's version — update local DuckDB and the grid.
        // No need to write to Apps Script; server already has this version.
        Sheets.resolveConflict(
          conflictSheetRow, liveRowIndex, 'online', null,
          function (result) {
            if (!result.success) {
              card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
              clickedBtn.textContent = 'Keep Server Version';
              _toast(result.error || 'Could not resolve. Try again.', 'error');
              return;
            }
            // Overwrite local row with server data
            var serverUpdated = Object.assign({}, serverRow, { _pending_sync: false, _conflict: false });
            Db.upsertRow(serverUpdated).catch(function () {});
            if (typeof Grid !== 'undefined' && Grid.applyDelta) {
              Grid.applyDelta([serverUpdated]);
            }
            Db.markConflictResolved(rowId).then(function () {
              _afterResolve(card, rowId, 'Server version kept.');
            });
          }
        );
      }
    }).catch(function (e) {
      card.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      clickedBtn.textContent = keepVersion === 'local' ? 'Keep Mine' : 'Keep Server Version';
      _toast('Error: ' + (e.message || e), 'error');
    });
  }

  function _afterResolve(card, rowId, toastMsg) {
    // Update the section badge count
    Db.countUnresolvedConflicts().then(function (n) {
      if (typeof Sync !== 'undefined' && Sync.setServerConflictCount) {
        Sync.setServerConflictCount(n);
      }
      var countEl = document.getElementById('mgr-conflict-count');
      if (countEl) {
        if (n > 0) { countEl.textContent = String(n); }
        else { countEl.setAttribute('hidden', ''); }
      }
    }).catch(function () {});

    // Fade out the resolved card
    card.style.transition = 'opacity 0.2s';
    card.style.opacity = '0';
    setTimeout(function () {
      card.remove();
      var list = document.querySelector('#mgr-conflicts-content .mgr-conflict-list');
      if (list && !list.querySelector('.mgr-conflict-card')) {
        var content = document.getElementById('mgr-conflicts-content');
        if (content) content.innerHTML = '<div class="mgr-empty">No conflicts. All edits synced cleanly.</div>';
      }
    }, 200);

    _toast(toastMsg, 'success');
  }

  // ── Load deleted records ──────────────────────────────────

  function _loadDeletedRecords() {
    Sheets.getDeletedRows(function (result) {
      var content = document.getElementById('mgr-deleted-content');
      if (!content) return;

      if (!result.success) {
        content.innerHTML = '<div class="mgr-error">Could not load deleted records: ' +
          _esc(result.error || 'Unknown error') + '</div>';
        return;
      }

      var rows = result.rows || [];
      if (!rows.length) {
        content.innerHTML = '<div class="mgr-empty">No deleted records.</div>';
        return;
      }

      var html = [
        '<div class="mgr-table-wrap">',
          '<table class="mgr-table">',
            '<thead><tr>',
              '<th>ID #</th>',
              '<th>Job Code</th>',
              '<th>Task Name</th>',
              '<th>Coordinator</th>',
              '<th>Deleted By</th>',
              '<th>Deleted At</th>',
              '<th></th>',
            '</tr></thead>',
            '<tbody>',
      ];

      rows.forEach(function (row) {
        var deletedAt = row.deleted_at ? new Date(Number(row.deleted_at)) : null;
        var dateStr   = deletedAt
          ? deletedAt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
          : '\u2014';

        html.push(
          '<tr>',
            '<td class="mgr-mono">' + _esc(row.id      || '\u2014') + '</td>',
            '<td>' + _esc(row.job_code  || '\u2014') + '</td>',
            '<td>' + _esc(row.task_name || '\u2014') + '</td>',
            '<td>' + _esc(row.coordinator_name || '\u2014') + '</td>',
            '<td>' + _esc(row.deleted_by || '\u2014') + '</td>',
            '<td>' + _esc(dateStr) + '</td>',
            '<td class="mgr-row-actions">',
              '<button class="mgr-restore-btn"',
                ' data-idx="' + _esc(String(row._deleted_row_index)) + '"',
                ' data-id="'  + _esc(row.id || '') + '">',
                'Restore',
              '</button>',
              '<button class="mgr-hard-del-btn"',
                ' data-idx="' + _esc(String(row._deleted_row_index)) + '"',
                ' data-id="'  + _esc(row.id || '') + '">',
                'Delete Permanently',
              '</button>',
            '</td>',
          '</tr>'
        );
      });

      html.push('</tbody></table></div>');
      content.innerHTML = html.join('');

      // Wire restore buttons
      content.querySelectorAll('.mgr-restore-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var idx   = Number(btn.getAttribute('data-idx'));
          var rowId = btn.getAttribute('data-id');
          _performRestore(idx, rowId, btn);
        });
      });

      // Wire hard-delete buttons
      content.querySelectorAll('.mgr-hard-del-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var idx   = Number(btn.getAttribute('data-idx'));
          var rowId = btn.getAttribute('data-id');
          _performHardDelete(idx, rowId, btn);
        });
      });
    });
  }

  function _performRestore(deletedRowIndex, rowId, btn) {
    var tr = btn.closest('tr');

    // Disable both action buttons in this row while restoring
    if (tr) {
      tr.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    }
    btn.textContent = 'Restoring\u2026';

    Sheets.restoreRow(deletedRowIndex, function (result) {
      if (!result.success) {
        // Re-enable buttons on failure
        if (tr) {
          tr.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
        }
        btn.textContent = 'Restore';
        _toast(result.error || 'Could not restore. Try again.', 'error');
        return;
      }

      // Add the restored row to DuckDB + grid
      if (result.row) {
        if (typeof Db !== 'undefined') {
          Db.init().then(function () { return Db.upsertRow(result.row); }).catch(function () {});
        }
        Grid.applyDelta([result.row]);
      }

      // Fade + remove the table row
      if (tr) {
        tr.style.transition = 'opacity 0.2s';
        tr.style.opacity    = '0';
        setTimeout(function () {
          tr.remove();
          var tbody = document.querySelector('#mgr-deleted-content tbody');
          if (tbody && !tbody.querySelector('tr')) {
            var content = document.getElementById('mgr-deleted-content');
            if (content) content.innerHTML = '<div class="mgr-empty">No deleted records.</div>';
          }
        }, 200);
      }

      _toast('Record restored and added back to the grid.', 'success');
    });
  }

  function _performHardDelete(deletedRowIndex, rowId, btn) {
    if (!confirm(
      'Permanently delete "' + (rowId || 'this record') + '"?\n\n' +
      'This cannot be undone.'
    )) return;

    btn.disabled    = true;
    btn.textContent = 'Deleting\u2026';

    Sheets.hardDeleteRow(deletedRowIndex, function (result) {
      if (!result.success) {
        btn.disabled    = false;
        btn.textContent = 'Delete Permanently';
        _toast(result.error || 'Could not permanently delete. Try again.', 'error');
        return;
      }

      // Remove the row from the table without reloading the whole list
      var tr = btn.closest('tr');
      if (tr) {
        tr.style.transition = 'opacity 0.2s';
        tr.style.opacity    = '0';
        setTimeout(function () {
          tr.remove();
          // If table is now empty, show the empty state
          var tbody = document.querySelector('#mgr-deleted-content tbody');
          if (tbody && !tbody.querySelector('tr')) {
            var content = document.getElementById('mgr-deleted-content');
            if (content) content.innerHTML = '<div class="mgr-empty">No deleted records.</div>';
          }
        }, 200);
      }
      _toast('Record permanently deleted.', 'success');
    });
  }

  // ── Clear All Data ────────────────────────────────────────

  function _performClearAll() {
    var goBtn     = document.getElementById('mgr-clear-go');
    var cancelBtn = document.getElementById('mgr-clear-cancel');
    if (goBtn)     { goBtn.disabled     = true; goBtn.textContent = 'Clearing\u2026'; }
    if (cancelBtn) { cancelBtn.disabled = true; }

    Sheets.clearAllData(function (result) {
      if (!result.success) {
        if (goBtn) { goBtn.disabled = false; goBtn.textContent = 'Clear All Data'; }
        if (cancelBtn) { cancelBtn.disabled = false; }
        _toast(result.error || 'Clear failed. Please try again.', 'error');
        return;
      }

      // Wipe DuckDB — clearRows() removes all tracking data, preserving schema
      if (typeof Db !== 'undefined') {
        Db.init().then(function () {
          return Db.clearRows();
        }).then(function () {
          setTimeout(function () { window.location.reload(); }, 300);
        }).catch(function () {
          setTimeout(function () { window.location.reload(); }, 300);
        });
      } else {
        setTimeout(function () { window.location.reload(); }, 300);
      }
    });
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

  // ── Helpers ───────────────────────────────────────────────

  function _esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _toast(msg, type) {
    var bg = (type === 'error') ? '#c0392b' : '#2a7a4a';
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
    setTimeout(function () { el.remove(); }, 4000);
  }

  // ── Injected styles ───────────────────────────────────────

  (function _injectStyles() {
    if (document.getElementById('delete-styles')) return;
    var s = document.createElement('style');
    s.id = 'delete-styles';
    s.textContent = [

      // ── Shared: modal overlay positioning ────────────────
      // (May also be set by export.js — idempotent if both load)
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

      // ── Delete confirmation modal ─────────────────────────
      '.del-modal {',
        'width: 420px;',
        'max-width: 96vw;',
        'background: var(--bg-surface);',
        'border: 1px solid var(--border);',
        'box-shadow: 0 12px 48px rgba(10,20,35,0.22);',
        'display: flex;',
        'flex-direction: column;',
      '}',

      '.del-modal::before, .del-modal::after {',
        'content: "";',
        'position: absolute;',
        'width: 10px;',
        'height: 10px;',
        'border-color: var(--color-error);',
        'border-style: solid;',
      '}',
      '.del-modal::before { top:-1px; left:-1px; border-width: 2px 0 0 2px; }',
      '.del-modal::after  { bottom:-1px; right:-1px; border-width: 0 2px 2px 0; }',

      '.del-modal-header {',
        'display: flex;',
        'align-items: center;',
        'justify-content: space-between;',
        'padding: 14px 20px 12px;',
        'background: var(--bg-navy);',
        'border-bottom: 2px solid var(--color-error);',
      '}',

      '.del-modal-title {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 13px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'color: var(--text-on-navy);',
      '}',

      '.del-modal-close {',
        'background: transparent;',
        'border: none;',
        'color: var(--text-muted-navy);',
        'font-size: 20px;',
        'line-height: 1;',
        'cursor: pointer;',
        'padding: 0 2px;',
        'transition: color 0.15s;',
      '}',
      '.del-modal-close:hover { color: var(--text-on-navy); }',

      '.del-modal-body {',
        'padding: 28px 24px 20px;',
        'display: flex;',
        'flex-direction: column;',
        'align-items: center;',
        'text-align: center;',
        'gap: 10px;',
      '}',

      '.del-warn-icon {',
        'font-size: 36px;',
        'color: var(--color-error);',
        'line-height: 1;',
        'margin-bottom: 4px;',
      '}',

      '.del-warn-heading {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 17px;',
        'letter-spacing: 0.03em;',
        'color: var(--text-primary);',
        'margin: 0;',
      '}',

      '.del-row-id {',
        'font-family: var(--font-mono);',
        'font-size: 12px;',
        'color: var(--accent);',
        'background: var(--bg-base);',
        'padding: 4px 12px;',
        'border: 1px solid var(--border);',
        'margin: 0;',
      '}',

      '.del-warn-sub {',
        'font-family: var(--font-body);',
        'font-size: 13px;',
        'color: var(--text-secondary);',
        'line-height: 1.5;',
        'margin: 0;',
        'max-width: 320px;',
      '}',

      '.del-modal-footer {',
        'display: flex;',
        'justify-content: flex-end;',
        'gap: 10px;',
        'padding: 14px 20px;',
        'border-top: 1px solid var(--border);',
        'background: var(--bg-base);',
      '}',

      // Shared button styles (used in both delete modal and manager panel)
      '.del-btn-cancel {',
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
        'transition: background 0.15s;',
      '}',
      '.del-btn-cancel:hover:not(:disabled) { background: var(--bg-surface); }',
      '.del-btn-cancel:disabled { opacity: 0.5; cursor: not-allowed; }',

      '.del-btn-danger {',
        'height: 34px;',
        'padding: 0 18px;',
        'background: var(--color-error);',
        'border: none;',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 10px;',
        'letter-spacing: 0.16em;',
        'text-transform: uppercase;',
        'color: #fff;',
        'cursor: pointer;',
        'transition: opacity 0.15s;',
      '}',
      '.del-btn-danger:hover:not(:disabled) { opacity: 0.88; }',
      '.del-btn-danger:disabled { opacity: 0.5; cursor: not-allowed; }',

      // ── Manager panel ─────────────────────────────────────
      '.mgr-panel {',
        'width: min(900px, 96vw);',
        'max-height: 88vh;',
        'background: var(--bg-surface);',
        'border: 1px solid var(--border);',
        'box-shadow: 0 12px 48px rgba(10,20,35,0.22);',
        'display: flex;',
        'flex-direction: column;',
        'overflow: hidden;',
      '}',

      '.mgr-panel-header {',
        'display: flex;',
        'align-items: center;',
        'justify-content: space-between;',
        'padding: 16px 24px 14px;',
        'background: var(--bg-navy);',
        'border-bottom: 2px solid var(--accent);',
        'flex-shrink: 0;',
      '}',

      '.mgr-panel-title {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 14px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'color: var(--text-on-navy);',
      '}',

      '.mgr-panel-close {',
        'background: transparent;',
        'border: none;',
        'color: var(--text-muted-navy);',
        'font-size: 22px;',
        'line-height: 1;',
        'cursor: pointer;',
        'padding: 0 2px;',
        'transition: color 0.15s;',
      '}',
      '.mgr-panel-close:hover { color: var(--text-on-navy); }',

      '.mgr-panel-body {',
        'overflow-y: auto;',
        'flex: 1;',
      '}',

      '.mgr-section {',
        'padding: 24px;',
        'border-bottom: 1px solid var(--border);',
      '}',

      '.mgr-section-heading {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 11px;',
        'letter-spacing: 0.18em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
        'margin-bottom: 16px;',
      '}',

      // ── Deleted records table ─────────────────────────────
      '.mgr-loading {',
        'font-family: var(--font-mono);',
        'font-size: 11px;',
        'color: var(--text-secondary);',
        'letter-spacing: 0.1em;',
        'text-transform: uppercase;',
      '}',

      '.mgr-empty {',
        'font-family: var(--font-body);',
        'font-size: 13px;',
        'color: var(--text-secondary);',
        'font-style: italic;',
      '}',

      '.mgr-error {',
        'font-family: var(--font-body);',
        'font-size: 13px;',
        'color: var(--color-error);',
      '}',

      '.mgr-table-wrap {',
        'overflow-x: auto;',
        'border: 1px solid var(--border);',
      '}',

      '.mgr-table {',
        'width: 100%;',
        'border-collapse: collapse;',
        'font-family: var(--font-body);',
        'font-size: 12px;',
      '}',

      '.mgr-table th {',
        'background: var(--bg-navy);',
        'color: var(--text-on-navy);',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 9px;',
        'letter-spacing: 0.14em;',
        'text-transform: uppercase;',
        'padding: 8px 12px;',
        'text-align: left;',
        'white-space: nowrap;',
        'border-right: 1px solid var(--border-navy);',
      '}',
      '.mgr-table th:last-child { border-right: none; }',

      '.mgr-table td {',
        'padding: 8px 12px;',
        'border-bottom: 1px solid var(--border);',
        'color: var(--text-primary);',
        'white-space: nowrap;',
      '}',

      '.mgr-table tr:last-child td { border-bottom: none; }',
      '.mgr-table tr:nth-child(even) td { background: var(--bg-base); }',

      '.mgr-mono {',
        'font-family: var(--font-mono);',
        'font-size: 11px;',
        'color: var(--text-secondary);',
      '}',

      '.mgr-row-actions {',
        'display: flex;',
        'gap: 6px;',
        'align-items: center;',
      '}',

      '.mgr-restore-btn {',
        'height: 26px;',
        'padding: 0 10px;',
        'background: transparent;',
        'border: 1px solid rgba(46, 160, 100, 0.45);',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 9px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'color: #2ea064;',
        'cursor: pointer;',
        'transition: background 0.15s;',
        'white-space: nowrap;',
      '}',
      '.mgr-restore-btn:hover:not(:disabled) {',
        'background: rgba(46,160,100,0.08);',
      '}',
      '.mgr-restore-btn:disabled { opacity: 0.4; cursor: not-allowed; }',

      '.mgr-hard-del-btn {',
        'height: 26px;',
        'padding: 0 10px;',
        'background: transparent;',
        'border: 1px solid rgba(192, 57, 43, 0.4);',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 9px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'color: var(--color-error);',
        'cursor: pointer;',
        'transition: background 0.15s;',
        'white-space: nowrap;',
      '}',
      '.mgr-hard-del-btn:hover:not(:disabled) {',
        'background: rgba(192,57,43,0.08);',
      '}',
      '.mgr-hard-del-btn:disabled { opacity: 0.4; cursor: not-allowed; }',

      // ── Danger Zone ───────────────────────────────────────
      '.mgr-danger {',
        'background: rgba(192, 57, 43, 0.03);',
        'border-top: 1px solid rgba(192, 57, 43, 0.15);',
        'border-bottom: none;',
      '}',

      '.mgr-danger-heading {',
        'color: var(--color-error);',
        'border-bottom: 1px solid rgba(192, 57, 43, 0.15);',
        'padding-bottom: 12px;',
        'margin-bottom: 16px;',
      '}',

      '.mgr-danger-row {',
        'display: flex;',
        'align-items: flex-start;',
        'gap: 24px;',
        'justify-content: space-between;',
      '}',

      '.mgr-danger-info { flex: 1; }',

      '.mgr-danger-label {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 13px;',
        'letter-spacing: 0.06em;',
        'color: var(--text-primary);',
        'margin-bottom: 6px;',
      '}',

      '.mgr-danger-desc {',
        'font-family: var(--font-body);',
        'font-size: 12px;',
        'color: var(--text-secondary);',
        'line-height: 1.55;',
        'max-width: 520px;',
      '}',

      '.mgr-import-btn {',
        'display: inline-flex;',
        'align-items: center;',
        'gap: 7px;',
        'height: 34px;',
        'padding: 0 16px;',
        'background: transparent;',
        'border: 1px solid var(--border);',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 10px;',
        'letter-spacing: 0.14em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
        'text-decoration: none;',
        'cursor: pointer;',
        'flex-shrink: 0;',
        'align-self: center;',
        'transition: border-color 0.15s, color 0.15s, background 0.15s;',
      '}',
      '.mgr-import-btn:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-dim); }',

      '.mgr-clear-trigger {',
        'height: 34px;',
        'padding: 0 18px;',
        'background: transparent;',
        'border: 1px solid rgba(192,57,43,0.5);',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 10px;',
        'letter-spacing: 0.14em;',
        'text-transform: uppercase;',
        'color: var(--color-error);',
        'cursor: pointer;',
        'flex-shrink: 0;',
        'transition: background 0.15s;',
        'align-self: center;',
      '}',
      '.mgr-clear-trigger:hover { background: rgba(192,57,43,0.06); }',

      '.mgr-clear-confirm {',
        'margin-top: 20px;',
        'padding: 16px;',
        'background: rgba(192,57,43,0.05);',
        'border: 1px solid rgba(192,57,43,0.2);',
      '}',

      '.mgr-clear-prompt {',
        'font-family: var(--font-body);',
        'font-size: 13px;',
        'color: var(--text-primary);',
        'margin: 0 0 10px;',
        'line-height: 1.4;',
      '}',

      '.mgr-clear-input {',
        'width: 100%;',
        'height: 36px;',
        'padding: 0 10px;',
        'font-family: var(--font-mono);',
        'font-size: 13px;',
        'color: var(--text-primary);',
        'background: var(--bg-surface);',
        'border: 1px solid var(--border);',
        'outline: none;',
        'margin-bottom: 12px;',
        'box-sizing: border-box;',
        'transition: border-color 0.15s;',
      '}',
      '.mgr-clear-input:focus { border-color: var(--color-error); }',

      '.mgr-clear-actions {',
        'display: flex;',
        'justify-content: flex-end;',
        'gap: 10px;',
      '}',

      // ── Conflict section ──────────────────────────────────
      '.mgr-conflicts-heading {',
        'display: flex;',
        'align-items: center;',
        'gap: 8px;',
      '}',

      '.mgr-conflict-count {',
        'display: inline-flex;',
        'align-items: center;',
        'justify-content: center;',
        'min-width: 18px;',
        'height: 18px;',
        'padding: 0 5px;',
        'background: var(--color-conflict, #c8800a);',
        'color: #fff;',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'font-weight: 500;',
        'letter-spacing: 0;',
        'border-radius: 2px;',
      '}',

      '.mgr-conflict-list {',
        'display: flex;',
        'flex-direction: column;',
        'gap: 12px;',
      '}',

      '.mgr-conflict-card {',
        'border: 1px solid rgba(200,128,10,0.35);',
        'background: rgba(200,128,10,0.04);',
      '}',

      '.mgr-conflict-card-header {',
        'display: flex;',
        'justify-content: space-between;',
        'align-items: center;',
        'padding: 8px 12px;',
        'background: rgba(200,128,10,0.08);',
        'border-bottom: 1px solid rgba(200,128,10,0.2);',
        'gap: 16px;',
      '}',

      '.mgr-conflict-row-id {',
        'font-family: var(--font-mono);',
        'font-size: 11px;',
        'color: var(--color-conflict, #c8800a);',
        'font-weight: 500;',
        'white-space: nowrap;',
      '}',

      '.mgr-conflict-detected {',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'color: var(--text-secondary);',
        'letter-spacing: 0.06em;',
        'white-space: nowrap;',
      '}',

      '.mgr-conflict-cols {',
        'display: grid;',
        'grid-template-columns: 1fr 1fr;',
        'border-bottom: 1px solid rgba(200,128,10,0.15);',
      '}',

      '.mgr-conflict-col {',
        'padding: 12px;',
      '}',

      '.mgr-conflict-col + .mgr-conflict-col {',
        'border-left: 1px solid rgba(200,128,10,0.2);',
      '}',

      '.mgr-conflict-col-header {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 9px;',
        'letter-spacing: 0.16em;',
        'text-transform: uppercase;',
        'margin-bottom: 8px;',
      '}',

      '.mgr-conflict-col--local .mgr-conflict-col-header { color: var(--accent); }',
      '.mgr-conflict-col--server .mgr-conflict-col-header { color: var(--text-secondary); }',

      '.mgr-conflict-field {',
        'display: flex;',
        'justify-content: space-between;',
        'align-items: baseline;',
        'gap: 12px;',
        'padding: 3px 0;',
        'border-bottom: 1px solid var(--border);',
        'font-size: 12px;',
      '}',
      '.mgr-conflict-field:last-child { border-bottom: none; }',

      '.mgr-conflict-field-label {',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 10px;',
        'letter-spacing: 0.06em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
        'white-space: nowrap;',
        'flex-shrink: 0;',
      '}',

      '.mgr-conflict-field-value {',
        'font-family: var(--font-mono);',
        'font-size: 11px;',
        'color: var(--text-primary);',
        'text-align: right;',
        'word-break: break-word;',
      '}',

      '.mgr-conflict-nodiff {',
        'font-family: var(--font-body);',
        'font-size: 12px;',
        'color: var(--text-secondary);',
        'font-style: italic;',
      '}',

      '.mgr-conflict-actions {',
        'display: flex;',
        'justify-content: flex-end;',
        'align-items: center;',
        'gap: 10px;',
        'padding: 10px 12px;',
      '}',

      '.mgr-keep-local-btn {',
        'height: 30px;',
        'padding: 0 14px;',
        'background: var(--accent);',
        'border: none;',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 9px;',
        'letter-spacing: 0.14em;',
        'text-transform: uppercase;',
        'color: #fff;',
        'cursor: pointer;',
        'transition: opacity 0.15s;',
      '}',
      '.mgr-keep-local-btn:hover:not(:disabled) { opacity: 0.88; }',
      '.mgr-keep-local-btn:disabled { opacity: 0.45; cursor: not-allowed; }',

      '.mgr-keep-server-btn {',
        'height: 30px;',
        'padding: 0 14px;',
        'background: transparent;',
        'border: 1px solid var(--border);',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 9px;',
        'letter-spacing: 0.14em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
        'cursor: pointer;',
        'transition: background 0.15s;',
      '}',
      '.mgr-keep-server-btn:hover:not(:disabled) { background: var(--bg-base); }',
      '.mgr-keep-server-btn:disabled { opacity: 0.45; cursor: not-allowed; }',

    ].join('\n');
    document.head.appendChild(s);
  }());

  // ── Expose ────────────────────────────────────────────────

  return {
    init:             init,
    confirmDelete:    confirmDelete,
    openManagerPanel: openManagerPanel,
  };

}());
