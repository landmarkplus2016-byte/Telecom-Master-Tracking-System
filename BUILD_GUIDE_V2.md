# BUILD_GUIDE_V2 — Option D: DuckDB + AG Grid
**Version:** 2.0 — Full architecture rebuild  
**Stack:** DuckDB WASM (in-browser DB) + AG Grid Community (renderer) + Apps Script (write gatekeeper)  
**Hosting:** GitHub Pages (unchanged)  
**Date started:** April 2026

---

## How to use this guide

Every session starts with one paste into Claude Code:

> Read CLAUDE.md first. Then read BUILD_GUIDE_V2.md. We are on **[Session X — Title]**.

That is all the context Claude Code needs. Do not summarise or paraphrase — just paste it verbatim.

Each session ends only when its test checklist passes completely. Do not move to the next session until every checkbox is ticked.

**Important:** BUILD_GUIDE_V2.md and CLAUDE.md must both be in your project root. CLAUDE.md is the authority on column definitions, business rules, and role logic. This guide is the authority on build order and what to do each session.

---

## Architecture overview

```
Browser
  ├── service-worker.js        ← injects COOP/COEP headers (enables DuckDB full-speed)
  ├── index.html               ← app shell, AG Grid CDN, DuckDB CDN
  ├── js/
  │   ├── db.js                ← NEW: DuckDB init, schema, all data operations
  │   ├── grid.js              ← REWRITE: AG Grid renderer, column defs, role logic
  │   ├── filters.js           ← REWRITE: search + column filters via SQL
  │   ├── app.js               ← EDIT: wire to db.js instead of offline.js
  │   ├── pricing.js           ← EDIT: price queries go through db.js
  │   ├── id.js                ← UNCHANGED
  │   └── sync.js              ← EDIT: delta sync writes to DuckDB not IDB
  ├── js/offline.js            ← RETIRED: replaced entirely by db.js
  └── tools/restore.html       ← UNCHANGED

Apps Script (Code.gs)          ← UNCHANGED — every line
Google Sheets                  ← UNCHANGED — Data, Config, Deleted tabs
```

**Data flow (read):**
Apps Script → JSON response → `db.js` loads into DuckDB → `grid.js` queries DuckDB → AG Grid renders result rows

**Data flow (write):**
User edits cell → AG Grid event → `grid.js` validates → `db.js` upserts locally → `sync.js` sends to Apps Script → Apps Script writes to Sheet

---

## File inventory: what changes and what doesn't

| File | Action | Reason |
|---|---|---|
| `Code.gs` | Untouched | Perfect as-is |
| `js/id.js` | Untouched | Independent logic |
| `tools/restore.html` | Untouched | Standalone tool |
| `js/app.js` | Minor edits | Replace offline.js calls with db.js calls |
| `js/pricing.js` | Minor edits | Price queries routed through db.js |
| `js/sync.js` | Minor edits | Writes to DuckDB not IDB |
| `js/offline.js` | Retired | db.js replaces it entirely |
| `js/grid.js` | Full rewrite | HOT → AG Grid, same business logic |
| `js/filters.js` | Full rewrite | Plugin approach → SQL WHERE clauses |
| `js/db.js` | New file | The core of Option D |
| `service-worker.js` | New file | COOP/COEP headers for DuckDB |
| `index.html` | CDN swap + SW registration | HOT out, AG Grid + DuckDB in |

---

## Session 1 — Service Worker + DuckDB Init + db.js Schema

### Goal
DuckDB is running in the browser. The schema is defined. Basic insert and query work. Nothing else — no grid, no login changes.

