// ============================================================
// service-worker.js — COOP/COEP header injection + offline caching + update banner
// Telecom Coordinator Tracking App
// ============================================================
//
// Responsibilities (this file only):
//   - Inject Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy
//     headers on every response so DuckDB WASM SharedArrayBuffer works
//   - Inject Cross-Origin-Resource-Policy: cross-origin on all responses
//     so cross-origin CDN resources load correctly under COEP
//   - Cache all app shell files on install for offline use
//   - Serve from cache (cache-first); fall back to network
//   - On new version deploy: stay in "waiting" state until
//     the page sends SKIP_WAITING, then activate + claim
//   - On controllerchange, the page reloads to apply update
//
// Update banner flow (wired in index.html registration script):
//   1. New SW installs, enters "waiting" state
//   2. Page detects waiting SW → shows #update-banner
//   3. User clicks "Update Now" → page sends SKIP_WAITING
//   4. SW calls skipWaiting() → becomes active controller
//   5. controllerchange fires → page reloads with new version
//
// Cache strategy:
//   App shell (local files + CDN) → cache-first
//   Apps Script / googleapis     → network only (always fresh)
//   Non-GET requests              → pass through to network
// ============================================================

// ── Cache identity ────────────────────────────────────────
// Bump CACHE_VERSION to force a full cache refresh on deploy.
// Old cache names are deleted in the activate handler.

var CACHE_VERSION = 'v39';
var CACHE_NAME    = 'telecom-tracker-' + CACHE_VERSION;

// ── App shell — files to pre-cache on install ─────────────
// All paths are relative to this file's location (app root).
// CDN resources are included so the app works fully offline.

var APP_SHELL = [
  './',
  './index.html',
  './manifest.json',

  // CSS
  './css/main.css',
  './css/grid.css',
  './css/forms.css',
  './css/filters.css',

  // JS — infrastructure
  './js/config.js',
  './js/auth.js',
  './js/sheets.js',

  // JS — business logic
  './js/db.js',
  './js/sync.js',
  './js/id.js',
  './js/pricing.js',
  './js/grid.js',

  // JS — UI features
  './js/filters.js',
  './js/delete.js',
  './js/export.js',
  './js/reconcile.js',

  // JS — background services + init
  './js/backup.js',
  './js/theme.js',
  './js/app.js',

  // Static data
  './data/dropdowns.js',

  // Icons
  './icons/icon-192.png',
  './icons/icon-512.png',

  // Logo
  './LMP%20Big%20Logo-Photoroom.png',

  // CDN — AG Grid Community Edition (replaces Handsontable)
  // Pin: bump here + in index.html if upgrading
  'https://cdn.jsdelivr.net/npm/ag-grid-community@33.0.0/styles/ag-grid.css',
  'https://cdn.jsdelivr.net/npm/ag-grid-community@33.0.0/styles/ag-theme-alpine.css',
  'https://cdn.jsdelivr.net/npm/ag-grid-community@33.0.0/dist/ag-grid-community.min.js',

  // CDN — xlsx-js-style (Excel export + restore tool)
  'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js',
];

// ── Domains that must never be served from cache ──────────
// Apps Script calls are always POST + cross-origin; network only.
// Google Fonts are CDN-cached separately and change infrequently.

var NETWORK_ONLY_HOSTS = [
  'script.google.com',
  'googleapis.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
];

function _isNetworkOnly(url) {
  return NETWORK_ONLY_HOSTS.some(function (host) {
    return url.indexOf(host) !== -1;
  });
}

// ── COOP / COEP / CORP header injection ───────────────────
// DuckDB WASM requires SharedArrayBuffer, which the browser only
// allows when the page is cross-origin isolated.  Cross-origin
// isolation is activated by these two headers on the HTML document:
//
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// We also stamp Cross-Origin-Resource-Policy: cross-origin on every
// response so that CDN resources (DuckDB WASM bundles, Handsontable,
// etc.) load correctly when COEP is active — without this, the browser
// blocks cross-origin resources that lack a CORP header of their own.
//
// Opaque responses (cross-origin, no CORS) cannot have headers added;
// we leave them untouched and let the browser enforce COEP as it sees fit.

