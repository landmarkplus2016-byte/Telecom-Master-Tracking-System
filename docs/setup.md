# Setup Guide — Telecom Coordinator Tracking App

---

## Browser Requirement

**Use Google Chrome or Microsoft Edge.**

The automatic backup feature uses the **File System Access API**, which is only supported in Chrome and Edge. Everything else in the app works in any browser, but without backup support.

- Google Chrome 86 or later ✓
- Microsoft Edge 86 or later ✓
- Firefox ✗ — no backup button will appear
- Safari ✗ — no backup button will appear

---

## Step 1 — Create the Google Sheet

Create a new Google Sheet (or open the existing one). The sheet needs the following tabs in any order:

| Tab name    | Purpose |
|-------------|---------|
| `Data`      | All tracking records — the main working sheet |
| `Config`    | Team members, price versions, dropdowns, splits |
| `Deleted`   | Soft-deleted records (Manager view only) |
| `Presence`  | Online presence — auto-managed, always ≤ 10 rows |
| `Changes`   | Change log — auto-managed, auto-pruned |
| `Conflicts` | Offline conflict copies — auto-managed |

Tab names are case-sensitive. Create them exactly as shown above.

The `Data` tab header row is written automatically on first use. **Do not manually add a header row to `Data`.**

---

## Step 2 — Configure the Config Tab

The Config tab drives everything the app shows: team members, price versions, dropdown lists, and contractor splits. All sections can be placed anywhere in the tab — the app reads them by marker, not by position.

---

### Section 1 — Team Members

Add the `[TEAM_MEMBERS]` marker in any cell in column A, followed immediately by a header row and data rows. Leave column A blank in the row after the last member to end the section.

```
[TEAM_MEMBERS]
Name          | Code      | Role
Alice Smith   | alice2024 | Coordinator
Bob Jones     | bob9912   | Invoicing
Carol Mgr     | carol001  | Manager
              |           |            ← blank column A cell ends the section
```

**Column rules:**
- **Name** — full name, displayed in the app and used to filter rows
- **Code** — personal access code, case-sensitive, never shared between members
- **Role** — must be exactly `Coordinator`, `Invoicing`, or `Manager` (not case-sensitive)

**Role capabilities:**

| Role        | Rows visible      | Editable columns        | Can delete |
|-------------|-------------------|-------------------------|------------|
| Coordinator | Own rows only     | Coordinator columns     | Own rows (if unlocked) |
| Invoicing   | All rows          | All 43 columns          | No |
| Manager     | All rows + Deleted | All 43 columns         | All rows |

**To add a team member:** Insert a new row inside the section (before the blank row). The person can log in immediately — no redeploy needed.

**To remove a team member:** Delete their row from the section. Their rows remain in the sheet, now invisible to them; a Manager can reassign the rows to another coordinator.

**To change a role:** Edit the Role cell. Takes effect on next login.

---

### Section 2 — Price Versions

Place a section titled `3-Price Versions` (the number prefix is required — it tells the parser this is the price section). The section contains two separate tables, placed side by side or below each other.

**Table A — Version definitions** (header row starts with "Version"):

```
3-Price Versions
Version | Effective Date
2025    | 01/04/2025
2026    | 01/04/2026
```

- **Version** — short label used in the UI (e.g. `2025`, `2026`)
- **Effective Date** — the date this version became active (April 1 each year by policy)
- A version with no effective date is ignored until the date is filled in

**Table B — Price list** (header row starts with "Line Item"):

```
Line Item              | 2025 Price | 2026 Price
RF01 - Task A          | 28750      |
RF02 - Task B          | 14500      | 15200
TX01 - Transmission A  | 10250      | 11000
```

- Column headers must match version labels exactly: `2025 Price`, `2026 Price`, etc.
- Leave the price blank for a version that does not yet have a rate for that line item
- The system automatically picks the correct version based on each row's Task Date
- Rows with no Task Date always use the most recent active version

**To add a new price version:**
1. Add a new row to Table A with the version label and effective date
2. Add a new column to Table B with header `YYYY Price` and fill in the rates
3. No redeploy needed — prices reload on next app open or config refresh

**Backdated versions:** If you add a version retroactively, the app will flag all unlocked rows in that version's date range with a ⚠️ warning for review. Locked rows (Acceptance Status filled) are never changed.

---

### Section 3 — Contractor Splits

Controls how New Total Price is split into LMP Portion and Contractor Portion.

```
[CONTRACTOR_SPLITS]
Contractor  | LMP_Pct | Contractor_Pct
In-House    | 100     | 0
Vendor A    | 70      | 30
Vendor B    | 60      | 40
```

- **Contractor** — must match the contractor name used in rows exactly
- **LMP_Pct** — percentage that goes to LMP (0–100)
- **Contractor_Pct** — percentage that goes to contractor (must sum to 100 with LMP_Pct)
- `In-House` is special: always 100% LMP, 0% Contractor, regardless of percentages

Values can be entered as whole numbers (70) or as Google Sheets percentages (70%). Both work.

---

### Section 4 — Distance Multipliers (optional)

If your pricing uses a distance multiplier on the New Total Price:

```
[DISTANCE_MULTIPLIERS]
Distance       | Multiplier
0Km - 100Km    | 1
101Km - 400Km  | 1.15
401Km - 800Km  | 1.20
> 800Km        | 1.25
```