### What Claude Code will build
1. `service-worker.js` — intercepts fetch events and injects the two headers DuckDB requires (`Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`)
2. Register the service worker in `index.html` before any other script
3. Add DuckDB WASM CDN link to `index.html` (use the SharedArrayBuffer build since all coordinators have latest Chrome)
4. Create `js/db.js` with:
   - `Db.init()` — loads DuckDB WASM, opens OPFS-backed database
   - Schema creation — all 43 columns as defined in CLAUDE.md, plus system columns: `_row_id`, `_last_modified`, `_is_locked`, `_is_deleted`, `_pending_sync`, `_conflict`
   - `Db.getSessionOwner()` — returns `{ name, role }` or null
   - `Db.setSessionOwner(name, role)` — stamps current user into DB metadata
   - `Db.clearRows()` — wipes rows table only (used on user switch)
   - `Db.loadAllRows(rows)` — bulk insert array from Apps Script response
   - `Db.upsertRow(row)` — insert or update one row by `_row_id`
   - `Db.query(sql, params)` — execute parameterised query, return array of objects
   - `Db.getPendingRows()` — returns rows where `_pending_sync = true`
   - `Db.markSynced(rowId)` — clears `_pending_sync` flag after successful write

### Session prompt to paste into Claude Code

```
Read CLAUDE.md first. Then read BUILD_GUIDE_V2.md. We are on Session 1 — Service Worker + DuckDB Init + db.js Schema.

Build exactly what Session 1 describes. Use the SharedArrayBuffer DuckDB WASM build. The schema must include all 43 columns from CLAUDE.md plus the five system columns listed in the guide. Do not touch grid.js, app.js, or any other file except index.html, service-worker.js, and the new js/db.js.
```

### Test checklist — do not proceed until all pass

- [ ] App loads without console errors
- [ ] Service worker registered — visible in Chrome DevTools → Application → Service Workers
- [ ] Response headers include `Cross-Origin-Opener-Policy: same-origin` — visible in DevTools Network tab on any request
- [ ] `await Db.init()` runs without error in browser console
- [ ] `await Db.loadAllRows([{jc_number: 'TEST001', coordinator_name: 'Ahmed'}])` — no error
- [ ] `await Db.query('SELECT * FROM rows')` returns the test row
- [ ] `await Db.getSessionOwner()` returns null before set
- [ ] `await Db.setSessionOwner('Ahmed', 'coordinator')` — no error
- [ ] `await Db.getSessionOwner()` returns `{ name: 'Ahmed', role: 'coordinator' }` after set
- [ ] `await Db.clearRows()` — query returns empty array after
- [ ] OPFS persistence: run `Db.loadAllRows([...])`, close tab, reopen — data still queryable

---

## Session 2 — AG Grid Setup + Column Definitions + Role-Based Visibility

### Goal
AG Grid is rendering the correct columns for each role. No data from Apps Script yet — use hardcoded test rows. Role logic is correct.

### What Claude Code will build
1. Remove Handsontable CDN from `index.html`, add AG Grid Community CDN
2. Remove HOT initialisation from `grid.js`, replace with AG Grid initialisation
3. Define all 43 columns with correct types (text, number, date, dropdown) per CLAUDE.md
4. Implement role-based column visibility:
   - Coordinator: 26 columns visible, Coordinator column hidden
   - Invoicing: all 43 columns visible
   - Manager: all 43 columns visible
5. Wire AG Grid to query DuckDB: `Grid.loadData()` calls `Db.query('SELECT * FROM rows')` and feeds result to AG Grid
6. Light navy blue header theme matching existing app style
7. AG Grid row height, font size, and density matching existing app feel

### Session prompt

```
Read CLAUDE.md first. Then read BUILD_GUIDE_V2.md. We are on Session 2 — AG Grid Setup + Column Definitions + Role-Based Visibility.

Remove Handsontable from index.html and grid.js. Install AG Grid Community. Define all 43 columns from CLAUDE.md with correct types and role-based visibility as specified in the guide. Load data from Db.query() not from Apps Script yet. Preserve the light navy blue theme.
```

### Test checklist

- [ ] App loads without console errors
- [ ] Grid renders with correct columns for coordinator role (26 cols, no Coordinator column)
- [ ] Grid renders with all 43 columns for invoicing role
- [ ] Grid renders with all 43 columns for manager role
- [ ] Column types correct — dropdowns show dropdown editor, dates show date picker
- [ ] Hardcoded test rows visible in grid
- [ ] Header row has correct navy blue background
- [ ] Horizontal scroll works across all 43 columns
- [ ] No HOT references remain in index.html or grid.js

