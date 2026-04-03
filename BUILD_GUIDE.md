# Build Guide — Coordinator Tracking App
> Your step-by-step manual for building the app from zero to live.
> Work through this top to bottom. Check off each item as you go.

---

## Before You Write a Single Line of Code

### One-time setup checklist
- [ ] Create a Google Sheet with these tabs: `Data`, `Config`, `Deleted`, `Presence`, `Changes`
- [ ] In the `Config` tab, add your test team members (at least one per role: Coordinator, Invoicing, Manager) with personal codes
- [ ] Add a few sample dropdown values in Config (Vendors, Regions, Status options etc.)
- [ ] Create your project folder on your computer — name it `tracking-app`
- [ ] Drop `CLAUDE.md` into the root of that folder
- [ ] Open the folder in VS Code
- [ ] Open Claude Code (spark icon or `Ctrl+Shift+P` → Claude Code)
- [ ] Create a GitHub repository (public) and connect your local folder to it

### First message to Claude Code — copy and paste this exactly:
```
Read CLAUDE.md first and confirm you understand the project.
Then create the full folder and file structure as defined in
the File Map section — empty files only, no code yet.
Do not write any logic until I confirm the structure looks correct.
```

### After structure is created — verify before moving on:
- [ ] All folders exist: `css/`, `js/`, `appscript/`, `data/`, `tools/`, `docs/`
- [ ] All files exist and are empty
- [ ] `CLAUDE.md` is in the root
- [ ] No code has been written yet

---

## Stage 1 — Foundation

**Goal:** Log in as any role, see the correct columns, data round-trips to and from Google Sheets. Nothing else.

---

### Step 1.1 — Apps Script (`appscript/Code.gs`)

**Prompt:**
```
Read CLAUDE.md. We are on Stage 1, Step 1.
Build appscript/Code.gs — the full Apps Script gatekeeper.
It must handle:
- Receiving requests and reading the access code + role from the Config tab
- Authenticating users by name and personal code
- Reading all rows from the Data tab, stripping invoicing columns for coordinators
- Writing a single row to the Data tab
- Returning correct data shape for each role
No other functionality yet.
```

**When done — deploy it:**
- [ ] In Google Apps Script editor: Deploy → New deployment → Web App
- [ ] Set "Execute as" = Me, "Who has access" = Anyone
- [ ] Copy the Web App URL — you will paste this into the app on first launch
- [ ] Never put this URL in the code — it goes in localStorage only

**Tests for Step 1.1:**
- [ ] Open the Apps Script URL in your browser — should return a blank page or a simple JSON response, not an error
- [ ] In Apps Script editor, run the `doGet` function manually with a test payload — verify it returns the right columns for each role
- [ ] Confirm coordinator payload has 26 columns only — Coordinator column and all 16 invoicing columns are absent
- [ ] Confirm invoicing and manager payloads have all 43 columns

---

### Step 1.2 — App Shell (`index.html`)

**Prompt:**
```
Read CLAUDE.md. Stage 1, Step 2.
Build index.html — the app shell only.
It must load all CSS and JS files in the correct order.
Show a loading screen on launch.
No content yet — just the shell structure and correct file references.
Apply the frontend-design skill for the overall layout structure.
```

**Tests for Step 1.2:**
- [ ] Open `index.html` in Chrome — no console errors about missing files
- [ ] Loading screen appears
- [ ] All JS and CSS files are referenced correctly

---

