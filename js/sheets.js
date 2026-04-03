// ============================================================
// sheets.js — ALL communication with Apps Script
// Telecom Coordinator Tracking App
// ============================================================
//
// This is the ONLY file that calls Apps Script.
// Every other file that needs data calls a function here.
//
// Public API:
//   Sheets.authenticate(name, code, callback)
//   Sheets.fetchAllRows(callback)
//   Sheets.writeRow(rowData, callback)
//
// Callbacks receive: { success, ...data } or { success:false, error }
//
// Cold start:
//   Apps Script sleeps after ~5 min of inactivity. The first
//   request after sleep takes 5–8 s. We show a subtle
//   "Waking up..." indicator in #cold-start-indicator so the
//   app never appears broken during this window.
//
// localStorage key read here (written by config.js):
//   apps_script_url
//
// ============================================================

var Sheets = (function () {

  // ── Constants ─────────────────────────────────────────────

  // A request is considered a "fresh start" if the app has
  // been idle longer than this threshold. Drives cold-start UI.
  var COLD_START_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

  // Timeout for a single Apps Script request.
  // Cold starts can take 8 s; give generous headroom.
  var REQUEST_TIMEOUT_MS = 45 * 1000; // 45 seconds

  // ── Internal state ────────────────────────────────────────

  var _lastSuccessfulRequestAt = null; // Date | null
  var _coldStartTimerHandle    = null;
  var _coldStartVisible        = false;

  // ── Public: Authenticate ──────────────────────────────────

  /**
   * Verify a name + code pair against Apps Script.
   *
   * callback({ success, name, role, displayName })
   * callback({ success:false, error })
   */
  function authenticate(name, code, callback) {
    _post(
      { action: 'auth', name: name, code: code },
      { isColdStartCandidate: true, label: 'Authenticating' },
      callback
    );
  }

  // ── Public: Fetch all rows ────────────────────────────────

  /**
   * Full data fetch — used on first load only.
   * Stage 3 will replace this with delta sync.
   *
   * callback({ success, rows, columns, timestamp })
   * callback({ success:false, error })
   */
  function fetchAllRows(callback) {
    _post(
      { action: 'getRows' },
      { isColdStartCandidate: true, label: 'Loading data' },
      callback
    );
  }

  // ── Public: Write a single row ────────────────────────────

  /**
   * Create (no _row_index) or update (with _row_index) a row.
   * Auth credentials are re-read from sessionStorage on every
   * call so this always reflects the current session.
   *
   * callback({ success, rowIndex, timestamp })
   * callback({ success:false, error })
   */
  function writeRow(rowData, callback) {
    _post(
      { action: 'writeRow', row: rowData },
      { isColdStartCandidate: false, label: 'Saving' },
      callback
    );
  }

  // ── Internal: POST to Apps Script ────────────────────────

  /**
   * All requests go through here.
   *
   * opts:
   *   isColdStartCandidate {boolean} — show "Waking up..." if idle too long
   *   label                {string}  — loading-status text prefix
   */
  function _post(payload, opts, callback) {
    var url = _getUrl();
    if (!url) {
      callback({ success: false, error: 'No Apps Script URL configured. Please reload and complete setup.' });
      return;
    }

    // Inject auth credentials from sessionStorage into every request
    var name = sessionStorage.getItem('app_name') || '';
    var role = sessionStorage.getItem('app_role') || '';
    if (name && !payload.name) payload.name = name;
    if (role && !payload.role) payload.role = role;

    // Read personal code from sessionStorage (stored by auth.js only
    // during authentication; subsequent calls re-use it from session)
    var code = sessionStorage.getItem('app_code') || '';
    if (code && !payload.code) payload.code = code;

    // Decide whether to show cold-start UI
    var showColdStart = opts.isColdStartCandidate && _isColdStart();
    if (showColdStart) _showColdStart();

    // Show loading status text on the loading screen (if still visible)
    _setLoadingStatus(opts.label + '…');

    // Abort controller for timeout
    var aborted  = false;
    var timerId  = setTimeout(function () {
      aborted = true;
      _hideColdStart();
      callback({
        success: false,
        error:   'The server is taking too long to respond. Please check your connection and try again.'
      });
    }, REQUEST_TIMEOUT_MS);

    fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' },
      // Apps Script requires text/plain to avoid CORS preflight;
      // body is valid JSON the server parses with JSON.parse()
      body: JSON.stringify(payload)
    })
    .then(function (response) {
      if (aborted) return null;
      if (!response.ok) {
        throw new Error('Server returned HTTP ' + response.status);
      }
      return response.json();
    })
    .then(function (data) {
      if (aborted) return;
      clearTimeout(timerId);
      _hideColdStart();
      _lastSuccessfulRequestAt = Date.now();

      if (!data) return; // aborted case

      if (!data.success) {
        callback({ success: false, error: data.error || 'An unexpected error occurred.' });
        return;
      }

      callback(data);
    })
    .catch(function (err) {
      if (aborted) return;
      clearTimeout(timerId);
      _hideColdStart();
      callback({ success: false, error: _friendlyError(err) });
    });
  }

  // ── Cold start ────────────────────────────────────────────

  function _isColdStart() {
    if (!_lastSuccessfulRequestAt) return true; // very first request
    return (Date.now() - _lastSuccessfulRequestAt) > COLD_START_THRESHOLD_MS;
  }

  function _showColdStart() {
    if (_coldStartVisible) return;
    _coldStartVisible = true;

    var el = document.getElementById('cold-start-indicator');
    if (!el) return;

    el.removeAttribute('hidden');
    el.textContent = '';

    // Build: pulsing dot + "Waking up..." text
    var dot  = document.createElement('span');
    dot.className   = 'cold-dot';

    var text = document.createElement('span');
    text.className  = 'cold-text';
    text.textContent = 'Waking up — this may take a few seconds';

    el.appendChild(dot);
    el.appendChild(text);

    // Escalate message after 6 s if still waiting
    _coldStartTimerHandle = setTimeout(function () {
      if (_coldStartVisible && text.parentNode) {
        text.textContent = 'Still connecting — Apps Script is starting up…';
      }
    }, 6000);
  }

  function _hideColdStart() {
    _coldStartVisible = false;
    clearTimeout(_coldStartTimerHandle);
    var el = document.getElementById('cold-start-indicator');
    if (el) el.setAttribute('hidden', '');
  }

  // ── Helpers ───────────────────────────────────────────────

  function _getUrl() {
    return (localStorage.getItem('apps_script_url') || '').trim() || null;
  }

  function _setLoadingStatus(text) {
    var el = document.getElementById('loading-status-text');
    if (!el) return;
    // Preserve the animated ellipsis element if present
    var ellipsis = el.querySelector('.loading-ellipsis');
    el.textContent = text;
    if (ellipsis) el.appendChild(ellipsis);
  }

  function _friendlyError(err) {
    var msg = (err && err.message) ? err.message : String(err);

    // Network failures
    if (/failed to fetch|network/i.test(msg)) {
      return 'Unable to reach the server. Check your internet connection and try again.';
    }
    // CORS issues (Apps Script URL misconfigured)
    if (/cors/i.test(msg)) {
      return 'Connection blocked. Ensure the Apps Script is deployed with "Anyone" access.';
    }
    // JSON parse failures (Apps Script returned an error page)
    if (/json|unexpected token/i.test(msg)) {
      return 'Received an unexpected response from the server. The Apps Script may have an error.';
    }

    return 'Something went wrong: ' + msg;
  }

  // ── Cold-start indicator styles ───────────────────────────
  // Injected once — minimal, complements main.css status bar

  (function _injectStyles() {
    if (document.getElementById('sheets-styles')) return;
    var s = document.createElement('style');
    s.id = 'sheets-styles';
    s.textContent = [

      '#cold-start-indicator {',
        'display: flex;',
        'align-items: center;',
        'gap: 7px;',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'color: var(--text-muted-navy, #8fa5bf);',
      '}',

      '.cold-dot {',
        'width: 6px;',
        'height: 6px;',
        'border-radius: 50%;',
        'background: var(--accent, #c9973a);',
        'animation: cold-pulse 1.2s ease-in-out infinite;',
        'flex-shrink: 0;',
      '}',

      '@keyframes cold-pulse {',
        '0%, 100% { opacity: 1; transform: scale(1); }',
        '50%       { opacity: 0.3; transform: scale(0.55); }',
      '}',

      '.cold-text {',
        'color: var(--text-secondary, #5a6a80);',
        'font-size: 10px;',
      '}',

    ].join('\n');
    document.head.appendChild(s);
  }());

  // ── Expose ────────────────────────────────────────────────

  return {
    authenticate: authenticate,
    fetchAllRows: fetchAllRows,
    writeRow:     writeRow
  };

}());
