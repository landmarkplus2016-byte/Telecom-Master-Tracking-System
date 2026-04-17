// ============================================================
// auth.js — Login screen and role detection
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Render the login screen into #screen-login
//   - Populate the name dropdown from Apps Script (team member list)
//   - Validate personal code via Sheets.authenticate()
//   - On success: write role + name to sessionStorage, fire callback
//   - On failure: show inline error, clear code field
//   - Redirect to config.js setup screen if no Apps Script URL exists
//
// sessionStorage keys written here:
//   app_name   — display name returned by Apps Script
//   app_role   — lowercase role: coordinator | invoicing | manager
//
// Does NOT read from sessionStorage — that is app.js's job on
// subsequent page loads.
// ============================================================

var Auth = (function () {

  // ── Internal state ────────────────────────────────────────

  var _onLoginSuccess = null;  // callback set by app.js: function(name, role)
  var _teamNames      = [];    // populated from Apps Script auth response

  // ── Public API ────────────────────────────────────────────

  function init(onSuccess) {
    console.log('[auth.js] init() called');

    try {
      _onLoginSuccess = onSuccess;

      // Always hide the loading screen before showing any auth screen
      _hide('screen-loading');
      console.log('[auth.js] loading screen hidden');

      // If no Apps Script URL is stored, hand off to Config setup screen
      if (!_hasAppScriptUrl()) {
        console.log('[auth.js] No Apps Script URL found — showing setup screen');
        try {
          Config.showSetup(function () {
            console.log('[auth.js] Setup complete — showing login screen');
            try {
              _renderLogin();
              _show('screen-login');
            } catch (e) {
              console.error('[auth.js] Error rendering login after setup:', e);
            }
          });
        } catch (e) {
          console.error('[auth.js] Error calling Config.showSetup():', e);
        }
        return;
      }

      console.log('[auth.js] Apps Script URL found — rendering login screen');
      try {
        _renderLogin();
        _show('screen-login');
        console.log('[auth.js] Login screen shown');
      } catch (e) {
        console.error('[auth.js] Error rendering login screen:', e);
      }

    } catch (e) {
      console.error('[auth.js] Unexpected error in init():', e);
    }
  }

  // Called by app.js to pre-populate names once sheets.js
  // has fetched the team list (optional — dropdown shows a
  // spinner placeholder until names arrive)
  function setTeamNames(names) {
    _teamNames = names || [];
    // Names are no longer used to populate a dropdown — kept for
    // future server-side validation reference only.
  }

  // ── Render ────────────────────────────────────────────────

  function _renderLogin() {
    console.log('[auth.js] _renderLogin() called');
    var container = document.getElementById('screen-login');
    if (!container) {
      console.error('[auth.js] #screen-login element not found in DOM');
      return;
    }

    container.innerHTML = [
      '<div class="login-bg">',

        // Left panel — branding strip
        '<div class="login-brand">',
          '<div class="login-brand-inner">',
            '<img src="LMP%20Big%20Logo.png" alt="LMP Logo" class="login-brand-logo">',
            '<div class="login-brand-eyebrow">Telecom Department</div>',
            '<div class="login-brand-title">Tracking<br>System</div>',
            '<div class="login-brand-rule"></div>',
            '<div class="login-brand-sub">Coordinator Workspace</div>',
          '</div>',
        '</div>',

        // Right panel — login form
        '<div class="login-panel">',
          '<div class="login-card">',

            // Corner brackets (CSS handles the other two)
            '<div class="login-card-inner">',

              '<p class="login-card-eyebrow">Sign in to continue</p>',
              '<h2 class="login-card-heading">Welcome back</h2>',

              '<form id="login-form" autocomplete="off" novalidate>',

                // Name text input
                '<div class="login-field">',
                  '<label class="login-label" for="login-name-select">Your Name</label>',
                  '<input',
                    ' id="login-name-select"',
                    ' class="login-input"',
                    ' type="text"',
                    ' placeholder="Enter your full name"',
                    ' autocomplete="off"',
                    ' spellcheck="false"',
                    ' required',
                  '>',
                '</div>',

                // Access code
                '<div class="login-field">',
                  '<label class="login-label" for="login-code-input">Access Code</label>',
                  '<input',
                    ' id="login-code-input"',
                    ' class="login-input"',
                    ' type="password"',
                    ' placeholder="Enter your personal code"',
                    ' autocomplete="off"',
                    ' required',
                  '>',
                '</div>',

                // Error message
                '<div id="login-error" class="login-error" hidden></div>',

                // Submit
                '<button id="login-submit" class="login-btn" type="submit">',
                  '<span id="login-btn-text">Sign In</span>',
                  '<span id="login-btn-spinner" class="login-spinner" hidden></span>',
                '</button>',

              '</form>',

            '</div>',
          '</div>',

          // Footer note
          '<p class="login-footer-note">',
            'Access codes are managed by your team administrator.',
          '</p>',
        '</div>',

      '</div>'
    ].join('');

    // Wire form submission
    document.getElementById('login-form').addEventListener('submit', _handleSubmit);

    // Clear error on any input change
    document.getElementById('login-name-select').addEventListener('input', _clearError);
    document.getElementById('login-code-input').addEventListener('input', _clearError);
  }

  function _populateNameSelect(select) {
    // Keep the placeholder option
    var placeholder = select.options[0];
    select.innerHTML = '';
    select.appendChild(placeholder);

    _teamNames.slice().sort().forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      select.appendChild(opt);
    });
  }

  // ── Form submission ───────────────────────────────────────

  function _handleSubmit(e) {
    e.preventDefault();

    var name = (document.getElementById('login-name-select').value || '').trim();
    var code = document.getElementById('login-code-input').value.trim();

    if (!name) {
      _showError('Please enter your name.');
      return;
    }
    if (!code) {
      _showError('Please enter your access code.');
      return;
    }

    _setLoading(true);
    _clearError();

    // Fetch team names on first call if not yet loaded
    // (Sheets.authenticate handles the actual auth check)
    Sheets.authenticate(name, code, function (result) {
      _setLoading(false);

      if (!result.success) {
        _showError(result.error || 'Invalid name or access code. Please try again.');
        _clearCode();
        return;
      }

      // Persist session — code is needed on every Sheets request
      sessionStorage.setItem('app_name', result.name);
      sessionStorage.setItem('app_role', result.role);
      sessionStorage.setItem('app_code', code);

      // Hide login, fire callback
      _hide('screen-login');
      if (typeof _onLoginSuccess === 'function') {
        _onLoginSuccess(result.name, result.role);
      }
    });
  }

  // ── UI helpers ────────────────────────────────────────────

  function _showError(msg) {
    var el = document.getElementById('login-error');
    if (!el) return;
    el.textContent = msg;
    el.removeAttribute('hidden');
    // Shake animation
    el.classList.remove('login-error-shake');
    void el.offsetWidth; // reflow to restart
    el.classList.add('login-error-shake');
  }

  function _clearError() {
    var el = document.getElementById('login-error');
    if (el) el.setAttribute('hidden', '');
  }

  function _clearCode() {
    var el = document.getElementById('login-code-input');
    if (el) { el.value = ''; el.focus(); }
  }

  function _setLoading(on) {
    var btn     = document.getElementById('login-submit');
    var text    = document.getElementById('login-btn-text');
    var spinner = document.getElementById('login-btn-spinner');
    var select  = document.getElementById('login-name-select');
    var input   = document.getElementById('login-code-input');

    if (on) {
      btn.disabled    = true;
      select.disabled = true;
      input.disabled  = true;
      text.textContent = 'Signing in';
      spinner.removeAttribute('hidden');
    } else {
      btn.disabled    = false;
      select.disabled = false;
      input.disabled  = false;
      text.textContent = 'Sign In';
      spinner.setAttribute('hidden', '');
    }
  }

  function _hasAppScriptUrl() {
    return !!(localStorage.getItem('apps_script_url') || '').trim();
  }

  function _show(id) {
    var el = document.getElementById(id);
    if (el) el.removeAttribute('hidden');
  }

  function _hide(id) {
    var el = document.getElementById(id);
    if (el) el.setAttribute('hidden', '');
  }

  // ── Styles ────────────────────────────────────────────────
  // Injected once at module load so login screen is self-contained
  // within forms.css — these styles complement forms.css

  (function _injectStyles() {
    try {
    if (document.getElementById('auth-styles')) return;
    var s = document.createElement('style');
    s.id = 'auth-styles';
    s.textContent = [

      // ── Two-column layout ──────────────────────────────────
      '.login-bg {',
        'display: flex;',
        'height: 100vh;',
        'width: 100vw;',
        'overflow: hidden;',
      '}',

      // ── Left branding strip ────────────────────────────────
      '.login-brand {',
        'width: 340px;',
        'flex-shrink: 0;',
        'background: var(--bg-navy);',
        'display: flex;',
        'align-items: center;',
        'justify-content: flex-start;',
        'padding: 56px 48px;',
        'position: relative;',
        'overflow: hidden;',
        // Dot-grid texture matching loading screen
        'background-image: radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1px);',
        'background-size: 28px 28px;',
        'background-color: var(--bg-navy);',
      '}',

      // Faint diagonal band for depth
      '.login-brand::after {',
        'content: "";',
        'position: absolute;',
        'inset: 0;',
        'background: linear-gradient(135deg,',
          'rgba(255,255,255,0.03) 0%, transparent 60%);',
        'pointer-events: none;',
      '}',

      '.login-brand-inner {',
        'position: relative;',
        'z-index: 1;',
      '}',

      '.login-brand-logo {',
        'display: block;',
        'width: 160px;',
        'max-width: 100%;',
        'margin-bottom: 28px;',
        'border-radius: 6px;',
      '}',

      '.login-brand-eyebrow {',
        'font-family: var(--font-mono);',
        'font-size: 9px;',
        'letter-spacing: 0.22em;',
        'text-transform: uppercase;',
        'color: var(--accent);',
        'opacity: 0.85;',
        'margin-bottom: 16px;',
      '}',

      '.login-brand-title {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 48px;',
        'line-height: 1.0;',
        'letter-spacing: 0.06em;',
        'text-transform: uppercase;',
        'color: var(--text-on-navy);',
      '}',

      '.login-brand-rule {',
        'width: 48px;',
        'height: 2px;',
        'background: var(--accent);',
        'margin: 20px 0 16px;',
        'opacity: 0.7;',
      '}',

      '.login-brand-sub {',
        'font-family: var(--font-display);',
        'font-weight: 500;',
        'font-size: 12px;',
        'letter-spacing: 0.24em;',
        'text-transform: uppercase;',
        'color: var(--text-muted-navy);',
      '}',

      // ── Right form panel ───────────────────────────────────
      '.login-panel {',
        'flex: 1;',
        'background: var(--bg-base);',
        'display: flex;',
        'flex-direction: column;',
        'align-items: center;',
        'justify-content: center;',
        'padding: 48px 32px;',
        'gap: 20px;',
      '}',

      // White card
      '.login-card {',
        'background: var(--bg-surface);',
        'border: 1px solid var(--border);',
        'padding: 44px 48px 40px;',
        'width: 100%;',
        'max-width: 400px;',
        'position: relative;',
        'box-shadow: 0 4px 24px rgba(26, 46, 74, 0.08);',
      '}',

      // Gold corner brackets
      '.login-card::before, .login-card::after {',
        'content: "";',
        'position: absolute;',
        'width: 14px;',
        'height: 14px;',
        'border-color: var(--accent);',
        'border-style: solid;',
      '}',
      '.login-card::before {',
        'top: -1px; left: -1px;',
        'border-width: 2px 0 0 2px;',
      '}',
      '.login-card::after {',
        'bottom: -1px; right: -1px;',
        'border-width: 0 2px 2px 0;',
      '}',

      '.login-card-eyebrow {',
        'font-family: var(--font-mono);',
        'font-size: 9px;',
        'letter-spacing: 0.2em;',
        'text-transform: uppercase;',
        'color: var(--accent);',
        'margin-bottom: 8px;',
        'opacity: 0.85;',
      '}',

      '.login-card-heading {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 28px;',
        'letter-spacing: 0.04em;',
        'text-transform: uppercase;',
        'color: var(--text-primary);',
        'margin-bottom: 32px;',
      '}',

      // Fields
      '.login-field {',
        'display: flex;',
        'flex-direction: column;',
        'gap: 6px;',
        'margin-bottom: 20px;',
      '}',

      '.login-label {',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 11px;',
        'letter-spacing: 0.14em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
      '}',

      // Shared input/select look
      '.login-input, .login-select {',
        'width: 100%;',
        'height: 42px;',
        'padding: 0 12px;',
        'font-family: var(--font-body);',
        'font-size: 14px;',
        'font-weight: 500;',
        'color: var(--text-primary);',
        'background: var(--bg-surface);',
        'border: 1px solid var(--border);',
        'border-radius: 0;',
        'outline: none;',
        'transition: border-color 0.15s, box-shadow 0.15s;',
        '-webkit-appearance: none;',
        'appearance: none;',
      '}',

      '.login-input:focus, .login-select:focus {',
        'border-color: var(--bg-navy);',
        'box-shadow: 0 0 0 3px var(--accent-dim);',
      '}',

      '.login-input::placeholder {',
        'color: #b0bcc9;',
        'font-weight: 400;',
      '}',

      // Custom select wrapper (hides native arrow)
      '.login-select-wrap {',
        'position: relative;',
      '}',

      '.login-select-chevron {',
        'position: absolute;',
        'right: 12px;',
        'top: 50%;',
        'transform: translateY(-50%);',
        'font-size: 8px;',
        'color: var(--text-secondary);',
        'pointer-events: none;',
      '}',

      // Error message
      '.login-error {',
        'padding: 10px 14px;',
        'background: rgba(192, 57, 43, 0.07);',
        'border-left: 3px solid var(--color-error);',
        'font-family: var(--font-body);',
        'font-size: 13px;',
        'color: var(--color-error);',
        'margin-bottom: 16px;',
        'line-height: 1.4;',
      '}',

      '@keyframes login-shake {',
        '0%, 100% { transform: translateX(0); }',
        '20%       { transform: translateX(-6px); }',
        '40%       { transform: translateX(6px); }',
        '60%       { transform: translateX(-4px); }',
        '80%       { transform: translateX(4px); }',
      '}',
      '.login-error-shake {',
        'animation: login-shake 0.35s ease;',
      '}',

      // Submit button
      '.login-btn {',
        'width: 100%;',
        'height: 44px;',
        'background: var(--bg-navy);',
        'color: var(--text-on-navy);',
        'border: none;',
        'cursor: pointer;',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 14px;',
        'letter-spacing: 0.16em;',
        'text-transform: uppercase;',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        'gap: 8px;',
        'transition: background 0.15s;',
        'margin-top: 4px;',
      '}',

      '.login-btn:hover:not(:disabled) {',
        'background: var(--bg-navy-deep);',
      '}',

      '.login-btn:disabled {',
        'opacity: 0.6;',
        'cursor: not-allowed;',
      '}',

      // Spinner inside button
      '.login-spinner {',
        'width: 14px;',
        'height: 14px;',
        'border: 2px solid rgba(255,255,255,0.25);',
        'border-top-color: #fff;',
        'border-radius: 50%;',
        'animation: login-spin 0.7s linear infinite;',
        'flex-shrink: 0;',
      '}',

      '@keyframes login-spin {',
        'to { transform: rotate(360deg); }',
      '}',

      // Footer note
      '.login-footer-note {',
        'font-family: var(--font-body);',
        'font-size: 11px;',
        'color: var(--text-secondary);',
        'text-align: center;',
        'opacity: 0.7;',
      '}',

      // ── Responsive: narrow screens ─────────────────────────
      '@media (max-width: 680px) {',
        '.login-brand { display: none; }',
        '.login-panel { padding: 24px 16px; }',
        '.login-card  { padding: 32px 24px 28px; }',
      '}',

    ].join('\n');

    document.head.appendChild(s);
    } catch (e) { console.error('[auth.js] _injectStyles() failed:', e); }
  }());

  // ── Expose ────────────────────────────────────────────────

  return {
    init:         init,
    setTeamNames: setTeamNames
  };

}());