function _addCOIHeaders(response) {
  if (!response || response.type === 'opaque') return response;

  var headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy',   'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers:    headers,
  });
}

// ══════════════════════════════════════════════════════════
// INSTALL — pre-cache app shell
// ══════════════════════════════════════════════════════════

self.addEventListener('install', function (e) {
  console.log('[SW] install — CACHE_NAME:', CACHE_NAME);

  e.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // addAll is atomic: if any URL fails the whole install fails.
      // CDN URLs are included; if the device is completely offline
      // during the FIRST install, those will miss — that's acceptable
      // because the app also requires a network call to Apps Script
      // before it can function at all.
      return cache.addAll(APP_SHELL);
    }).then(function () {
      console.log('[SW] install — app shell cached');
      // Do NOT call skipWaiting() here — we wait for the page to
      // send SKIP_WAITING so the user controls when the update applies.
    })
  );
});

// ══════════════════════════════════════════════════════════
// ACTIVATE — clean up old caches and claim all clients
// ══════════════════════════════════════════════════════════

self.addEventListener('activate', function (e) {
  console.log('[SW] activate — CACHE_NAME:', CACHE_NAME);

  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) { return key !== CACHE_NAME; })
          .map(function (key) {
            console.log('[SW] deleting old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(function () {
      // Claim all open pages so this SW controls them immediately
      // without requiring a reload after first activation.
      return self.clients.claim();
    })
  );
});

// ══════════════════════════════════════════════════════════
// FETCH — cache-first with network fallback
// ══════════════════════════════════════════════════════════

self.addEventListener('fetch', function (e) {
  var url = e.request.url;

  // 0. Ignore non-HTTP schemes (chrome-extension://, data:, etc.)
  if (!url.startsWith('http://') && !url.startsWith('https://')) return;

  // 1. Network-only: Apps Script, Google APIs, fonts
  if (_isNetworkOnly(url)) return;

  // 2. Non-GET: POST/PUT/DELETE pass straight to network
  //    (Apps Script calls are always POST — covered above too)
  if (e.request.method !== 'GET') return;

  // 3. Cache-first for everything else
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      if (cached) {
        // Serve from cache — inject COI headers so DuckDB WASM works
        // even when served from the cache on subsequent visits.
        return _addCOIHeaders(cached);
      }

      // Cache miss — try network
      return fetch(e.request).then(function (response) {
        // Only cache http/https responses — chrome-extension:// and other
        // schemes are not supported by the Cache API and will throw.
        if (response && response.status === 200 &&
            (url.startsWith('http://') || url.startsWith('https://'))) {
          // Store the original (unmodified) response in cache so the
          // cache entry stays intact; we add COI headers on the fly
          // at serve time via _addCOIHeaders above.
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(e.request, clone).catch(function () { /* skip uncacheable */ });
          });
        }
        // Return the network response with COI headers injected
        return _addCOIHeaders(response);
      }).catch(function () {
        // Offline + not cached: for page navigations return the
        // cached index.html so the app shell still loads.
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html').then(function (fallback) {
            return _addCOIHeaders(fallback);
          });
        }
        // For other resource types (scripts, images) — just fail.
        // The app will handle missing resources gracefully.
      });
    })
  );
});

// ══════════════════════════════════════════════════════════
// MESSAGE — handle SKIP_WAITING from the update banner
// ══════════════════════════════════════════════════════════
//
// When the user clicks "Update Now" the page sends:
//   { type: 'SKIP_WAITING' }
// to the waiting SW. We call skipWaiting() which causes the
// new SW to activate immediately. The page then detects the
// controllerchange event and reloads to pick up the new code.

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    console.log('[SW] SKIP_WAITING received — activating');
    self.skipWaiting();
  }
});