---

## Session 3 — Cell Editors, Row Locking, JC Uniqueness, Coordinator Isolation

### Goal
Business rules are enforced. Coordinators can only see and edit their own rows. Locked rows are read-only. JC numbers cannot be reused against a different Logical Site ID.

### What Claude Code will build

**Coordinator row isolation:**
- `Grid.loadData()` adds `WHERE coordinator_name = ?` for coordinator role, using session owner from `Db.getSessionOwner()`
- Manager and invoicing roles see all rows (no WHERE filter)

**Row locking:**
- On grid load, rows where `acceptance_status IS NOT NULL AND acceptance_status != ''` have `_is_locked = true` stamped in DuckDB
- AG Grid `editable` callback checks `_is_locked` — returns false for locked rows for coordinator role
- Manager and invoicing can always edit (no lock applies to them)
- Locked rows get a subtle visual indicator (slightly muted row, lock icon in ID# column)
- No notification shown to coordinator — silent behaviour as per CLAUDE.md

**JC uniqueness:**
- On any row where `jc_number` is edited, `db.js` runs: `SELECT logical_site_id FROM rows WHERE jc_number = ? AND _row_id != ?`
- If result exists and `logical_site_id` differs → reject edit, show inline error: "JC [number] is already bound to Site [id]"
- If result exists and `logical_site_id` matches → allow (same binding, no conflict)
- Enforced client-side via DuckDB query; server-side enforcement in Code.gs remains unchanged

**Coordinator auto-stamp:**
- On new row creation, `coordinator_name` is auto-filled from `sessionStorage.app_name`
- Coordinator column is never editable by coordinator role regardless of lock state

### Session prompt

```
Read CLAUDE.md first. Then read BUILD_GUIDE_V2.md. We are on Session 3 — Cell Editors, Row Locking, JC Uniqueness, Coordinator Isolation.

Implement all four items in this session: coordinator row isolation via SQL WHERE, row locking via _is_locked flag checked in AG Grid editable callback, JC uniqueness via DuckDB query on edit, and coordinator auto-stamp on row creation. Follow business rules exactly as defined in CLAUDE.md.
```

### Test checklist

- [ ] Coordinator logs in — sees only their own rows (SQL WHERE confirmed in DevTools)
- [ ] Manager logs in — sees all rows
- [ ] Invoicing logs in — sees all rows
- [ ] Row with acceptance_status filled — coordinator cannot edit any cell (click cell, nothing opens)
- [ ] Row with acceptance_status filled — manager CAN edit all cells
- [ ] Locked row has visual indicator distinguishing it from editable rows
- [ ] Create new row as coordinator — coordinator_name auto-fills, is not editable
- [ ] Enter duplicate JC with same Logical Site ID — allowed
- [ ] Enter duplicate JC with DIFFERENT Logical Site ID — rejected with inline error message
- [ ] Two coordinators on same browser (log out and in): Coordinator B sees zero of Coordinator A's rows

---

## Session 4 — Search and Column Filters via SQL + Totals via SQL SUM

### Goal
Search works instantly on any dataset size. Column filters work. Combined search + column filter works. Totals are always correct SQL aggregates.

### What Claude Code will build

**Global search (`filters.js` rewrite):**
- Search input calls `Db.query()` with `WHERE (col1 ILIKE ? OR col2 ILIKE ? OR ...)` across all visible text columns
- Result rows replace AG Grid's data source via `gridApi.setRowData(results)`
- Status bar updates: "N of [total] rows"
- No trimRows, no HOT Filters plugin — those concepts do not exist in this codebase

**Column filters:**
- AG Grid's native `agTextColumnFilter`, `agNumberColumnFilter`, `agDateColumnFilter` per column type
- On filter change event: collect AG Grid's current filter model, translate to SQL WHERE clauses, re-query DuckDB, update row data
- Column filter and global search compose: both active simultaneously = AND condition in SQL

**Totals bar:**
- New Total, LMP Total, Contractor Total always calculated via SQL SUM against current result set:
  ```sql
  SELECT SUM(new_total), SUM(lmp_amount), SUM(contractor_portion)
  FROM rows WHERE [current filter conditions]
  ```
- Totals update on every search or filter change
- Totals always go DOWN when filtering, never up

**Clear all filters:**
- Clears both global search input and AG Grid filter model
- Resets query to unfiltered, totals recalculate against full dataset

### Session prompt

```
Read CLAUDE.md first. Then read BUILD_GUIDE_V2.md. We are on Session 4 — Search and Column Filters via SQL + Totals via SQL SUM.

Rewrite filters.js entirely. Global search = SQL ILIKE query on DuckDB. Column filters = translate AG Grid filter model to SQL WHERE clauses. Both compose via AND. Totals = SQL SUM against current result set, recalculated on every filter change. No trimRows, no HOT plugin concepts.
```

### Test checklist

- [ ] Type "u0153" in search — only matching rows visible, totals update DOWN
- [ ] Clear search — all rows return, totals restore
- [ ] Column filter on any text column — rows filter correctly
- [ ] Column filter on a number column — greater than / less than works
- [ ] Column filter on a date column — date range works
- [ ] Search + column filter together — both apply (AND logic)
- [ ] Clear All Filters button — both search and column filters clear simultaneously
- [ ] Totals never go UP when filtering, always go DOWN or stay same
- [ ] Status bar shows correct row count at all times
- [ ] Search on 6,000+ rows returns results in under 100ms

---

## Session 5 — Delta Sync Rewired to DuckDB + Pending Queue + Write-Back

### Goal
The full sync cycle works end-to-end. App fetches from Apps Script on load, stores in DuckDB, edits queue locally, flush writes back to Apps Script.

### What Claude Code will build

**App startup flow:**
1. `app.js` calls `Db.init()`
2. Check session owner — if mismatch with current user, call `Db.clearRows()` then force full fetch
3. If match — check last_modified timestamp, fetch only changed rows (delta sync)
4. Full fetch on first load or user switch
5. All fetched rows go through `Db.loadAllRows()` / `Db.upsertRow()` — never into IDB

**Pending queue:**
- DuckDB `pending_queue` table: `(row_id, payload JSON, queued_at, retry_count)`
- On edit: upsert row into `rows` table immediately (optimistic), insert into `pending_queue`
- `sync.js` processes pending_queue in batches of 50 (unchanged batch size)
- On successful write: `Db.markSynced(rowId)`, remove from pending_queue
- On failure: increment retry_count, surface error after 3 retries

**Offline detection:**
- Same as current: navigator.onLine + fetch timeout
- While offline: edits accumulate in pending_queue, grid shows local state from DuckDB
- On reconnect: sync.js flushes pending_queue automatically

**Deleted rows:**
- `Db.deleteRow(rowId)` sets `_is_deleted = true`, adds to pending_queue with action `'delete'`
- Apps Script receives delete instruction, moves row to Deleted sheet
- Manager view: `SELECT * FROM rows WHERE _is_deleted = true` shows deleted rows tab

### Session prompt

```
Read CLAUDE.md first. Then read BUILD_GUIDE_V2.md. We are on Session 5 — Delta Sync Rewired to DuckDB + Pending Queue + Write-Back.

Rewire app.js startup to use Db.init() and session owner check instead of offline.js. Rewire sync.js to write pending edits from DuckDB pending_queue to Apps Script in batches of 50. Full delta sync cycle must work end-to-end with real Apps Script. Retire offline.js completely — remove all references.
```

### Test checklist

- [ ] Log in — data loads from Apps Script into DuckDB (confirm in DevTools Network: one request for full data)
- [ ] Log out, log in as same user — delta sync only (check Network: request includes last_modified param)
- [ ] Log out, log in as different coordinator — `Db.clearRows()` fires, full fetch for new user
- [ ] Edit a cell while online — change saves to Apps Script (check Sheet)
- [ ] Go offline (DevTools → Network → Offline), edit a cell — no error, edit visible in grid
- [ ] Come back online — pending edit syncs automatically, Sheet updates
- [ ] Delete a row as manager — row disappears from main grid, appears in deleted rows view
- [ ] Pending queue: `Db.query('SELECT * FROM pending_queue')` — empty when all synced
- [ ] Batch sync: create 55 rows offline, come online — two batches of 50+5 in Network tab
- [ ] Session isolation: Coordinator A data not visible after Coordinator B login

---

## Session 6 — Price Versioning via SQL

### Goal
Price versioning logic is moved from JS iteration into DuckDB SQL queries. Historical re-evaluation respects locked rows and manual overrides. Effective date fallback works correctly.

### What Claude Code will build

**Price versions table in DuckDB:**
```sql
CREATE TABLE price_versions (
  id INTEGER PRIMARY KEY,
  contractor TEXT NOT NULL,
  rate DECIMAL(10,2) NOT NULL,
  effective_date DATE NOT NULL,
  is_active BOOLEAN DEFAULT true
)
```

**Effective price query for a row:**
```sql
SELECT rate FROM price_versions
WHERE contractor = ?
AND effective_date <= ?
AND is_active = true
ORDER BY effective_date DESC
LIMIT 1
```
Falls back to most recent active version if no version exists for the exact work date (as per CLAUDE.md).

**Historical re-evaluation:**
When a price version is backdated or edited, re-evaluate all affected rows:
```sql
SELECT * FROM rows
WHERE contractor = ?
AND work_date >= ?
AND _is_locked = false
AND price_manual_override = false
```
For each returned row, recalculate the correct price and upsert. Locked rows and manually overridden rows are skipped — query never touches them.

**LMP / Contractor portion auto-calculation:**
On any row where price or contractor changes, recalculate:
```sql
SELECT split_percentage FROM contractor_splits
WHERE contractor = ?
```
In-House contractor always uses 100/0 split. Other contractors use Config tab values loaded into `contractor_splits` DuckDB table on startup.

**`pricing.js` update:**
Replace JS iteration logic with calls to `Db.query()` for all price lookups. The public API of `pricing.js` stays the same — callers don't need to change.

### Session prompt

```
Read CLAUDE.md first. Then read BUILD_GUIDE_V2.md. We are on Session 6 — Price Versioning via SQL.

Move all price versioning logic from JS iteration in pricing.js into DuckDB SQL queries. Create price_versions and contractor_splits tables. Implement the effective price query, historical re-evaluation query (skip locked and manually overridden rows), and LMP/Contractor portion auto-calculation. The public API of pricing.js must not change — callers are unaffected.
```

### Test checklist

- [ ] Add a new price version for a contractor, effective April 1 — rows from April 1 onwards recalculate
- [ ] Rows before April 1 keep their previous price
- [ ] Locked rows are NOT recalculated when price version changes
- [ ] Manually overridden rows are NOT recalculated
- [ ] In-House contractor always shows 100/0 LMP/Contractor split
- [ ] Other contractors show correct split from Config tab
- [ ] Backdate a price version — re-evaluation skips locked rows, updates unlocked ones
- [ ] Row with no price version for its work date — falls back to most recent active version
- [ ] `Db.query('SELECT * FROM price_versions')` shows all versions

---

## Session 7 — Conflict Resolution Panel + Presence Heartbeat + Manager Features

### Goal
Conflict resolution works. Manager can see, resolve, and dismiss conflicts. Presence heartbeat works. Manager-only features (Clear All Data, deleted rows view) work.

### What Claude Code will build

**Conflict detection:**
- On sync, if Apps Script returns a version mismatch error → store conflict in DuckDB `conflicts` table:
  ```sql
  CREATE TABLE conflicts (
    row_id TEXT,
    local_payload JSON,
    server_payload JSON,
    detected_at TIMESTAMP,
    resolved BOOLEAN DEFAULT false
  )
  ```
- Badge on manager toolbar shows count of unresolved conflicts

**Conflict resolution panel:**
- Manager-only UI panel (modal or sidebar)
- Shows local version vs server version side by side for each conflict
- Manager picks winner: "Keep mine" or "Keep server version"
- On resolution: winning version written to Apps Script, conflict marked resolved in DuckDB

**Presence heartbeat:**
- Unchanged from current implementation — runs in app.js, pings Apps Script every 30 seconds
- No changes needed beyond confirming it still works after Session 5 rewire

**Deleted rows view (Manager):**
- Tab or toggle in manager view: `SELECT * FROM rows WHERE _is_deleted = true`
- Manager can restore a deleted row: `_is_deleted = false`, adds restore to pending_queue

**Clear All Data (Manager only):**
- Requires typing "DELETE ALL DATA" to confirm (unchanged behaviour)
- On confirm: `Db.clearRows()`, send clear instruction to Apps Script
- Apps Script wipes Data sheet (Code.gs logic unchanged)

### Session prompt

```
Read CLAUDE.md first. Then read BUILD_GUIDE_V2.md. We are on Session 7 — Conflict Resolution Panel + Presence Heartbeat + Manager Features.

Build the conflicts table in DuckDB and the manager conflict resolution panel. Confirm presence heartbeat still works. Build the deleted rows view and restore flow. Build Clear All Data with the DELETE ALL DATA confirmation. All of these are manager-only features — other roles must not see them.
```

### Test checklist

- [ ] Simulate conflict: edit row locally, manually change same row in Sheet, sync — conflict detected
- [ ] Conflict badge appears on manager toolbar with correct count
- [ ] Conflict panel shows local and server versions side by side
- [ ] "Keep mine" — local version written to Sheet, conflict resolved
- [ ] "Keep server version" — server version restored in DuckDB, conflict resolved
- [ ] Coordinator does NOT see conflict panel or badge
- [ ] Deleted rows tab shows rows with `_is_deleted = true`
- [ ] Manager can restore a deleted row — it reappears in main grid
- [ ] Clear All Data button — typing anything except "DELETE ALL DATA" does nothing
- [ ] Clear All Data — typing "DELETE ALL DATA" wipes all rows from grid and Sheet
- [ ] Presence heartbeat pings visible in DevTools Network every 30 seconds

---

## Session 8 — Data Migration + Backup/Restore + Full End-to-End Test

### Goal
Real 6,500-row dataset loaded. All features verified under real data volume. Backup exports correctly. Restore works. App is production-ready.

### What Claude Code will build

**One-time data migration (Manager only):**
- CSV/Excel upload in manager settings panel
- Preview first 20 rows before committing
- On confirm: parse file, bulk insert into DuckDB via `Db.loadAllRows()`, send full batch to Apps Script in groups of 50
- Duplicate JC detection before insert — report any conflicts before writing
- Progress indicator showing batch completion (e.g. "Uploading 450 of 6,500...")

**Backup (already works via `tools/restore.html` — verify only):**
- `tools/restore.html` reads JSON backup and exports to Excel
- Confirm this still works with DuckDB-sourced data
- Backup JSON format: same structure as before, sourced from `Db.query('SELECT * FROM rows')`

**Performance verification under real load:**
- Load full 6,500 rows into DuckDB
- Measure: initial load time, search response time, filter response time, totals calculation time

### Session prompt

```
Read CLAUDE.md first. Then read BUILD_GUIDE_V2.md. We are on Session 8 — Data Migration + Backup/Restore + Full End-to-End Test.

Build the manager-only CSV/Excel migration tool with preview, duplicate detection, and batch upload progress. Verify tools/restore.html still works correctly. Then run the full test checklist against the real 6,500-row dataset.
```

### Test checklist — production readiness

**Migration:**
- [ ] Upload CSV of 100 test rows — preview shows first 20
- [ ] Duplicate JC numbers flagged before commit
- [ ] Confirm upload — rows appear in grid and in Sheet
- [ ] Progress bar shows correct batch count during upload

**Performance (6,500 rows):**
- [ ] Initial app load (cold, OPFS hit): under 3 seconds
- [ ] Initial app load (subsequent, OPFS): under 1 second
- [ ] Global search on 6,500 rows: result in under 100ms
- [ ] Column filter on 6,500 rows: result in under 100ms
- [ ] Totals calculation on 6,500 rows: under 50ms

**Full role coverage:**
- [ ] Coordinator: sees only own rows, can add/edit unlocked rows, cannot edit locked rows
- [ ] Invoicing: sees all 43 columns, can edit all rows
- [ ] Manager: sees all rows, conflict panel, deleted rows, Clear All Data
- [ ] Two coordinators switching on same browser: zero data bleed

**Sync:**
- [ ] Online edit → Sheet updated within 5 seconds
- [ ] Offline edit → queued → synced on reconnect
- [ ] Delta sync on revisit (not full reload)

**Backup/Restore:**
- [ ] Export backup JSON from manager panel
- [ ] Open `tools/restore.html`, upload JSON → Excel downloads correctly with all columns

**Price versioning:**
- [ ] Add new price version → correct rows recalculate, locked rows skip
- [ ] Historical backdate → re-evaluation runs, locked and overridden rows skip

---

## Key business rules reference (do not reimplement — enforce as-is from CLAUDE.md)

These rules are in CLAUDE.md in full. This is a quick-reference only:

| Rule | Enforcement layer |
|---|---|
| Row ownership = coordinator_name value | SQL WHERE in Db.query() |
| Coordinator column hidden from coordinator role | AG Grid column visibility config |
| Row locked when acceptance_status filled | _is_locked flag in DuckDB, checked in AG Grid editable callback |
| Lock is permanent and silent | No notification, no unlock |
| JC permanently bound to one Logical Site ID | DuckDB query on edit, Code.gs server-side |
| Price effective April 1, fallback to last active | SQL ORDER BY effective_date DESC LIMIT 1 |
| Historical re-evaluation skips locked + manual override | SQL WHERE _is_locked = false AND price_manual_override = false |
| LMP/Contractor split from Config tab | contractor_splits DuckDB table, In-House always 100/0 |
| Individual access codes, not shared per role | Config tab, validated by Apps Script, unchanged |
| Clear All Data requires typing "DELETE ALL DATA" | Client check + Apps Script confirmation |
| Coordinator column auto-stamps on row creation | Stamped from sessionStorage.app_name on new row |
| Delta sync in batches of 50 | sync.js, unchanged batch size |

---

## Troubleshooting quick reference

| Symptom | First thing to check |
|---|---|
| DuckDB won't initialise | Check DevTools → Network: are COOP/COEP headers present on the page response? |
| OPFS not persisting | Chrome version — must be 108+. Check `await navigator.storage.getDirectory()` in console |
| Grid blank after login | `Db.query('SELECT COUNT(*) FROM rows')` — if 0, data didn't load; check sync.js |
| Search returns wrong rows | Log the SQL query being sent to Db.query() — paste it in console directly |
| Totals incorrect | Run the SUM query directly in console against current filter conditions |
| Coordinator sees other rows | Check session owner — `await Db.getSessionOwner()` should match logged-in user |
| Conflict not detected | Check Apps Script response for version_mismatch error field |
| Push not reaching GitHub | Run `git ls-remote origin` — verify commit hash matches local `git log --oneline -1` |

---

## What "done" looks like

At the end of Session 8, the app:
- Loads 6,500 rows from DuckDB in under 1 second on return visits
- Searches any column in under 100ms
- Shows correct totals at all times via SQL SUM
- Keeps coordinator data completely isolated between users on the same browser
- Queues edits offline, syncs on reconnect, never loses data
- Lets the manager resolve conflicts, view deleted rows, run data migration
- Applies correct prices via SQL with historical re-evaluation
- Backs up to JSON and restores to Excel via tools/restore.html
- Costs nothing to run — GitHub Pages, Apps Script, DuckDB, AG Grid are all free
