// ============================================================
// app.js — App init and routing
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Entry point: called last after all modules are loaded
//   - Check for existing session (sessionStorage) on reload
//   - Route to: setup screen → login screen → main app
//   - Wire toolbar buttons (role-gated)
//   - Show / hide screens
//
// This is a Stage 1 stub. Expand in later stages as each
// module (grid, filters, backup, etc.) is built out.
// ============================================================

(function () {

  // ── Init ──────────────────────────────────────────────────

  function init() {
    console.log('[app.js] init() — starting');

    // If a session already exists (page reload within same tab),
    // skip login and go straight to the app.
    var name = sessionStorage.getItem('app_name');
    var role = sessionStorage.getItem('app_role');

    if (name && role) {
      console.log('[app.js] Session found — name:', name, 'role:', role);
      _showApp(name, role);
      return;
    }

    console.log('[app.js] No session — handing off to Auth.init()');

    // No session → Auth handles setup-screen-or-login routing
    Auth.init(function onLoginSuccess(name, role) {
      console.log('[app.js] Login success — name:', name, 'role:', role);
      _showApp(name, role);
    });
  }

  // ── Show main app ─────────────────────────────────────────

  function _showApp(name, role) {
    console.log('[app.js] _showApp() — role:', role);

    // Hide loading screen
    _hide('screen-loading');

    // Render app chrome (logo + role badge in header)
    _renderHeader(name, role);

    // Show the main app screen
    _show('screen-app');

    // TODO Stage 1 Step 6: init grid and fetch data
    // Grid.init(role, name);
    // Sheets.fetchAllRows(function(result) { ... });
  }

  // ── Header ────────────────────────────────────────────────

  function _renderHeader(name, role) {
    var logoEl = document.getElementById('app-logo');
    if (!logoEl) return;

    var roleLabel = _roleLabel(role);
    var roleCls   = 'role-badge--' + role;

    logoEl.innerHTML = [
      '<span class="app-wordmark">Telecom Tracker</span>',
      '<span class="role-badge ' + roleCls + '">' + roleLabel + '</span>',
    ].join('');

    // Inject minimal header styles if not yet present
    if (!document.getElementById('app-header-styles')) {
      var s = document.createElement('style');
      s.id  = 'app-header-styles';
      s.textContent = [
        '#app-header {',
          'display: flex;',
          'align-items: center;',
          'gap: 16px;',
          'height: 48px;',
          'padding: 0 20px;',
          'background: var(--bg-navy);',
          'border-bottom: 1px solid var(--border-navy);',
          'flex-shrink: 0;',
        '}',
        '#app-logo {',
          'display: flex;',
          'align-items: center;',
          'gap: 10px;',
        '}',
        '.app-wordmark {',
          'font-family: var(--font-display);',
          'font-weight: 700;',
          'font-size: 16px;',
          'letter-spacing: 0.1em;',
          'text-transform: uppercase;',
          'color: var(--text-on-navy);',
          'white-space: nowrap;',
        '}',
        '.role-badge {',
          'font-family: var(--font-mono);',
          'font-size: 9px;',
          'letter-spacing: 0.16em;',
          'text-transform: uppercase;',
          'padding: 3px 8px;',
          'border: 1px solid;',
          'white-space: nowrap;',
        '}',
        '.role-badge--coordinator {',
          'color: var(--text-muted-navy);',
          'border-color: var(--border-navy);',
        '}',
        '.role-badge--invoicing {',
          'color: var(--accent);',
          'border-color: rgba(201,151,58,0.4);',
        '}',
        '.role-badge--manager {',
          'color: #7ec8a0;',
          'border-color: rgba(126,200,160,0.4);',
        '}',
        '#screen-app {',
          'display: flex;',
          'flex-direction: column;',
          'height: 100vh;',
          'overflow: hidden;',
        '}',
        '#app-body {',
          'flex: 1;',
          'overflow: hidden;',
          'display: flex;',
          'flex-direction: column;',
        '}',
        '#grid-container {',
          'flex: 1;',
          'overflow: hidden;',
        '}',
        '#app-statusbar {',
          'display: flex;',
          'align-items: center;',
          'gap: 20px;',
          'height: 28px;',
          'padding: 0 16px;',
          'background: var(--bg-surface);',
          'border-top: 1px solid var(--border);',
          'font-family: var(--font-mono);',
          'font-size: 10px;',
          'letter-spacing: 0.1em;',
          'text-transform: uppercase;',
          'color: var(--text-secondary);',
          'flex-shrink: 0;',
        '}',
      ].join('\n');
      document.head.appendChild(s);
    }
  }

  function _roleLabel(role) {
    return { coordinator: 'Coordinator', invoicing: 'Invoicing', manager: 'Manager' }[role] || role;
  }

  // ── Helpers ───────────────────────────────────────────────

  function _show(id) {
    var el = document.getElementById(id);
    if (el) el.removeAttribute('hidden');
  }

  function _hide(id) {
    var el = document.getElementById(id);
    if (el) el.setAttribute('hidden', '');
  }

  // ── Boot ──────────────────────────────────────────────────

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}());
