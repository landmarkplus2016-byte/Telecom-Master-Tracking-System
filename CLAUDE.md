# CLAUDE.md — Coordinator Tracking App
> This file is Claude Code's persistent memory for this project.
> Read this at the start of every session before writing any code.

---

## What We Are Building

A PWA (Progressive Web App) replacing a telecom coordinator Excel tracking sheet.
- Hosted on GitHub Pages (public repo — NO sensitive data ever in code)
- Google Sheets as backend database, accessed ONLY through Google Apps Script
- AG Grid Community Edition for the Excel-like grid
- Offline-first via DuckDB WASM + OPFS (replaces IndexedDB), local backup via File System Access API
- Service worker injects COOP/COEP headers required by DuckDB SharedArrayBuffer build

---

## Non-Negotiable Rules

1. **No sensitive data in code** — Apps Script URL lives in localStorage only, Sheet URL never leaves the manager
2. **Never call Google Sheets directly** — ALL reads/writes go through `js/sheets.js` → Apps Script only
3. **One file, one job** — never add logic to a file that belongs in another file
4. **Column definitions live in `js/grid.js` only** — display label and internal key are always separate (AG Grid column defs)
5. **Coordinators never see invoicing columns** — enforced server-side in Apps Script, not just frontend
6. **Row locks are permanent** — once Acceptance Status is filled, coordinators cannot edit that row, no exceptions
7. **Delta sync only** — never fetch all rows after first load; always sync by `last_modified` timestamp
8. **No shared access codes** — every person has their own individual code in the Config tab

---

## Three Roles — Quick Reference

| Role | Sees | Edits | Rows visible |
|---|---|---|---|
| Coordinator | 26 coordinator columns only (Coordinator column hidden) | Own rows only (coordinator columns) | Own rows only |
| Invoicing | All 43 columns | All coordinator columns + all invoicing columns, on all rows | All rows |
| Manager | All 43 columns + Deleted tab | Everything, on all rows | All rows |

> ⚠️ Invoicing edits ALL columns (not just invoicing columns) on ALL rows — not just their own. Do not restrict invoicing team to invoicing columns only.

---

## Row Ownership — Coordinator Column Rules

**How ownership works:**
- A row belongs to whoever's name is currently in the `Coordinator` column — not who created it
- When a coordinator logs in, the app shows only rows where `Coordinator` column = their name
- This means ownership is flexible and fully reassignable by the Manager at any time

**Coordinator column visibility & edit rules:**
- **Coordinator role:** column is completely hidden — they never see it in their grid
- **Invoicing role:** column is visible but read-only — they can see who owns a row but cannot change it
- **Manager role:** column is fully editable — the only role that can reassign rows

**Auto-fill on row creation:**
- When a coordinator creates a new row, the `Coordinator` column is auto-filled with their own name silently on save
- Coordinator never types it themselves — it is set automatically in the background
- Without this, a coordinator would create a row and immediately not see it

**Reassignment:**
- Manager can change the `Coordinator` field from the app or directly in Google Sheets — both work
- Bulk reassignment (e.g. coordinator leaves): filter by old name → select all → update field → rows immediately appear for the new coordinator on their next sync
- Row data, ID#, and history are fully preserved on reassignment — nothing else changes

---

## Row Locking — Full Rules

**Lock trigger:** Acceptance Status field is filled
**Lock effect:** Row becomes permanently read-only for coordinators — no exceptions, no unlock
**Who can fill Acceptance Status (trigger the lock):**
- Invoicing ✅
- Manager ✅
- Coordinator ❌ — Acceptance Status is not an editable field for coordinators at all

**How locked rows appear to coordinator:**
- Subtly greyed out with 🔒 icon
- Coordinator can still read, filter, sort, search — locking only blocks editing
- Click to edit → show message: *"This record is locked because acceptance is in progress. Contact the invoicing team for changes."*

**Manager is never locked out** — Manager can edit any row regardless of lock status.

---

## File Map — One Job Per File