### Step 1.3 — Auth (`js/auth.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 1, Step 3.
Build js/auth.js — login screen and role detection.
It must:
- Show a login screen with name dropdown + personal code field
- Call js/sheets.js to validate the code against Apps Script
- On success: store the role and name in sessionStorage, show the main app
- On failure: show an error message, clear the code field
- On first launch (no Apps Script URL stored): redirect to js/config.js setup screen
Apply the frontend-design skill for the login screen styling.
```

**Tests for Step 1.3:**
- [ ] First launch with no URL stored → setup screen appears asking for Apps Script URL
- [ ] Enter Apps Script URL → stored in localStorage, never visible in code
- [ ] Login with wrong code → error message shown, code field cleared
- [ ] Login as Coordinator → lands on main app
- [ ] Login as Invoicing → lands on main app
- [ ] Login as Manager → lands on main app
- [ ] Refresh page → stays logged in (sessionStorage persists within the tab)
- [ ] Close and reopen tab → returns to login screen (sessionStorage cleared)

---

### Step 1.4 — First Launch Config (`js/config.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 1, Step 4.
Build js/config.js — the first-launch setup screen.
It must:
- Show a clean setup screen asking the user to paste their Apps Script URL
- Validate that the URL looks like a valid Apps Script web app URL
- Store it in localStorage (never in code)
- Redirect to the login screen after saving
- Never be shown again once URL is saved (unless localStorage is cleared)
Apply the frontend-design skill for the setup screen styling.
```

**Tests for Step 1.4:**
- [ ] Pasting an invalid URL → validation error shown
- [ ] Pasting a valid Apps Script URL → saved to localStorage, redirected to login
- [ ] Clearing localStorage manually → setup screen appears again on next open
- [ ] URL is in localStorage, not anywhere in the source code

---

### Step 1.5 — Sheets Layer (`js/sheets.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 1, Step 5.
Build js/sheets.js — the only file in the app that talks to Apps Script.
It must:
- Read the Apps Script URL from localStorage on every call
- Authenticate a user (login call)
- Fetch all rows on first load
- Write a single row
- Show a "Connecting..." indicator on first call after inactivity (cold start handling)
- Handle errors gracefully — show a user-friendly message, never crash silently
No delta sync yet — full fetch only for now. We will upgrade to delta sync in Stage 3.
```

**Tests for Step 1.5:**
- [ ] Full data fetch returns rows correctly
- [ ] Write a row → appears in Google Sheet within a few seconds
- [ ] Disconnect internet → error message shown, app does not crash
- [ ] Reconnect → next action succeeds normally
- [ ] Cold start: first call after Apps Script sleep shows "Connecting..." indicator

---

### Step 1.6 — Grid (`js/grid.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 1, Step 6.
Build js/grid.js — Handsontable grid setup and all column definitions.
It must:
- Define all 43 columns with their internal key and display label
- Apply correct role-based visibility: coordinator sees 26 columns, invoicing and manager see all 43
- Coordinator column: hidden from coordinator, visible but read-only for invoicing, editable for manager only
- Render the grid with data fetched from js/sheets.js
- Basic display only — no business logic, no validation, no locking yet
Apply the frontend-design skill for grid styling and toolbar layout.
```

**Tests for Step 1.6:**
- [ ] Login as Coordinator → exactly 26 columns visible, Coordinator column absent
- [ ] Login as Invoicing → all 43 columns visible, Coordinator column read-only
- [ ] Login as Manager → all 43 columns visible, Coordinator column editable
- [ ] Data from Google Sheet appears in the grid correctly
- [ ] Adding a new row and saving → appears in Google Sheet
- [ ] Editing an existing row and saving → updates correctly in Google Sheet
- [ ] Column labels match exactly what was in the original Excel file

### ✅ Stage 1 Complete — Full check before moving on:
- [ ] All three roles can log in with their personal codes
- [ ] Each role sees exactly the right columns
- [ ] Data reads from and writes to Google Sheet correctly
- [ ] No sensitive data anywhere in the codebase — check every file
- [ ] Push to GitHub → app loads correctly from GitHub Pages URL

---

## Stage 2 — Core Business Rules

**Goal:** ID# generates correctly, price versioning resolves, JC uniqueness fires on blur, locked rows are read-only for coordinators.

---

### Step 2.1 — ID# Generation (`js/id.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 2, Step 1.
Build js/id.js — ID# auto-generation only.
Rules (from CLAUDE.md):
- Only fires if the ID column is empty AND Job Code is filled
- Never overwrites an existing ID
- Use the exact generateID function defined in CLAUDE.md
- Hook into the grid so it fires automatically when Job Code is entered
```

**Tests for Step 2.1:**
- [ ] Enter a Job Code on a new row → ID# auto-generates in correct format (`AB-260402143022-1`)
- [ ] Enter Job Code on a row that already has an ID# → ID# is not overwritten
- [ ] Bulk paste 5 rows with Job Codes → each gets a unique ID# (row index makes them unique)
- [ ] Leave Job Code empty → no ID# generated
- [ ] ID# field cannot be manually edited

---

### Step 2.2 — Price Versioning (`js/pricing.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 2, Step 2.
Build js/pricing.js — price version lookup and Task Date logic.
It must:
- Read price versions from the Config tab (via js/sheets.js)
- Determine the active version based on Task Date — NOT entry date
- No Task Date → use current active version
- Task Date entered → look up version valid on that date
- Show warning when version changes on date entry
- Auto-calculate New Total Price = New Price × Actual Quantity
- Auto-calculate LMP Portion and Contractor Portion based on contractor split % at Task Date
- In-House contractor always = 100% LMP, 0% Contractor
- Show visual indicator on every row: 🔵 no date, ✅ date set, ⚠️ version mismatch
```

**Tests for Step 2.2:**
- [ ] Row with no Task Date → uses current active price version, shows 🔵 indicator
- [ ] Enter a Task Date in a past price period → price version switches, shows ✅ indicator
- [ ] Warning appears when price version changes on date entry
- [ ] New Total Price auto-calculates correctly (New Price × Actual Quantity)
- [ ] Change Actual Quantity → New Total Price updates instantly
- [ ] LMP Portion and Contractor Portion calculate correctly for a non-In-House contractor
- [ ] In-House contractor → LMP = 100%, Contractor = 0% always
- [ ] Historical rows keep their price version when Task Date is already set

---

### Step 2.3 — Row Locking (`js/grid.js` update)

**Prompt:**
```
Read CLAUDE.md. Stage 2, Step 3.
Update js/grid.js to add row locking logic.
Rules (from CLAUDE.md):
- Acceptance Status filled → row is permanently read-only for coordinators
- Acceptance Status column is not editable by coordinators at all — ever
- Locked rows shown with subtle grey tint and 🔒 icon
- Coordinator clicks a locked row → show message: "This record is locked because
  acceptance is in progress. Contact the invoicing team for changes."
