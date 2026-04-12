# Setup Guide — Telecom Coordinator Tracking App

## Browser Requirements

**Use Chrome or Edge.**

The local backup feature (File System Access API) is **not supported in Firefox or Safari**.
If you open the app in Firefox or Safari, everything works except automatic backups — the
"Backup Now" button will not appear and no backup files will be written.

Recommended browsers:
- Google Chrome 86+
- Microsoft Edge 86+

---

## Step 1 — Deploy the Apps Script

1. Open the Google Sheet that will serve as the database.
2. Go to **Extensions → Apps Script**.
3. Paste the full contents of `appscript/Code.gs` into the editor.
4. Click **Deploy → New deployment**.
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Click **Deploy** and copy the Web App URL.

Keep this URL private — anyone with it can read and write your tracking data.

---

## Step 2 — Configure the Config Tab

The Config tab in your Google Sheet drives all dropdowns, team members, and pricing.

### Team Members section

Add a `[TEAM_MEMBERS]` marker in column A, followed by a header row and data rows:

```
[TEAM_MEMBERS]
Name         | Code      | Role
Alice        | abc123    | Coordinator
Bob          | def456    | Invoicing
Carol        | ghi789    | Manager
```

- **Name** — displayed in the app and used to own rows
- **Code** — personal access code, never shared
- **Role** — must be exactly `Coordinator`, `Invoicing`, or `Manager`

Each person must have their own unique access code. Do not share codes between team members.

---

## Step 3 — First App Launch

1. Open `index.html` in Chrome or Edge.
2. Paste the Apps Script Web App URL when prompted (stored in your browser only — never in the code).
3. Log in with your name and personal code.

### Backup folder setup

On your first "Backup Now" click, the browser will ask you to choose a local folder.
Select or create a folder (e.g. `Telecom Backups` on your desktop or a shared drive).

- This is a one-time choice — the folder is remembered across sessions.
- All backup files are written to this folder automatically.
- If you switch browsers or clear browser data, you will be asked to choose again.

---

## Step 4 — Backup System Overview

| Backup type | Filename | Trigger |
|---|---|---|
| Per-save | `backup_latest.json` | After every row save (overwrites) |
| Scheduled AM | `backup_YYYY-MM-DD_08h00.json` | 8:00 AM daily |
| Scheduled PM | `backup_YYYY-MM-DD_15h00.json` | 3:00 PM daily |
| Manual | `backup_YYYY-MM-DD_HHhmm.json` | "Backup Now" button |

**Missed schedules:** If the app is closed at 8:00 AM or 3:00 PM, the backup runs
automatically the next time the app is opened.

**Rolling limit:** Only the 14 most recent named backups are kept. The oldest is
deleted automatically when the 15th would be created. `backup_latest.json` is
never counted toward this limit.

**Role-scoped contents:**
- Coordinator — own rows only
- Invoicing — all rows, all columns
- Manager — all rows, all columns + deleted records

---

## Step 5 — Restore from Backup

Use `tools/restore.html` to convert a JSON backup file back to Excel format.
Open the file directly in any browser (no server required).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "Backup Now" button missing | Firefox or Safari | Switch to Chrome or Edge |
| App takes 5–8 s on first load | Apps Script cold start | Normal — wait for it |
| "Invalid name or access code" | Typo or wrong code | Check the Config tab |
| Rows not appearing for coordinator | `coordinator_name` column mismatch | Manager checks the Coordinator column value |
| Conflicts indicator showing | Offline edit collided with online edit | Manager opens the conflict panel to resolve |
