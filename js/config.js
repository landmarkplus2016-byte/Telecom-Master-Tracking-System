// ============================================================
// config.js — First-launch Apps Script URL setup screen
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Show a setup screen when no Apps Script URL is in localStorage
//   - Validate the pasted URL as a genuine Apps Script web app URL
//   - Store it in localStorage under 'apps_script_url'
//   - Fire a callback when saved so auth.js can continue
//   - Never shown again once URL is stored
//
// localStorage key written here:
//   apps_script_url — the deployed Apps Script web app URL
//
// Called by auth.js:
//   Config.showSetup(onSaved)
//
// Called by sheets.js:
//   Config.getUrl()  — returns stored URL or null
// ============================================================

var Config = (function () {

  var STORAGE_KEY = 'apps_script_url';

  // ── Valid Apps Script URL patterns ───────────────────────
  // Accepted forms:
  //   https://script.google.com/macros/s/SCRIPT_ID/exec
  //   https://script.google.com/macros/s/SCRIPT_ID/exec?... (with params)
  var VALID_PATTERN = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(\?.*)?$/;

  // ── Public API ────────────────────────────────────────────

  function getUrl() {
    return (localStorage.getItem(STORAGE_KEY) || '').trim() || null;
  }

  function showSetup(onSaved) {
    _injectStyles();
    _renderSetup(onSaved);
    _show('screen-setup');
  }

  // ── Render ────────────────────────────────────────────────

  function _renderSetup(onSaved) {
    var container = document.getElementById('screen-setup');
    if (!container) return;

    container.innerHTML = [
      '<div class="setup-bg">',

        // Left branding strip — matches login screen
        '<div class="setup-brand">',
          '<div class="setup-brand-inner">',
            '<div class="setup-brand-eyebrow">Telecom Department</div>',
            '<div class="setup-brand-title">Tracking<br>System</div>',
            '<div class="setup-brand-rule"></div>',
            '<div class="setup-brand-sub">Coordinator Workspace</div>',
          '</div>',
        '</div>',

        // Right setup panel
        '<div class="setup-panel">',
          '<div class="setup-card">',

            '<div class="setup-step-badge">First-time setup</div>',
            '<h2 class="setup-heading">Connect to Google Sheets</h2>',
            '<p class="setup-description">',
              'To get started, paste the URL of your deployed Google Apps Script web app below. ',
              'This is the backend that connects the tracker to your Google Sheet.',
            '</p>',

            // Instruction callout
            '<div class="setup-callout">',
              '<div class="setup-callout-icon">?</div>',
              '<div class="setup-callout-body">',
                '<strong>Where do I find this URL?</strong>',
                '<ol class="setup-steps-list">',
                  '<li>Open your Google Apps Script project</li>',
                  '<li>Click <em>Deploy → Manage deployments</em></li>',
                  '<li>Copy the <em>Web app URL</em></li>',
                '</ol>',
              '</div>',
            '</div>',

            '<form id="setup-form" autocomplete="off" novalidate>',

              '<div class="setup-field">',
                '<label class="setup-label" for="setup-url-input">Apps Script Web App URL</label>',
                '<input',
                  ' id="setup-url-input"',
                  ' class="setup-input"',
                  ' type="url"',
                  ' placeholder="https://script.google.com/macros/s/.../exec"',
                  ' autocomplete="off"',
                  ' spellcheck="false"',
                  ' required',
                '>',
                '<div id="setup-url-hint" class="setup-field-hint">',
                  'URL must start with https://script.google.com/macros/s/…/exec',
                '</div>',
              '</div>',

              '<div id="setup-error" class="setup-error" hidden></div>',

              '<button id="setup-submit" class="setup-btn" type="submit">',
                '<span id="setup-btn-text">Save & Continue</span>',
                '<span id="setup-btn-spinner" class="setup-spinner" hidden></span>',
              '</button>',

            '</form>',

          '</div>',

          '<p class="setup-footer-note">',
            'This URL is stored only in your browser — never in the source code.',
          '</p>',
        '</div>',

      '</div>'
    ].join(' ');

    // Wire events
    var form  = document.getElementById('setup-form');
    var input = document.getElementById('setup-url-input');

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      _handleSave(onSaved);
    });

    // Live validation as user types / pastes
    input.addEventListener('input', _clearError);
    input.addEventListener('paste', function () {
      // Small delay so pasted value is in .value before we read it
      setTimeout(_liveValidate, 0);
    });
  }

  // ── Save handler ──────────────────────────────────────────

  function _handleSave(onSaved) {
    var input = document.getElementById('setup-url-input');
    var url   = (input.value || '').trim();

    if (!url) {
      _showError('Please paste your Apps Script URL before continuing.');
      input.focus();
      return;
    }

    if (!VALID_PATTERN.test(url)) {
      _showError(
        'That doesn\'t look like a valid Apps Script URL. ' +
        'It should match: https://script.google.com/macros/s/…/exec'
      );
      input.focus();
      return;
    }

    // Store and proceed — no network call here, sheets.js will
    // validate connectivity on the first actual request
    localStorage.setItem(STORAGE_KEY, url);

    _setLoading(true);

    // Brief pause so the user sees the button change before
    // the login screen appears (avoids jarring instant swap)
    setTimeout(function () {
      _setLoading(false);
      _hide('screen-setup');
      if (typeof onSaved === 'function') onSaved();
    }, 320);
  }

  // ── Live validation (paste feedback) ─────────────────────

  function _liveValidate() {
    var input = document.getElementById('setup-url-input');
    if (!input) return;
    var url = (input.value || '').trim();
    if (!url) return;

    if (VALID_PATTERN.test(url)) {
      input.classList.add('setup-input-valid');
      input.classList.remove('setup-input-invalid');
      _clearError();
    } else {
      input.classList.remove('setup-input-valid');
      input.classList.add('setup-input-invalid');
    }
  }

  // ── UI helpers ────────────────────────────────────────────

  function _showError(msg) {
    var el = document.getElementById('setup-error');
    if (!el) return;
    el.textContent = msg;
    el.removeAttribute('hidden');
    el.classList.remove('setup-error-shake');
    void el.offsetWidth;
    el.classList.add('setup-error-shake');
  }

  function _clearError() {
    var el = document.getElementById('setup-error');
    if (el) el.setAttribute('hidden', '');
  }

  function _setLoading(on) {
    var btn     = document.getElementById('setup-submit');
    var text    = document.getElementById('setup-btn-text');
    var spinner = document.getElementById('setup-btn-spinner');
    var input   = document.getElementById('setup-url-input');

    if (on) {
      btn.disabled   = true;
      input.disabled = true;
      text.textContent = 'Saving';
      spinner.removeAttribute('hidden');
    } else {
      btn.disabled   = false;
      input.disabled = false;
      text.textContent = 'Save & Continue';
      spinner.setAttribute('hidden', '');
    }
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

  function _injectStyles() {
    if (document.getElementById('config-styles')) return;
    var s = document.createElement('style');
    s.id = 'config-styles';
    s.textContent = [

      // ── Two-column layout (matches login) ──────────────────
      '.setup-bg {',
        'display: flex;',
        'height: 100vh;',
        'width: 100vw;',
        'overflow: hidden;',
      '}',

      // ── Left branding strip — identical to login ───────────
      '.setup-brand {',
        'width: 340px;',
        'flex-shrink: 0;',
        'background-color: var(--bg-navy);',
        'background-image: radial-gradient(circle, rgba(255,255,255,0.07) 1px, transparent 1px);',
        'background-size: 28px 28px;',
        'display: flex;',
        'align-items: center;',
        'justify-content: flex-start;',
        'padding: 56px 48px;',
        'position: relative;',
        'overflow: hidden;',
      '}',

      '.setup-brand::after {',
        'content: "";',
        'position: absolute;',
        'inset: 0;',
        'background: linear-gradient(135deg, rgba(255,255,255,0.03) 0%, transparent 60%);',
        'pointer-events: none;',
      '}',

      '.setup-brand-inner { position: relative; z-index: 1; }',

      '.setup-brand-eyebrow {',
        'font-family: var(--font-mono);',
        'font-size: 9px;',
        'letter-spacing: 0.22em;',
        'text-transform: uppercase;',
        'color: var(--accent);',
        'opacity: 0.85;',
        'margin-bottom: 16px;',
      '}',

      '.setup-brand-title {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 48px;',
        'line-height: 1.0;',
        'letter-spacing: 0.06em;',
        'text-transform: uppercase;',
        'color: var(--text-on-navy);',
      '}',

      '.setup-brand-rule {',
        'width: 48px;',
        'height: 2px;',
        'background: var(--accent);',
        'margin: 20px 0 16px;',
        'opacity: 0.7;',
      '}',

      '.setup-brand-sub {',
        'font-family: var(--font-display);',
        'font-weight: 500;',
        'font-size: 12px;',
        'letter-spacing: 0.24em;',
        'text-transform: uppercase;',
        'color: var(--text-muted-navy);',
      '}',

      // ── Right panel ────────────────────────────────────────
      '.setup-panel {',
        'flex: 1;',
        'background: var(--bg-base);',
        'display: flex;',
        'flex-direction: column;',
        'align-items: center;',
        'justify-content: center;',
        'padding: 48px 32px;',
        'gap: 20px;',
        'overflow-y: auto;',
      '}',

      // White card
      '.setup-card {',
        'background: var(--bg-surface);',
        'border: 1px solid var(--border);',
        'padding: 44px 48px 40px;',
        'width: 100%;',
        'max-width: 480px;',
        'position: relative;',
        'box-shadow: 0 4px 24px rgba(26, 46, 74, 0.08);',
      '}',

      // Gold corner brackets
      '.setup-card::before, .setup-card::after {',
        'content: "";',
        'position: absolute;',
        'width: 14px;',
        'height: 14px;',
        'border-color: var(--accent);',
        'border-style: solid;',
      '}',
      '.setup-card::before { top: -1px; left: -1px; border-width: 2px 0 0 2px; }',
      '.setup-card::after  { bottom: -1px; right: -1px; border-width: 0 2px 2px 0; }',

      // Step badge
      '.setup-step-badge {',
        'display: inline-block;',
        'font-family: var(--font-mono);',
        'font-size: 9px;',
        'letter-spacing: 0.18em;',
        'text-transform: uppercase;',
        'color: var(--accent);',
        'background: var(--accent-dim);',
        'border: 1px solid rgba(201,151,58,0.3);',
        'padding: 3px 8px;',
        'margin-bottom: 12px;',
      '}',

      '.setup-heading {',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 26px;',
        'letter-spacing: 0.04em;',
        'text-transform: uppercase;',
        'color: var(--text-primary);',
        'margin-bottom: 10px;',
      '}',

      '.setup-description {',
        'font-family: var(--font-body);',
        'font-size: 13px;',
        'color: var(--text-secondary);',
        'line-height: 1.6;',
        'margin-bottom: 24px;',
      '}',

      // Instruction callout box
      '.setup-callout {',
        'display: flex;',
        'gap: 14px;',
        'background: #f5f7fa;',
        'border: 1px solid var(--border);',
        'border-left: 3px solid var(--bg-navy);',
        'padding: 16px;',
        'margin-bottom: 28px;',
      '}',

      '.setup-callout-icon {',
        'width: 22px;',
        'height: 22px;',
        'border-radius: 50%;',
        'background: var(--bg-navy);',
        'color: var(--text-on-navy);',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 12px;',
        'display: flex;',
        'align-items: center;',
        'justify-content: center;',
        'flex-shrink: 0;',
        'margin-top: 1px;',
      '}',

      '.setup-callout-body {',
        'font-family: var(--font-body);',
        'font-size: 12px;',
        'color: var(--text-secondary);',
        'line-height: 1.5;',
      '}',

      '.setup-callout-body strong {',
        'color: var(--text-primary);',
        'font-weight: 600;',
        'display: block;',
        'margin-bottom: 6px;',
      '}',

      '.setup-steps-list {',
        'margin: 0;',
        'padding-left: 18px;',
      '}',

      '.setup-steps-list li { margin-bottom: 3px; }',
      '.setup-steps-list em { font-style: normal; font-weight: 600; color: var(--text-primary); }',

      // Field
      '.setup-field {',
        'display: flex;',
        'flex-direction: column;',
        'gap: 6px;',
        'margin-bottom: 8px;',
      '}',

      '.setup-label {',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 11px;',
        'letter-spacing: 0.14em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
      '}',

      '.setup-input {',
        'width: 100%;',
        'height: 42px;',
        'padding: 0 12px;',
        'font-family: var(--font-mono);',
        'font-size: 12px;',
        'color: var(--text-primary);',
        'background: var(--bg-surface);',
        'border: 1px solid var(--border);',
        'border-radius: 0;',
        'outline: none;',
        'transition: border-color 0.15s, box-shadow 0.15s;',
        '-webkit-appearance: none;',
        'appearance: none;',
      '}',

      '.setup-input:focus {',
        'border-color: var(--bg-navy);',
        'box-shadow: 0 0 0 3px var(--accent-dim);',
      '}',

      '.setup-input::placeholder {',
        'color: #b0bcc9;',
        'font-size: 11px;',
      '}',

      // Validation state borders
      '.setup-input-valid   { border-color: var(--color-success) !important; }',
      '.setup-input-invalid { border-color: var(--color-error) !important; }',

      '.setup-field-hint {',
        'font-family: var(--font-mono);',
        'font-size: 10px;',
        'color: var(--text-secondary);',
        'opacity: 0.7;',
        'margin-bottom: 20px;',
      '}',

      // Error box
      '.setup-error {',
        'padding: 10px 14px;',
        'background: rgba(192, 57, 43, 0.07);',
        'border-left: 3px solid var(--color-error);',
        'font-family: var(--font-body);',
        'font-size: 13px;',
        'color: var(--color-error);',
        'margin-bottom: 16px;',
        'line-height: 1.4;',
      '}',

      '@keyframes setup-shake {',
        '0%, 100% { transform: translateX(0); }',
        '20%       { transform: translateX(-6px); }',
        '40%       { transform: translateX(6px); }',
        '60%       { transform: translateX(-4px); }',
        '80%       { transform: translateX(4px); }',
      '}',
      '.setup-error-shake { animation: setup-shake 0.35s ease; }',

      // Submit button
      '.setup-btn {',
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
      '}',

      '.setup-btn:hover:not(:disabled) { background: var(--bg-navy-deep); }',

      '.setup-btn:disabled {',
        'opacity: 0.6;',
        'cursor: not-allowed;',
      '}',

      '.setup-spinner {',
        'width: 14px;',
        'height: 14px;',
        'border: 2px solid rgba(255,255,255,0.25);',
        'border-top-color: #fff;',
        'border-radius: 50%;',
        'animation: setup-spin 0.7s linear infinite;',
        'flex-shrink: 0;',
      '}',

      '@keyframes setup-spin { to { transform: rotate(360deg); } }',

      // Footer note
      '.setup-footer-note {',
        'font-family: var(--font-body);',
        'font-size: 11px;',
        'color: var(--text-secondary);',
        'text-align: center;',
        'opacity: 0.7;',
      '}',

      // Responsive
      '@media (max-width: 680px) {',
        '.setup-brand { display: none; }',
        '.setup-panel { padding: 24px 16px; }',
        '.setup-card  { padding: 32px 24px 28px; }',
      '}',

    ].join('\n');

    document.head.appendChild(s);
  }

  // ── Expose ────────────────────────────────────────────────

  return {
    getUrl:    getUrl,
    showSetup: showSetup
  };

}());
