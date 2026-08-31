/**
 * Roundhouse — central Blocked Submissions log.
 *
 * ONE script and ONE sheet for EVERY client site. This is deliberately not a tab in
 * a client's own leads sheet: clients should never see spam noise, and a single
 * shared log is the only way a false-positive pattern across the portfolio becomes
 * visible ("every site is dropping leads on keyword:coldOutreach").
 *
 * Every contact route posts here whenever a spam layer withholds a submission.
 * Because each layer returns a deliberate fake success, this log is the ONLY record
 * that the submission ever happened.
 *
 * ── What to look for ────────────────────────────────────────────
 * • Rows with a "keyword:" or "content" Layer that read like a real customer are
 *   FALSE POSITIVES. That lead was lost — call them, then fix the rule.
 * • Rows with a blank Source AND a blank Origin AND a blank Referer are scripts
 *   POSTing /api/contact directly. That is the fingerprint of the 2026-08-09/10
 *   Alpha Omega run, and it means the filters are doing their job.
 * • A sudden drop in rows for one site can mean its route stopped logging — check
 *   that BLOCKED_LOG_WEBHOOK is still set on that Vercel project.
 *
 * ── Deploy ──────────────────────────────────────────────────────
 * The sheet exists and its ID is already filled in below — nothing to edit.
 *
 * 1. Open the sheet:
 *    https://docs.google.com/spreadsheets/d/1LIcJM6u41o_z3OwH2hEZQ6-9naCtcoImtXokjUoOu0g/edit
 * 2. Extensions -> Apps Script. Paste this over everything in Code.gs.
 * 3. Save (Cmd+S) FIRST — a deployment snapshots SAVED code, so deploying before
 *    saving ships nothing and the tab never appears.
 * 4. Deploy -> New deployment. Click the gear next to "Select type" -> Web app.
 *      Execute as:     Me
 *      Who has access: Anyone
 *    Authorise when prompted (it will warn the app is unverified — that is normal
 *    for your own Apps Script; choose Advanced -> Go to the project).
 *    Copy the /exec URL.
 * 5. Set that URL as BLOCKED_LOG_WEBHOOK on the Vercel projects. A Team-level
 *    Shared Environment Variable covers all of them at once.
 * 6. Check: opening the /exec URL in a browser returns
 *    {"ok":true,"status":"listening",...} — and the "Blocked" tab, with its
 *    header row, is created automatically the first time it is called.
 *
 * ── Redeploy after editing ──────────────────────────────────────
 * Save, then Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy.
 * That keeps the same /exec URL. "New deployment" mints a NEW url and every
 * project's BLOCKED_LOG_WEBHOOK would have to change to match.
 */

// Bump whenever this script changes. The health check reports it, so you can tell
// which version is actually deployed rather than assuming the last paste went live.
var VERSION = 'v2-locked-header';

// The Blocked Submissions sheet, already created:
// https://docs.google.com/spreadsheets/d/1LIcJM6u41o_z3OwH2hEZQ6-9naCtcoImtXokjUoOu0g/edit
var SHEET_ID = '1LIcJM6u41o_z3OwH2hEZQ6-9naCtcoImtXokjUoOu0g';

var TAB_NAME = 'Blocked';
var TIMEZONE = 'America/Chicago';

// "Reviewed" is written by a human, never by this script — it is the column for
// marking that a false positive has been chased up.
var HEADERS = [
  'Timestamp', 'Site', 'Layer', 'Matched', 'Name', 'Phone', 'Email',
  'Message', 'Source', 'Origin', 'Referer', 'User Agent', 'IP', 'Reviewed'
];

/**
 * Returns the Blocked tab, creating it and its header row on first use.
 *
 * Guarded by a lock and by the CONTENT of row 1 rather than by getLastRow() === 0.
 * v1 checked only getLastRow(), and doGet created the tab too — so two calls that
 * arrived together (or a health check racing a submission) both saw an empty sheet
 * and both appended the header. That produced a duplicate header row, which also
 * inflated the doGet totals, since totalBlocked is derived from the row count.
 */
function getTab_(ss, createIfMissing) {
  var sheet = ss.getSheetByName(TAB_NAME);
  if (!sheet) {
    if (!createIfMissing) return null;
    sheet = ss.insertSheet(TAB_NAME);
  }
  if (!createIfMissing) return sheet;

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    // Another execution holds it and is doing the same setup — carry on.
    return sheet;
  }
  try {
    if (!hasHeader_(sheet)) {
      sheet.insertRowBefore(1);
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
      sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#f1f3f4');
      sheet.setFrozenRows(1);
    }
    removeStrayHeaderRows_(sheet);
  } finally {
    lock.releaseLock();
  }
  return sheet;
}

/** True when row 1 already holds the header, whatever else is in the sheet. */
function hasHeader_(sheet) {
  if (sheet.getLastRow() < 1) return false;
  var row = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  return String(row[0]).trim() === HEADERS[0] && String(row[1]).trim() === HEADERS[1];
}

/**
 * Deletes any DATA row that is really a duplicate header. v1's race left one of
 * these behind; without this it would sit in the log for ever and be counted as a
 * blocked submission. Only removes rows that match the header exactly.
 */
function removeStrayHeaderRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return;
  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    var isHeader = true;
    for (var c = 0; c < HEADERS.length; c++) {
      if (String(values[i][c]).trim() !== HEADERS[c]) { isHeader = false; break; }
    }
    if (isHeader) sheet.deleteRow(i + 2);
  }
}

function doPost(e) {
  try {
    var p = {};
    if (e && e.postData && e.postData.contents) {
      p = JSON.parse(e.postData.contents);
    } else if (e && e.parameter) {
      p = e.parameter;
    }

    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = getTab_(ss, true);

    // The route sends an ISO timestamp; re-render it in local time so the sheet is
    // readable, and fall back to now if it is missing or unparseable.
    var when;
    try {
      when = p.timestamp ? new Date(p.timestamp) : new Date();
      if (isNaN(when.getTime())) when = new Date();
    } catch (err) {
      when = new Date();
    }
    var stamp = Utilities.formatDate(when, TIMEZONE, 'yyyy-MM-dd HH:mm:ss');

    sheet.appendRow([
      stamp,
      p.site || '',
      p.layer || '',
      p.matched || '',
      p.name || '',
      p.phone || '',
      p.email || '',
      p.message || '',
      p.source || '',
      p.origin || '',
      p.referer || '',
      p.userAgent || '',
      p.ip || '',
      ''   // Reviewed — left for a human
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, version: VERSION }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, version: VERSION, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Health check AND a quick summary — open the /exec URL in a browser to confirm
 * what is deployed and see how many blocks each rule has produced.
 */
function doGet() {
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sheet = getTab_(ss, false);   // read-only: never create from a health check
    var lastRow = sheet ? sheet.getLastRow() : 0;
    var byLayer = {};
    var bySite = {};

    if (sheet && lastRow > 1) {
      var rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();  // Timestamp, Site, Layer
      for (var i = 0; i < rows.length; i++) {
        var site = rows[i][1] || '(unknown)';
        var layer = rows[i][2] || '(unknown)';
        bySite[site] = (bySite[site] || 0) + 1;
        byLayer[layer] = (byLayer[layer] || 0) + 1;
      }
    }

    return ContentService
      .createTextOutput(JSON.stringify({
        ok: true,
        status: 'listening',
        version: VERSION,
        tabExists: !!sheet,
        totalBlocked: Math.max(lastRow - 1, 0),
        byLayer: byLayer,
        bySite: bySite
      }, null, 2))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, version: VERSION, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