Leave this section out entirely if distance multipliers are not used.

---

### Section 5 — Dropdown Lists

Controls what appears in the dropdown columns in the grid (TX/RF, Vendor, Region, etc.).

The header row uses the display labels of each field. Values go below, one per cell, as many rows as needed. Leave a cell blank to end a particular dropdown's list.

```
2-Dropdown Lists
TX/RF  | Vendor    | Region  | Sub Region | Site Option | Facing | General Stream | Status | Contractor
TX     | Nokia     | Alpha   | North      | Option A    | North  | Stream 1       | Active | In-House
RF     | Ericsson  | Beta    | South      | Option B    | South  | Stream 2       | On Hold| Vendor A
       | Huawei    | Delta   |            |             | East   |                |        | Vendor B
       |           | Gamma   |            |             | West   |                |        |
```

The section marker can also be written as `[DROPDOWNS]`. Column headers are matched to grid fields by converting to lowercase and replacing spaces with underscores (e.g. `TX/RF` → `tx_rf`).

---

## Step 3 — Deploy Code.gs as a Web App

1. In your Google Sheet, go to **Extensions → Apps Script**.
2. Delete any existing code in the editor.
3. Paste the full contents of `appscript/Code.gs` into the editor.
4. Click **Save** (floppy disk icon or Ctrl+S).
5. Click **Deploy → New deployment**.
6. Click the gear icon next to "Select type" and choose **Web app**.
7. Set the following:
   - **Description:** Telecom Tracker API (or any label)
   - **Execute as:** Me
   - **Who has access:** Anyone
8. Click **Deploy**.
9. If prompted, click **Authorize access** and complete the OAuth consent screen.
10. Copy the **Web App URL** — it looks like:
    `https://script.google.com/macros/s/AKfycb.../exec`

**Keep this URL private.** Anyone who has it can read and write your tracking data. Do not commit it to the codebase or share it in chat.

### Redeploying after code changes

After editing `Code.gs`, you must create a new deployment to publish the changes:

1. Go to **Deploy → Manage deployments**.
2. Click the pencil (Edit) icon on your existing deployment.
3. Change **Version** from the current version to **New version**.
4. Click **Deploy**.

The URL does not change. Users do not need to paste a new URL.

---

## Step 4 — Connect the App on First Launch

1. Open `index.html` in Chrome or Edge.
2. On the **first-launch setup screen**, paste the Web App URL you copied above.
3. Click **Connect**. The app will verify the URL by calling the `ping` action.
4. If successful, you are taken to the login screen.

The URL is stored in your browser's `localStorage` only. It is never written to the codebase or any file.

**If the connection screen appears again** (e.g. after clearing browser data), paste the URL again. The URL itself never changes after deployment.

**Cold start:** The first request after Apps Script has been idle may take 5–8 seconds. A "Waking up…" indicator appears during this time. This is normal — subsequent requests are fast.

---

## Step 5 — Log In

1. Select your name from the dropdown.
2. Enter your personal access code (from the Config tab).
3. Click **Sign In**.

The session is stored in `sessionStorage` and cleared when the tab is closed. Reloading the same tab keeps you logged in.

---

## Step 6 — Backup Folder Setup (Chrome / Edge only)

On your first **Backup Now** click, the browser asks you to choose a local folder. Pick or create a folder (e.g. `Telecom Backups` on your desktop or a shared drive).

- The folder choice is remembered across sessions in IndexedDB.
- All backup files are written to this folder automatically.
- If you clear browser data or switch browsers, you will be asked to choose again.

### Backup schedule

| Type        | Filename pattern                    | When it runs |
|-------------|-------------------------------------|--------------|
| Per-save    | `backup_latest.json`                | After every row save (overwrites) |
| Scheduled AM | `backup_YYYY-MM-DD_08h00.json`     | 8:00 AM daily |
| Scheduled PM | `backup_YYYY-MM-DD_15h00.json`     | 3:00 PM daily |
| Manual      | `backup_YYYY-MM-DD_HHhmm.json`      | "Backup Now" button |

**Missed schedules:** If the app was closed at the scheduled time, the backup runs automatically the next time the app is opened.

**Rolling limit:** Only the 14 most recent named backups are kept. The oldest is deleted when a 15th would be created. `backup_latest.json` is never counted toward this limit.

### Restoring from a backup

Use `tools/restore.html` to convert any JSON backup file back to an Excel spreadsheet. Open it directly in any browser — no server needed.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Backup Now" button missing | Firefox or Safari | Switch to Chrome or Edge |
| App takes 5–8 s on first load | Apps Script cold start | Normal — wait for it |
| "Invalid name or access code" | Typo or wrong code | Check the Config tab |
| Rows missing for a coordinator | `coordinator_name` value mismatch | Manager checks and edits the Coordinator column |
| Conflicts indicator showing | Offline edit collided with an online edit | Manager opens the conflict panel to resolve |
| Config changes not appearing | Old cached config | Click Refresh button or reload the app |
| Dropdown column empty | Field name mismatch in Config | Check that header in Dropdown section matches the grid column label |
| Price not updating on Task Date change | Locked row | Locked rows never change price — contact Invoicing |