```
tracking-app/
├── CLAUDE.md               ← you are here
├── index.html              # App shell only — loads all JS/CSS
├── manifest.json           # PWA manifest
├── service-worker.js       # COOP/COEP header injection + offline caching + update banner
│
├── css/
│   ├── main.css            # Global styles & CSS variables only
│   ├── grid.css            # AG Grid overrides only
│   ├── forms.css           # Login & setup forms only
│   └── filters.css         # Filter panel only
│
├── js/
│   ├── app.js              # App init & routing only (keep tiny)
│   ├── auth.js             # Login, role detection, access code check
│   ├── config.js           # First-launch Apps Script URL setup screen
│   ├── sheets.js           # ALL Apps Script calls — nothing else calls Apps Script
│   ├── grid.js             # AG Grid init + ALL column definitions
│   ├── db.js               # DuckDB WASM init, schema, all data operations (replaces offline.js)
│   ├── id.js               # ID# auto-generation only
│   ├── pricing.js          # Price version lookup + Task Date logic only (queries via db.js)
│   ├── backup.js           # File System Access API + scheduled backup only
│   ├── filters.js          # Column filter logic + global search via SQL only
│   ├── delete.js           # Soft delete + warning modal only
│   ├── export.js           # Excel export only
│   └── reconcile.js        # TSR reconciliation workflow only
│
├── appscript/
│   └── Code.gs             # Google Apps Script — deployed separately
│
├── data/
│   └── dropdowns.js        # Fallback dropdowns if Config tab unreachable
│
├── tools/
│   └── restore.html        # Standalone JSON → Excel restore tool
│
└── docs/
    ├── setup.md            # Setup guide for Apps Script + app connection
    └── structure.md        # Full file map reference
```

---

## Key Business Logic — Know Before You Code