- Manager is never locked out — can edit any row regardless of lock status
- Invoicing can fill Acceptance Status on any row
- Lock is permanent — no unlock mechanism
```

**Tests for Step 2.3:**
- [ ] Login as Coordinator → Acceptance Status column is not editable, not even clickable
- [ ] Login as Invoicing → fill Acceptance Status on a row → row saves correctly
- [ ] Login as Coordinator → that row is now greyed out with 🔒 icon
- [ ] Coordinator clicks any cell on the locked row → lock message appears
- [ ] Coordinator can still sort, filter, and search locked rows
- [ ] Login as Manager → locked row is fully editable
- [ ] Login as Invoicing → locked row is fully editable
- [ ] Locking persists after page refresh

---

### Step 2.4 — JC Uniqueness Validation (`js/grid.js` update)

**Prompt:**
```
Read CLAUDE.md. Stage 2, Step 4.
Update js/grid.js to add JC uniqueness validation.
Rules (from CLAUDE.md):
- Fires on blur when user leaves the JC field
- Scan IndexedDB: if same JC exists on a different Logical Site ID → error
- On error: clear the field, highlight red, show inline message:
  "Job Code [JC] is already assigned to site [Logical Site ID]. A Job Code can only belong to one site."
- Also enforced server-side in Apps Script on save
- Applies to all roles
- During bulk paste: run check per row, flag any conflicting JC before committing
```

**Tests for Step 2.4:**
- [ ] Enter a JC that doesn't exist yet → accepted, no error
- [ ] Enter the same JC on a row with the same Logical Site ID → accepted (valid — same site)
- [ ] Enter the same JC on a row with a different Logical Site ID → field cleared, red highlight, error message
- [ ] Error message correctly names the conflicting site
- [ ] Paste 5 rows where one has a conflicting JC → that row is flagged, others commit normally
- [ ] Try to save a row with a conflicting JC via direct API call → Apps Script rejects it

### ✅ Stage 2 Complete — Full check before moving on:
- [ ] ID# generates correctly in all scenarios
- [ ] Price versioning resolves correctly for past, present, and future dates
- [ ] Row locking works correctly for all three roles
- [ ] JC uniqueness catches all conflict scenarios
- [ ] All auto-calculated fields (New Total Price, LMP, Contractor Portion) are correct
- [ ] No manual entry possible on auto-calculated fields

---

## Stage 3 — Offline & Sync

**Goal:** App works offline, syncs on reconnect, manager sees who is online, conflicts are handled.

---

### Step 3.1 — IndexedDB & Sync Queue (`js/offline.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 3, Step 1.
Build js/offline.js — IndexedDB management and sync queue.
It must:
- Store all rows in IndexedDB on first load
- Queue any saves made while offline
- On reconnect: process the queue silently in the background
- Show "● X changes pending sync" indicator while offline or syncing
- Show "✓ All synced" briefly when queue is empty
- Never block the user — all sync happens in the background
```

**Tests for Step 3.1:**
- [ ] First load: all rows stored in IndexedDB
- [ ] Disconnect internet → app continues working normally
- [ ] Edit and save rows while offline → changes saved to IndexedDB, pending indicator shows
- [ ] Reconnect → changes sync to Google Sheet automatically
- [ ] Synced rows appear correctly in Google Sheet after reconnect
- [ ] "✓ All synced" confirmation appears briefly after sync completes
- [ ] Offline edits survive a page refresh (still in IndexedDB)

---

### Step 3.2 — Delta Sync (`js/sheets.js` update)

**Prompt:**
```
Read CLAUDE.md. Stage 3, Step 2.
Update js/sheets.js to replace the full fetch with delta sync.
Rules (from CLAUDE.md):
- First ever load: fetch all rows once, store in IndexedDB, save sync timestamp
- Every subsequent open: fetch only rows where last_modified > last sync timestamp
- Background sync during use: same delta logic
- Bulk operations: send rows to Apps Script in batches of 50, show progress:
  "Syncing 50 of 200 rows..."
