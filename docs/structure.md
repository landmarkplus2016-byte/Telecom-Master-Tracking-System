# File Structure — Telecom Coordinator Tracking App

One-line description of every file's job. No file does the job of another.

---

## Root

| File | Job |
|------|-----|
| `index.html` | App shell only — loads all CSS and JS, defines HTML structure and CSS variables, registers the service worker |
| `manifest.json` | PWA manifest — app name, icons, theme colour, `display: standalone`, start URL |
| `service-worker.js` | Offline caching (cache-first, all app shell files + CDN) and PWA update detection (SKIP_WAITING → reload) |

---

## css/

| File | Job |
|------|-----|
| `css/main.css` | Global polish — `::selection`, webkit scrollbars, focus ring, PWA update banner (`#update-banner`), status bar item typography |
| `css/grid.css` | Handsontable overrides only — column/row header navy styles, gold header border, zebra striping, cell state classes (locked, changed, readonly, JC error), context menu, scrollbar, selection |
| `css/forms.css` | Login and setup screen styles — split-panel layout, card with gold corner brackets, form fields, error shake animation, spinner; mirrors what `auth.js` / `config.js` inject at runtime |
| `css/filters.css` | Filter panel and global search bar — layout slot for `#filter-panel`, badge styles, Clear All button, `.gs-wrap` search input; mirrors what `filters.js` injects at runtime |

---

## js/

| File | Job |
|------|-----|
| `js/app.js` | Entry point and routing only — checks for an existing session, routes to setup → login → main app, wires all modules in the correct order, runs delta sync and background sync timer |
| `js/auth.js` | Login screen — builds and injects the login UI, reads the team member list from Apps Script, validates name + code, stores role and name in `sessionStorage` |
| `js/config.js` | First-launch setup screen — builds and injects the URL entry UI, saves the Apps Script URL to `localStorage`, verifies connectivity with a `ping` call |
| `js/sheets.js` | ALL Apps Script communication — every `fetch` call to the Web App goes through here; also handles presence heartbeat, cold-start indicator, and change notification polling |
| `js/grid.js` | Handsontable init and ALL column definitions — display label, internal key, column width, type, editor, dropdown source, read-only rules, row locking, row context menu, delta apply, export data |
| `js/id.js` | ID# auto-generation only — fires on blur when Job Code is filled and ID is empty; format `JC-YYMMDDHHmmss-rowIndex`; never overwrites an existing ID |
| `js/pricing.js` | Price version lookup and auto-calculation only — resolves the correct price version by Task Date, calculates New Total Price, LMP Portion, and Contractor Portion; handles price mismatch warnings |
| `js/offline.js` | IndexedDB and sync queue only — stores all rows in IDB for offline read, queues saves when offline, drains the queue on reconnect, detects and stores conflict copies, shows sync and conflict indicators |
| `js/backup.js` | File System Access API backup only — picks and remembers the backup folder, writes `backup_latest.json` after every save, runs scheduled backups at 8:00 AM and 3:00 PM, prunes to 14 rolling named backups, injects the "Backup Now" toolbar button |
| `js/filters.js` | Global search bar and column filter status panel only — injects the `#global-search-wrap` search input, applies live text filtering via `Grid.applyGlobalSearch`, tracks HOT column filter count, shows active-filter badges in `#filter-panel` |
| `js/delete.js` | Soft delete workflow and Manager panel only — delete confirmation modal, calls `Sheets.softDeleteRow`, Manager panel shows Deleted Records tab with Restore / Delete Permanently actions, contains the Clear All Data danger zone |
| `js/export.js` | Excel export only — export options modal (scope, coordinator filter, filename), builds `.xlsx` workbook via `xlsx-js-style`, applies header styling and column widths matching grid column definitions |
| `js/reconcile.js` | TSR reconciliation workflow only — 4-step panel (TSR Sub# entry → customer file upload → change review → done), parses customer feedback Excel, matches rows by `logical_site_id` + `line_item`, writes `po_status` and `actual_quantity` changes in batches |

---

## appscript/

| File | Job |
|------|-----|
| `appscript/Code.gs` | Google Apps Script — deployed separately as a Web App; the only code that touches the Google Sheet directly; handles auth, row reads/writes, delta sync, presence, soft delete, conflict detection, config parsing, and Clear All Data |

---

## data/

| File | Job |
|------|-----|
| `data/dropdowns.js` | Static fallback dropdown values — used if the Config tab is unreachable on startup; keeps the grid functional when Apps Script is unavailable |

---

## tools/

| File | Job |
|------|-----|
| `tools/restore.html` | Standalone JSON → Excel restore tool — works in any browser with no server; drag in a backup JSON file, preview metadata, download a formatted `.xlsx` with freeze pane, autofilter, and styled headers |

---

## docs/

| File | Job |
|------|-----|
| `docs/setup.md` | Setup guide — Google Sheet creation, Config tab layout, Apps Script deployment, first-launch connection, team member management, price version configuration, backup setup, troubleshooting |
| `docs/structure.md` | This file — one-line description of every file's job |

---

## icons/

| File | Job |
|------|-----|
| `icons/icon-192.png` | PWA icon at 192×192 — used by Android home screen and Chrome install prompt |
| `icons/icon-512.png` | PWA icon at 512×512 — used by splash screen and `maskable` purpose in manifest |

---

## Design rules enforced by this structure

- **One file, one job.** No logic crosses file boundaries except through the public API each module exposes.
- **Only `js/sheets.js` calls Apps Script.** No other file makes a network request to the Web App URL.
- **Column definitions live only in `js/grid.js`.** Display label and internal key are always kept together.
- **CSS variables are defined once in `index.html`'s inline `<style>`.** All CSS files and JS-injected styles reference them via `var(--name)`.
- **Sensitive data never in code.** The Apps Script URL lives in `localStorage` only. Access codes live in the Google Sheet Config tab only. Neither appears in any file in this repository.