### ID# Auto-Generation (`js/id.js`)
```javascript
function generateID(jobCode, rowIndex) {
    const prefix = jobCode.trim().substring(0, 2).toUpperCase();
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${prefix}-${yy}${mm}${dd}${hh}${min}${ss}-${rowIndex}`;
}
```
- Only fires if ID column is empty AND Job Code is filled
- Never overwrites an existing ID

### JC Uniqueness Validation (`js/grid.js`)
- Fires on blur when user leaves the JC field
- Queries DuckDB: if same JC exists on a different Logical Site ID → error
- Field cleared + highlighted red + inline message: *"Job Code [JC] is already assigned to site [Logical Site ID]."*
- Also enforced server-side in Apps Script on save
- Applies to all roles

### Price Versioning (`js/pricing.js`)
- Version determined by Task Date, NOT entry date
- No Task Date → use current active version
- Task Date entered → look up version valid on that date
- Version change on date entry → show warning before updating
- Effective dates follow customer policy: April 1 each year
- Customer may delay or skip a version — system handles this automatically:
  - No new version added yet → system keeps using last active version, nothing breaks
  - Manager adds a backdated version later → system backdates correctly using the April 1 effective date

**Backdated version re-evaluation rule:**
- When manager adds a new price version (including backdated ones), the system must re-evaluate all unlocked rows whose Task Date falls within that version's range
- Any affected row shows the ⚠️ version mismatch warning so the manager can review
- Locked rows (Acceptance Status filled) are NEVER retroactively changed — their prices are frozen at the time of locking
- Rows with no Task Date are NOT re-evaluated — they stay on the current active version

**Manual price override — Manager only:**
- Manager can manually override the New Price on any individual row regardless of what the version lookup returns
- When a manual override is set: row shows a 📝 indicator making it clear the price is manually set, not version-driven
- Auto-calculation of New Total Price, LMP Portion, and Contractor Portion still runs from the overridden New Price
- If the price version changes later, the manually overridden row is NOT re-evaluated automatically — the override takes permanent precedence
- Manager can clear the override at any time to return the row to version-driven pricing
- No other role can override prices on individual rows

**Historical price version editing — Manager only:**
- Manager can edit any price version in the Config tab, including historical ones
- After editing a historical version: same backdated re-evaluation rule applies — all unlocked rows in that version's date range show the ⚠️ warning
- Manually overridden rows are NOT re-evaluated even if their version's prices change
- Locked rows are NEVER re-evaluated regardless of version changes

### LMP / Contractor Portions (`js/pricing.js`)
- Auto-calculated from New Total Price × contractor split % at Task Date
- Never manually entered
- In-House contractor = 100% LMP, 0% Contractor always

### Delta Sync (`js/db.js` + `js/sheets.js`)
- First load: fetch all rows once → store in DuckDB via OPFS
- Every subsequent sync: fetch only rows where `last_modified` > last sync timestamp
- Bulk writes (e.g. TSR reconciliation): batch in groups of 50, show progress indicator
- Never fetch full dataset again after first load

### Presence & Notifications (`js/sheets.js`)
- Heartbeat: write name + timestamp to `Presence` tab every 30 seconds (silent)
- Change log: Apps Script writes to `Changes` tab on every row save
- Manager sees row highlight + coordinator avatar pulse when coordinator saves — one-directional only
- Coordinators are NOT notified when manager edits their rows

### Offline Conflict Resolution
- Conflict scenario: user edits a row offline → same row edited online by someone else → conflict on sync
- Do NOT silently overwrite — save the offline version as a conflict copy tagged `⚠️ CONFLICT` in Google Sheets
- Online version (Person B's) stays untouched as the live row
- Manager sees a "X conflicts need review" indicator
- **Conflict panel (Manager only):** side-by-side view of both versions per field, showing who saved each and when
  - Manager clicks **Keep This** on the version to keep → other is discarded → conflict resolved
  - Manager can also manually merge by editing fields directly in the panel before resolving

### Global Search Bar (`js/filters.js`)
- Single search bar at the top of the page, above the grid — one bar for all roles
- Live filtering as you type — no Enter key needed
- Works simultaneously with column filters — both apply at the same time
- Role-scoped: coordinator searches own rows + coordinator columns only; invoicing/manager search all rows + all visible columns
- Runs against local DuckDB — instant SQL query, no Apps Script call

### Backup (`js/backup.js`)
- Per-save: silent write to `backup_latest.json` after every save
- Scheduled: 8:00 AM + 3:00 PM daily, auto-named `backup_YYYY-MM-DD_HHhmm.json`
- Rolling: 14 files kept, oldest auto-deleted when 15th would be created
- Manual: "Backup Now" button available to all roles
- All backups write to the folder chosen on first launch

### Cold Start Handling
- Apps Script goes to sleep after inactivity — first request after sleep takes 5–8 seconds
- On app launch: show a subtle "Connecting..." or "Waking up..." indicator immediately
- Never let the app appear broken during cold start — it is expected and normal
- After first successful request: all subsequent requests run at normal speed

### PWA Update Banner (`service-worker.js`)
- Service worker checks for updates silently on every app open
- When a new version is ready: show banner — *"A new update is available — click to refresh"* [Update Now]
- User clicks → app reloads with new version
- Config tab changes (prices, dropdowns, names) update on next sync — no banner needed
- Code changes (features, bug fixes) require the banner flow

### Clear All Data — Manager Only (`js/delete.js`)
This feature exists to support the test → go-live transition. The manager can wipe all tracking data cleanly without touching the Sheet manually.

**What it does:**
- Deletes all rows from the `Data` tab in Google Sheets
- Deletes all rows from the `Deleted` tab
- Clears the local DuckDB database completely (OPFS store wiped)
- Clears all local backup files in the chosen backup folder

**What it does NOT touch:**
- `Config` tab — dropdowns, team members, price versions, contractor splits all preserved
- `Presence` tab — clears itself naturally
- `Changes` tab — auto-pruned separately

**UI rules:**
- Hidden in a "Danger Zone" section of a Manager-only panel — not visible in the main toolbar
- Requires typing `DELETE ALL DATA` to confirm — not just a single click
- Warning shown: *"This will permanently delete all tracking records. This cannot be undone. Type DELETE ALL DATA to confirm."*
- After completion: app reloads fresh, DuckDB rebuilt from the now-empty Sheet
- Implemented in `appscript/Code.gs` as a dedicated `clearAllData()` function — called from `js/sheets.js` → `js/delete.js`

---

## Google Sheets Tab Reference

| Tab | Purpose |
|---|---|
| `Data` | All tracking records |
| `Config` | Dropdowns, team members, price versions, contractor splits |
| `Deleted` | Soft-deleted records (Manager only) |
| `Presence` | Heartbeat — who is online (always ~10 rows max) |
| `Changes` | Change notification log (auto-pruned) |

---

## Build Stages — Follow BUILD_GUIDE_V2.md

> ⚠️ The original 5-stage build plan has been replaced by a full architecture rebuild.
> **Do not follow the stage plan below.** Read `BUILD_GUIDE_V2.md` for the current 8-session build plan.
>
> Stack change: Handsontable → AG Grid Community, IndexedDB → DuckDB WASM + OPFS.
> All business rules, column definitions, and role logic in this file remain authoritative and unchanged.
> Only the technology layer has changed.

---

### Original Stage Reference (superseded — for context only)

**Stage 1** — Foundation: Apps Script, auth, grid display
**Stage 2** — Core Business Rules: ID#, pricing, locking, JC uniqueness
**Stage 3** — Offline & Sync: storage, delta sync, presence, conflicts
**Stage 4** — Invoicing Features: reconciliation, export, delete, filters
**Stage 5** — Polish & Safety Net: backup, restore, PWA, Clear All Data

---

## Excel Generation Rules — xlsx Skill

Apply the xlsx skill when working on any of these files:
- `js/export.js` — coordinator, invoicing, and manager Excel exports
- `tools/restore.html` — JSON backup → Excel conversion

**What the skill covers:**
- Correct column widths, header styling, and cell formatting
- Date and number format consistency
- Multi-sheet workbook structure where needed
- File download triggering in the browser

---

## Excel Import Rules — file-reading Skill

Apply the file-reading skill only when building the one-time migration feature:
- Manager import of the existing `Coordinator_Tracking_Sheet.xlsm`
- This is a single build session — install the skill when ready for that feature

---

## UI Design Rules — frontend-design Skill

Apply these rules to every UI file (`index.html`, all `css/` files):

- **Tone:** Clean, sharp, professional internal tool — not decorative, not generic
- **Density:** Data-dense but not cluttered — this is a tracking tool used all day
- **Typography:** Distinctive, readable fonts — never Inter, Roboto, Arial, or system fonts
- **Colors:** High contrast, cohesive CSS variables — dominant color + sharp accent
- **Motion:** Subtle and purposeful only — micro-interactions on save, sync, lock events
- **Consistency:** Every modal, button, badge, and indicator follows the same visual language
- **Never:** Purple gradients, cookie-cutter layouts, generic AI aesthetics

Role-based visual indicators to implement consistently:
- 🔒 Locked rows — subtle grey tint
- ⚠️ Conflict rows — amber highlight
- ● Pending sync — status bar indicator
- ✓ Synced — brief confirmation
- Avatar bubbles — presence indicator, floating top-right

---

## What NOT to Do

- Never add a feature not in this file without confirming with the project owner
- Never store the Apps Script URL, Sheet URL, or any access code in the codebase
- Never call Apps Script from any file except `js/sheets.js`
- Never fetch all rows from the Sheet after the first load
- Never allow coordinators to see invoicing columns — strip server-side, not just hidden in CSS
- Never build a Settings UI — all config is managed in Google Sheets Config tab directly
- Never hard-delete records — soft delete only, moved to Deleted tab (the one exception is Clear All Data which is a full wipe by design)
- Never restrict Invoicing team to invoicing columns only — they edit all 43 columns on all rows
- Never make Clear All Data easy to trigger accidentally — it must require typing `DELETE ALL DATA` to confirm and must be hidden from the main UI

---

*Read `BUILD_GUIDE_V2.md` for the current session-by-session build plan.*
*This file (CLAUDE.md) is the authority on all business rules, column definitions, and role logic.*
*Full planning details in the project handoff document.*
