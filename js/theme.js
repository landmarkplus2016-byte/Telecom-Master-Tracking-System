// ============================================================
// theme.js — Theme selection and persistence
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Apply saved theme from localStorage on init
//   - Render a card-style dropdown in the filter-panel ribbon
//   - Persist theme choice to localStorage
//   - Update PWA theme-color meta on every switch
//
// Public API:
//   Theme.init()           — apply saved theme + sync meta tag
//   Theme.set(themeId)     — switch to named theme + persist
//   Theme.renderDropdown() — inject dropdown into #filter-panel
//
// Theme IDs: 'navy' | 'blue' | 'dark' | 'green' | 'purple'
//
// CSS variable overrides live in index.html's inline <style>
// as html[data-theme="xxx"] { --variable: value; } blocks.
// The early-apply inline script in <head> sets data-theme
// before first paint to prevent any flash of default theme.
//
// The dropdown anchor (#theme-dropdown-anchor) is injected
// into #filter-panel. filters.js preserves it across every
// _refreshPanel call so it survives filter changes.
// ============================================================

var Theme = (function () {

  var THEMES = [
    {
      id:      'navy',
      label:   'Navy Gold',
      desc:    'DEFAULT \u00b7 WARM',
      header:  '#1a2e4a',
      accent:  '#c9973a',
      surface: '#f0f2f5'
    },
    {
      id:      'blue',
      label:   'Blue',
      desc:    'PROFESSIONAL \u00b7 COOL',
      header:  '#295097',
      accent:  '#4472c4',
      surface: '#f0f4fa'
    },
    {
      id:      'dark',
      label:   'Dark Mode',
      desc:    'GOLD ON GRAPHITE',
      header:  '#21262d',
      accent:  '#c9973a',
      surface: '#0d1117'
    },
    {
      id:      'green',
      label:   'Green',
      desc:    'FOREST \u00b7 NATURAL',
      header:  '#28563f',
      accent:  '#4a9e6a',
      surface: '#f0f5f2'
    },
    {
      id:      'purple',
      label:   'Purple / Pink',
      desc:    'VIOLET \u00b7 VIVID',
      header:  '#462a78',
      accent:  '#9b59d0',
      surface: '#f5f2fa'
    },
  ];

  var LS_KEY   = 'app_theme';
  var _open    = false;

  // ── Public: init ─────────────────────────────────────────

  function init() {
    var saved = localStorage.getItem(LS_KEY) || 'navy';
    _apply(saved);
  }

  // ── Public: set ───────────────────────────────────────────

  function set(themeId) {
    _apply(themeId);
    localStorage.setItem(LS_KEY, themeId);
    _closePanel();
    _syncButton();
  }

  // ── Internal: apply ───────────────────────────────────────

  function _apply(themeId) {
    var theme = _find(themeId) || THEMES[0];
    document.documentElement.setAttribute('data-theme', theme.id);

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.header);

    // Sync active state on any rendered cards
    var cards = document.querySelectorAll('.tdp-card');
    for (var i = 0; i < cards.length; i++) {
      var active = cards[i].getAttribute('data-theme') === theme.id;
      if (active) {
        cards[i].classList.add('tdp-card--active');
      } else {
        cards[i].classList.remove('tdp-card--active');
      }
    }
  }

  function _find(themeId) {
    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].id === themeId) return THEMES[i];
    }
    return null;
  }

  // ── Public: renderDropdown ────────────────────────────────
  // Injects the anchor + compact button into #filter-panel.
  // filters.js preserves #theme-dropdown-anchor across refreshes.

  function renderDropdown() {
    if (document.getElementById('theme-dropdown-anchor')) return;
    var panel = document.getElementById('filter-panel');
    if (!panel) return;

    var anchor = document.createElement('div');
    anchor.id = 'theme-dropdown-anchor';

    anchor.appendChild(_buildButton());
    _injectStyles();
    panel.appendChild(anchor);

    // Close when clicking outside both the anchor AND the floating panel.
    // The panel is appended to document.body (fixed positioning) so it
    // lives outside the anchor — both must be checked.
    document.addEventListener('click', function (e) {
      if (!_open) return;
      var anch  = document.getElementById('theme-dropdown-anchor');
      var pnl   = document.getElementById('theme-dropdown-panel');
      var inAnch = anch && anch.contains(e.target);
      var inPnl  = pnl  && pnl.contains(e.target);
      if (!inAnch && !inPnl) _closePanel();
    });

    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (_open && (e.key === 'Escape' || e.keyCode === 27)) _closePanel();
    });
  }

  // ── Build the compact trigger button ─────────────────────

  function _buildButton() {
    var current = _find(localStorage.getItem(LS_KEY) || 'navy') || THEMES[0];

    var btn = document.createElement('button');
    btn.id = 'theme-dropdown-btn';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');

    btn.innerHTML =
      '<span class="tdd-swatches">' +
        '<span class="tdd-sw" style="background:' + current.header  + '"></span>' +
        '<span class="tdd-sw" style="background:' + current.accent  + '"></span>' +
      '</span>' +
      '<span class="tdd-name">' + current.label.toUpperCase() + '</span>' +
      '<span class="tdd-arrow">&#9660;</span>';

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (_open) { _closePanel(); } else { _openPanel(); }
    });

    return btn;
  }

  // ── Sync button label/swatches after theme change ─────────

  function _syncButton() {
    var btn = document.getElementById('theme-dropdown-btn');
    if (!btn) return;
    var current = _find(localStorage.getItem(LS_KEY) || 'navy') || THEMES[0];
    var swatches = btn.querySelectorAll('.tdd-sw');
    var nameEl   = btn.querySelector('.tdd-name');
    if (swatches[0]) swatches[0].style.background = current.header;
    if (swatches[1]) swatches[1].style.background = current.accent;
    if (nameEl)      nameEl.textContent = current.label.toUpperCase();
  }

  // ── Open / close panel ────────────────────────────────────

  function _openPanel() {
    var btn = document.getElementById('theme-dropdown-btn');
    if (!btn) return;

    var existing = document.getElementById('theme-dropdown-panel');
    if (existing) existing.parentNode.removeChild(existing);

    var panel = _buildPanel();

    // #app-body and #screen-app both have overflow:hidden which clips
    // absolutely-positioned children. Fix: use position:fixed anchored
    // to the button's screen coordinates so the panel escapes all clipping.
    var rect   = btn.getBoundingClientRect();
    var pWidth = 240; // matches CSS width

    panel.style.position = 'fixed';
    panel.style.width    = pWidth + 'px';
    // Open downward — ribbon is near the top so there's more space below
    panel.style.top      = (rect.bottom + 2) + 'px';
    panel.style.bottom   = 'auto';
    // Align right edge of panel with right edge of button; clamp to viewport
    var rightOffset = window.innerWidth - rect.right;
    panel.style.right = Math.max(4, rightOffset) + 'px';
    panel.style.left  = 'auto';

    document.body.appendChild(panel);
    _open = true;

    if (btn) btn.setAttribute('aria-expanded', 'true');
  }

  function _closePanel() {
    var panel = document.getElementById('theme-dropdown-panel');
    if (panel) panel.parentNode.removeChild(panel);
    _open = false;
    var btn = document.getElementById('theme-dropdown-btn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  // ── Build the dropdown card panel ─────────────────────────

  function _buildPanel() {
    var current = localStorage.getItem(LS_KEY) || 'navy';

    var panel = document.createElement('div');
    panel.id = 'theme-dropdown-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Color theme selector');

    // Header
    var hdr = document.createElement('div');
    hdr.className = 'tdp-header';
    hdr.innerHTML =
      '<span class="tdp-eyebrow">APPEARANCE</span>' +
      '<span class="tdp-title">COLOR THEME</span>';
    panel.appendChild(hdr);

    // Theme cards
    var list = document.createElement('div');
    list.className = 'tdp-list';

    THEMES.forEach(function (theme) {
      var card = document.createElement('div');
      card.className = 'tdp-card' + (theme.id === current ? ' tdp-card--active' : '');
      card.setAttribute('data-theme', theme.id);
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('title', theme.label);

      card.innerHTML =
        '<span class="tdp-swatches">' +
          '<span class="tdp-sw tdp-sw--lg" style="background:' + theme.header  + '"></span>' +
          '<span class="tdp-sw tdp-sw--lg" style="background:' + theme.accent  + '"></span>' +
          '<span class="tdp-sw tdp-sw--lg" style="background:' + theme.surface + ';border:1px solid #d0d7e2"></span>' +
        '</span>' +
        '<span class="tdp-info">' +
          '<span class="tdp-card-name">' + theme.label.toUpperCase() + '</span>' +
          '<span class="tdp-card-desc">' + theme.desc + '</span>' +
        '</span>' +
        '<span class="tdp-check" aria-hidden="true">&#10003;</span>';

      card.addEventListener('click', function () { set(theme.id); });
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); set(theme.id); }
      });

      list.appendChild(card);
    });

    panel.appendChild(list);
    return panel;
  }

  // ── Styles ────────────────────────────────────────────────

  function _injectStyles() {
    if (document.getElementById('theme-dropdown-styles')) return;
    var s = document.createElement('style');
    s.id = 'theme-dropdown-styles';
    s.textContent = [

      /* ── Anchor wrapper ── */
      '#theme-dropdown-anchor {',
        'margin-left: auto;',
        'position: relative;',
        'flex-shrink: 0;',
        'display: flex;',
        'align-items: center;',
        'height: 100%;',
        'padding: 0 8px;',
        'border-left: 1px solid var(--border);',
      '}',

      /* ── Trigger button ── */
      '#theme-dropdown-btn {',
        'display: flex;',
        'align-items: center;',
        'gap: 6px;',
        'height: 24px;',
        'padding: 0 10px 0 7px;',
        'background: var(--bg-surface);',
        'border: 1px solid var(--border);',
        'cursor: pointer;',
        'font-family: var(--font-display);',
        'font-weight: 600;',
        'font-size: 10px;',
        'letter-spacing: 0.1em;',
        'color: var(--text-secondary);',
        'white-space: nowrap;',
        'transition: border-color 0.15s, color 0.15s;',
      '}',

      '#theme-dropdown-btn:hover {',
        'border-color: var(--accent);',
        'color: var(--text-primary);',
      '}',

      '#theme-dropdown-btn[aria-expanded="true"] {',
        'border-color: var(--accent);',
        'color: var(--text-primary);',
      '}',

      /* Mini swatches in the button */
      '.tdd-swatches {',
        'display: flex;',
        'gap: 2px;',
        'flex-shrink: 0;',
      '}',

      '.tdd-sw {',
        'display: block;',
        'width: 10px;',
        'height: 14px;',
        'flex-shrink: 0;',
      '}',

      '.tdd-arrow {',
        'font-size: 8px;',
        'color: var(--text-secondary);',
        'margin-left: 2px;',
      '}',

      /* ── Dropdown panel ─────────────────────────────────────── */
      /* position/top/bottom/right are set inline by _openPanel   */
      /* using getBoundingClientRect so it escapes overflow:hidden */
      '#theme-dropdown-panel {',
        'width: 240px;',
        'background: var(--bg-surface);',
        'border: 1px solid var(--border);',
        'box-shadow: 0 8px 32px rgba(10,20,35,0.18);',
        'z-index: 8000;',
        'animation: tdp-in 0.14s ease-out;',
      '}',

      '@keyframes tdp-in {',
        'from { opacity:0; transform: translateY(-6px); }',
        'to   { opacity:1; transform: translateY(0);    }',
      '}',

      /* Panel header */
      '.tdp-header {',
        'padding: 10px 14px 8px;',
        'border-bottom: 1px solid var(--border);',
      '}',

      '.tdp-eyebrow {',
        'display: block;',
        'font-family: var(--font-mono);',
        'font-size: 8px;',
        'letter-spacing: 0.18em;',
        'text-transform: uppercase;',
        'color: var(--accent);',
        'margin-bottom: 2px;',
      '}',

      '.tdp-title {',
        'display: block;',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 14px;',
        'letter-spacing: 0.06em;',
        'text-transform: uppercase;',
        'color: var(--text-primary);',
      '}',

      /* Card list */
      '.tdp-list {',
        'padding: 6px;',
        'display: flex;',
        'flex-direction: column;',
        'gap: 4px;',
      '}',

      /* Individual card */
      '.tdp-card {',
        'display: flex;',
        'align-items: center;',
        'gap: 10px;',
        'padding: 8px 10px;',
        'border: 1px solid var(--border);',
        'cursor: pointer;',
        'transition: border-color 0.12s, background 0.12s;',
        'outline: none;',
      '}',

      '.tdp-card:hover {',
        'background: var(--bg-base);',
        'border-color: var(--accent);',
      '}',

      '.tdp-card--active {',
        'border-color: var(--accent) !important;',
        'background: var(--accent-dim) !important;',
      '}',

      '.tdp-card:focus-visible {',
        'box-shadow: 0 0 0 2px var(--accent);',
      '}',

      /* Large swatches in cards */
      '.tdp-swatches {',
        'display: flex;',
        'flex-shrink: 0;',
        'overflow: hidden;',
        'border: 1px solid rgba(0,0,0,0.08);',
      '}',

      '.tdp-sw--lg {',
        'width: 20px;',
        'height: 34px;',
      '}',

      /* Card text */
      '.tdp-info {',
        'flex: 1;',
        'min-width: 0;',
      '}',

      '.tdp-card-name {',
        'display: block;',
        'font-family: var(--font-display);',
        'font-weight: 700;',
        'font-size: 11px;',
        'letter-spacing: 0.1em;',
        'text-transform: uppercase;',
        'color: var(--text-primary);',
        'line-height: 1.2;',
      '}',

      '.tdp-card-desc {',
        'display: block;',
        'font-family: var(--font-mono);',
        'font-size: 8px;',
        'letter-spacing: 0.12em;',
        'text-transform: uppercase;',
        'color: var(--text-secondary);',
        'margin-top: 2px;',
      '}',

      /* Checkmark — only visible on active card */
      '.tdp-check {',
        'font-size: 13px;',
        'color: var(--accent);',
        'flex-shrink: 0;',
        'opacity: 0;',
        'transition: opacity 0.12s;',
      '}',

      '.tdp-card--active .tdp-check {',
        'opacity: 1;',
      '}',

    ].join('\n');
    document.head.appendChild(s);
  }

  // ── Expose ────────────────────────────────────────────────

  return {
    init:           init,
    set:            set,
    renderDropdown: renderDropdown
  };

}());