- Never fetch all rows again after the first load
Also update appscript/Code.gs to support filtering by last_modified timestamp.
```

**Tests for Step 3.2:**
- [ ] First load: all rows fetched, timestamp saved
- [ ] Close and reopen app: only changed rows fetched (check network tab — payload is small)
- [ ] Edit a row on another device → delta sync picks it up on next open
- [ ] Bulk save 100 rows → progress indicator shows batch progress
- [ ] App with 0 changes since last open → sync completes in under 1 second

---

### Step 3.3 — Presence Heartbeat (`js/sheets.js` update)

**Prompt:**
```
Read CLAUDE.md. Stage 3, Step 3.
Update js/sheets.js to add presence heartbeat.
It must:
- Write name + timestamp to the Presence tab every 30 seconds silently
- Read the Presence tab every 30 seconds to show who is online
- Show avatar bubbles floating top-right — visible to all roles
- Avatar disappears automatically if heartbeat stops for 60+ seconds
- Zero user action required — entirely automatic
Also update appscript/Code.gs to handle Presence tab reads and writes.
```

**Tests for Step 3.3:**
- [ ] Log in on two browsers → both see each other's avatar within 30 seconds
- [ ] Close one browser → that avatar disappears within 60 seconds
- [ ] Lose internet on one browser → their avatar disappears within 60 seconds after reconnect fails
- [ ] All three roles see presence avatars
- [ ] Presence tab in Google Sheet never grows beyond ~10 rows

---

### Step 3.4 — Change Notifications (`js/sheets.js` update)

**Prompt:**
```
Read CLAUDE.md. Stage 3, Step 4.
Update js/sheets.js to add change notifications.
Rules (from CLAUDE.md):
- Coordinator saves a row → manager sees a subtle row highlight + coordinator avatar pulses
- Manager edits a coordinator's row → coordinator is NOT notified
- One-directional only: coordinator → manager
- Apps Script writes to Changes tab on every coordinator save: Who | Row ID | When
- Changes tab is auto-pruned — keep only last 24 hours of entries
Also update appscript/Code.gs to handle Changes tab writes and pruning.
```

**Tests for Step 3.4:**
- [ ] Coordinator saves a row → manager sees the row briefly highlighted within 30 seconds
- [ ] Coordinator avatar pulses in manager's presence bar when coordinator saves
- [ ] Manager edits a row → coordinator sees nothing, no notification
- [ ] Changes tab in Google Sheet has entries for coordinator saves only
- [ ] Changes tab is pruned — old entries removed automatically

---

### Step 3.5 — Conflict Resolution (`js/offline.js` update)

**Prompt:**
```
Read CLAUDE.md. Stage 3, Step 5.
Update js/offline.js to add Dropbox-style conflict resolution.
Rules (from CLAUDE.md):
- On sync: if a row was edited offline AND the same row was edited online → conflict
- Do NOT silently overwrite
- Save offline version as a conflict copy tagged ⚠️ CONFLICT in Google Sheets
- Online version stays untouched as the live row
- Manager sees "X conflicts need review" indicator
- Conflict panel (Manager only): side-by-side view per field, who saved each and when
- Manager clicks Keep This → other version discarded → conflict resolved
- Manager can also manually merge in the panel before resolving
Also update appscript/Code.gs to handle conflict copy writes.
```

**Tests for Step 3.5:**
- [ ] Edit Row 5 offline. While offline, edit Row 5 on another device and save it online. Reconnect → conflict detected
- [ ] Conflict copy appears in Google Sheet tagged ⚠️ CONFLICT
- [ ] Live row (online version) is untouched
- [ ] Manager sees conflict indicator in the UI
- [ ] Manager opens conflict panel → both versions shown side by side with timestamps
- [ ] Manager clicks Keep This on one version → other discarded, conflict resolved, indicator clears
- [ ] No conflict on rows that were only edited on one side

### ✅ Stage 3 Complete — Full check before moving on:
- [ ] App works fully offline — all features function without internet
- [ ] Sync queue processes correctly on reconnect
- [ ] Delta sync confirmed — check network tab, second load should transfer much less data than first
- [ ] Presence avatars appear and disappear correctly
- [ ] Manager receives coordinator change notifications
- [ ] Conflict scenario produces a conflict copy, not a silent overwrite
- [ ] Conflict panel resolves correctly

---

## Stage 4 — Invoicing Features

**Goal:** TSR reconciliation, exports, soft delete, filters, and global search all working.

---

### Step 4.1 — TSR Reconciliation (`js/reconcile.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 4, Step 1.
Build js/reconcile.js — the full TSR reconciliation workflow.
It must handle:
- Step 1: Export customer template (Invoicing selects rows by TSR Sub#, exports selective columns)
- Step 2: Upload customer feedback Excel file
- Step 3: Auto-comparison of Actual Quantity and New Price per row by ID#
  - Match → auto-set PO Status = Approved
  - Changed → highlight row ⚠️, show side-by-side, wait for review
  - Rejected → auto-set PO Status = REJ
- Step 4: Invoicing reviews changed rows, can Accept or Reject each
  - Accept → auto-update Actual Quantity + New Price + New Total Price, PO Status = Approved
  - Reject → PO Status = REJ, row stays highlighted until resolved
- Step 5: Log the reconciliation run (who, when, TSR Sub#, counts of approved/changed/rejected)
- Invoicing and Manager only — coordinators have no access to this feature
Apply the xlsx skill for the customer template export and file reading.
```

**Tests for Step 4.1:**
- [ ] Login as Coordinator → reconcile button not visible
- [ ] Login as Invoicing → reconcile button visible
- [ ] Export customer template → correct columns only, correct format
- [ ] Upload customer file with all matching rows → all auto-set to Approved
- [ ] Upload customer file with one changed row → that row highlighted, side-by-side shown
- [ ] Accept changed row → quantities and prices updated, PO Status = Approved
- [ ] Reject changed row → PO Status = REJ, highlighted until resolved
- [ ] Upload customer file with a rejected row → PO Status = REJ automatically
- [ ] ID# in customer file not found in tracking database → flagged clearly
- [ ] Reconciliation log entry created after every run
- [ ] Multiple TSR batches can be open simultaneously without confusion

---

### Step 4.2 — Export (`js/export.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 4, Step 2.
Build js/export.js — Excel export for all roles.
Rules:
- Coordinator: exports their own rows only, 26 coordinator columns only
- Invoicing: exports all rows (or filtered view), all 43 columns
- Manager: exports all rows (or filtered view), all 43 columns, can filter by coordinator name
- Standard .xlsx format
Apply the xlsx skill for all export formatting.
```

**Tests for Step 4.2:**
- [ ] Coordinator export → correct rows, exactly 26 columns, no invoicing columns
- [ ] Invoicing export → all rows, all 43 columns
- [ ] Manager export → all rows, all 43 columns
- [ ] Manager filters by Coordinator = Ahmed, exports → only Ahmed's rows in the file
- [ ] Apply a column filter then export → exported file reflects the filtered view
- [ ] Exported file opens correctly in Excel with correct formatting

---

### Step 4.3 — Soft Delete (`js/delete.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 4, Step 3.
Build js/delete.js — soft delete workflow.
Rules (from CLAUDE.md):
- Warning popup: "Are you sure you want to delete this record? This cannot be undone." [Cancel] [Delete]
- Deleted rows moved to Deleted tab with a hidden flag — never permanently removed
- Only Manager can view deleted records
- Only Manager can permanently hard-delete if truly needed
- Coordinator can delete their own rows only (if not locked)
- Invoicing cannot delete
- Also include the Clear All Data feature (Manager only, Danger Zone section):
  - Requires typing DELETE ALL DATA to confirm
  - Wipes Data tab, Deleted tab, IndexedDB, and local backup files
  - Config tab is preserved
  - App reloads fresh after completion
```

**Tests for Step 4.3:**
- [ ] Login as Coordinator → can delete own unlocked rows, delete button not shown on other rows
- [ ] Login as Coordinator → delete button not shown on locked rows
- [ ] Login as Invoicing → no delete button anywhere
- [ ] Delete a row → warning popup appears
- [ ] Cancel → nothing happens
- [ ] Confirm delete → row disappears from grid, appears in Deleted tab in Google Sheet
- [ ] Login as Manager → can see Deleted tab view
- [ ] Manager hard-delete → row gone from Deleted tab permanently
- [ ] Clear All Data: typing anything other than DELETE ALL DATA → button stays disabled
- [ ] Clear All Data: typing DELETE ALL DATA → button enables, confirm wipes everything
- [ ] After Clear All Data: Config tab still intact, app reloads to empty grid

---

### Step 4.4 — Filters & Global Search (`js/filters.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 4, Step 4.
Build js/filters.js — column filters and global search.
It must:
- Add Excel-style filter dropdown arrow to every column
- Support multi-column filtering simultaneously
- Date range filtering
- Price range filtering
- Text search within columns
- Manager can filter by Coordinator name — coordinators cannot
- Global search bar: single bar above the grid, live filtering as you type
- Global search works simultaneously with column filters
- Role-scoped: coordinator searches own rows + 26 columns only
- All filtering runs against local IndexedDB — instant response
```

**Tests for Step 4.4:**
- [ ] Click column filter arrow → dropdown appears with unique values
- [ ] Apply filter on one column → grid updates instantly
- [ ] Apply filters on two columns simultaneously → both apply correctly
- [ ] Clear all filters → grid returns to full view
- [ ] Date range filter → only rows within range shown
- [ ] Global search: type a site number → matching rows shown instantly
- [ ] Global search + column filter active at same time → both apply together
- [ ] Clear global search → column filter still active
- [ ] Login as Coordinator → no "Filter by Coordinator" option visible
- [ ] Login as Manager → "Filter by Coordinator" works correctly
- [ ] Search performance: type quickly → no lag even with 6,500+ rows (runs against IndexedDB)

### ✅ Stage 4 Complete — Full check before moving on:
- [ ] TSR reconciliation end-to-end with a real test file
- [ ] Exports produce correct files for all three roles
- [ ] Soft delete and restore work correctly
- [ ] Clear All Data wipes everything except Config
- [ ] Filters and global search work together correctly
- [ ] All invoicing features inaccessible to coordinators

---

## Stage 5 — Polish & Safety Net

**Goal:** Backup system, restore tool, professional UI, PWA installed correctly.

---

### Step 5.1 — Backup System (`js/backup.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 5, Step 1.
Build js/backup.js — the full backup system using File System Access API.
It must:
- On first launch: prompt user to pick a backup folder once — never ask again
- Per-save backup: silently write to backup_latest.json after every save
- Scheduled backup: auto-run at 8:00 AM and 3:00 PM daily
  - If app is closed at schedule time → run on next app open
  - Auto-named: backup_YYYY-MM-DD_HHhmm.json
- Manual backup: "Backup Now" button available to all roles
  - Shows "✓ Backup saved" for 2 seconds then disappears
- Rolling 14 files: oldest auto-deleted when 15th would be created
- Role-scoped backup contents:
  - Coordinator: their own rows only
  - Invoicing: all rows, all 43 columns
  - Manager: all rows, all 43 columns + deleted records
- JSON format only
- Document in setup.md: "Use Chrome or Edge — File System Access API not supported in Firefox or Safari"
```

**Tests for Step 5.1:**
- [ ] First launch: folder picker appears once
- [ ] Second launch: no folder picker, uses saved folder
- [ ] Save a row → `backup_latest.json` updated silently in background
- [ ] Manually trigger 8AM schedule → backup file created with correct name
- [ ] Create 15 scheduled backups → oldest file auto-deleted, only 14 remain
- [ ] Click "Backup Now" → completes under 1 second, confirmation appears and disappears
- [ ] Login as Coordinator, backup → JSON contains only their rows, 26 columns
- [ ] Login as Manager, backup → JSON contains all rows + deleted records

---

### Step 5.2 — Restore Tool (`tools/restore.html`)

**Prompt:**
```
Read CLAUDE.md. Stage 5, Step 2.
Build tools/restore.html — standalone backup restore tool.
It must:
- Work in any browser independently — no app, no server, no installation
- User drags in any JSON backup file → tool converts it to a full .xlsx Excel file → downloads instantly
- No dependencies on the main app
- Clean, simple UI — drag zone, status message, download button
Apply the xlsx skill for the Excel file generation.
Apply the frontend-design skill for the UI.
```

**Tests for Step 5.2:**
- [ ] Open `tools/restore.html` directly in Chrome — works with no server running
- [ ] Open in Firefox — works (this tool must work in all browsers unlike the main app)
- [ ] Drag in a coordinator backup JSON → downloads .xlsx with correct columns
- [ ] Drag in a manager backup JSON → downloads .xlsx with all 43 columns + deleted records sheet
- [ ] Drag in an invalid file → clear error message, no crash
- [ ] Downloaded Excel file opens correctly in Excel

---

### Step 5.3 — UI Polish (all CSS files)

**Prompt:**
```
Read CLAUDE.md. Stage 5, Step 3.
Polish all CSS files: css/main.css, css/grid.css, css/forms.css, css/filters.css.
Apply the frontend-design skill fully.
Design direction: clean, sharp, professional internal tool.
Ensure consistency across:
- Login screen and setup screen
- Grid toolbar, search bar, filter controls
- Modals, warnings, error messages, confirmation dialogs
- Role-based indicators: 🔒 locked rows, ⚠️ conflict rows, ● sync status, ✓ synced, presence avatars
- The "Backup Now" button and backup confirmation
- The reconciliation panel and conflict resolution panel
Never use: Inter, Roboto, Arial, system fonts, purple gradients, generic layouts.
```

**Visual check after Step 5.3:**
- [ ] Login screen looks professional, not generic
- [ ] Grid toolbar is clean and data-dense
- [ ] Locked rows are visibly different but not distracting
- [ ] Conflict rows are clearly highlighted amber
- [ ] Sync status indicator is subtle but readable
- [ ] Presence avatars are clean and non-intrusive
- [ ] All modals follow the same visual language
- [ ] App looks like a professional internal tool, not an AI prototype

---

### Step 5.4 — PWA (`manifest.json` + `service-worker.js`)

**Prompt:**
```
Read CLAUDE.md. Stage 5, Step 4.
Build manifest.json and service-worker.js.
manifest.json: app name, icons, theme color, display standalone, start URL.
service-worker.js:
- Cache all app files for offline use
- Check for updates silently on every app open
- When new version ready: show banner "A new update is available — click to refresh" [Update Now]
- User clicks → app reloads with new version
```

**Tests for Step 5.4:**
- [ ] Open app in Chrome → install prompt appears (or install via browser menu)
- [ ] Install as PWA → app opens in its own window, no browser chrome
- [ ] Go offline, open PWA → app loads from cache correctly
- [ ] Deploy a small change to GitHub Pages → update banner appears on next open
- [ ] Click Update Now → app reloads with new version

---

### Step 5.5 — Documentation (`docs/`)

**Prompt:**
```
Read CLAUDE.md. Stage 5, Step 5.
Write docs/setup.md and docs/structure.md.
setup.md must cover:
- How to create and configure the Google Sheet (tab names, Config tab structure)
- How to deploy Code.gs as a Web App in Google Apps Script
- How to connect the app to Apps Script on first launch
- How to add/remove team members in the Config tab
- Browser requirement: Chrome or Edge only (File System Access API)
- How to add price versions and contractor splits in Config tab
structure.md: full file map with one-line description of every file's job.
```

---

### ✅ Stage 5 Complete — Final checks before go-live:

**Functionality:**
- [ ] All five stages working end-to-end
- [ ] Test every role: Coordinator, Invoicing, Manager
- [ ] Test offline → reconnect → sync for each role
- [ ] Test conflict scenario end-to-end
- [ ] Test TSR reconciliation with a real file
- [ ] Test backup and restore end-to-end

**Security:**
- [ ] No Apps Script URL in the codebase — check every file
- [ ] No Sheet URL anywhere
- [ ] No access codes anywhere
- [ ] Coordinator cannot access invoicing columns — verify via network inspector (response payload check)
- [ ] Apps Script rejects direct calls without valid authentication

**Performance:**
- [ ] First load with 50 test rows: under 4 seconds
- [ ] Second load (delta sync): under 2 seconds
- [ ] Row save feels instant (saves to IndexedDB first)
- [ ] Global search with 50 rows: instant response

**Cross-browser:**
- [ ] Chrome: all features work including File System Access API
- [ ] Edge: all features work including File System Access API
- [ ] Firefox: main app works (backup folder picker will not work — expected and documented)

---

## Go Live

### Switch from test data to real data:
1. [ ] Login as Manager
2. [ ] Go to Danger Zone → Clear All Data → type `DELETE ALL DATA` → confirm
3. [ ] App reloads to empty grid
4. [ ] Click "Import from Excel" → upload `Coordinator_Tracking_Sheet.xlsm`
5. [ ] Preview screen appears → verify columns mapped correctly → confirm import
6. [ ] Wait for bulk upload to complete (progress indicator will show)
7. [ ] Verify row count matches original Excel
8. [ ] Login as each role and verify their view looks correct
9. [ ] You are live ✅

---

## Future — Add Acceptance Role (when ready)

When you decide what the Acceptance role is responsible for, the change touches:
- `Config` tab: add `Acceptance` as a role option (one cell)
- `js/auth.js`: add `acceptance` to the role list
- `js/grid.js`: add `'acceptance'` to `roles` and `editable` arrays for relevant columns
- `appscript/Code.gs`: add server-side permission rules for the new role
- Row locking logic: decide if Acceptance role locks itself out after filling Acceptance Status or retains edit access

Return to Claude with this build guide and CLAUDE.md and request it as a focused code session.

---

*Keep this file open while building. Check off every item as you go.*
*If something fails a test, fix it before moving to the next step.*
*Never skip the end-of-stage full checks — they catch cross-file issues early.*
