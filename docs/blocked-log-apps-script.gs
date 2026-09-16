/**
 * Roundhouse — central Blocked Submissions log AND the alerting for it.
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
 * ── Why the alerting lives HERE (2026-09-08) ────────────────────
 * The routes used to email Roundhouse via Resend on every content/keyword block.
 * On 2026-09-08 a sqlmap scanner hit Indiana Flow's /api/contact 66 times in 19
 * minutes; all 66 were blocked correctly, and all 66 sent an alert, which put the
 * Resend account over its limit. Blocked-alerts and real customer lead emails
 * shared one Resend account, so anyone with a shell script could take out lead
 * delivery for every client at once.
 *
 * Alerting therefore moved into this script. It sends on Google Workspace's own
 * quota — nothing to do with Resend — and, unlike a serverless route, it can see
 * the whole log, so it can rate-limit itself. Two tiers:
 *
 *   IMMEDIATE  Only rows flagged Urgent: a block that still has a real name, a
 *              dialable phone and an actual message, i.e. a lead worth rescuing
 *              TODAY. Capped at MAX_IMMEDIATE_PER_SITE_PER_DAY per site.
 *   DIGEST     One email a morning covering everything else. Run by a time-driven
 *              trigger — install it once with setupTriggers().
 *
 * ── What to look for ────────────────────────────────────────────
 * • Rows with a "keyword:" or "content:" Layer that read like a real customer are
 *   FALSE POSITIVES. That lead was lost — call them, then fix the rule.
 * • Rows with a blank Source AND a blank Origin AND a blank Referer are scripts
 *   POSTing /api/contact directly. That is the fingerprint of the 2026-08-09/10
 *   Alpha Omega run, and it means the filters are doing their job.
 * • A sudden drop in rows for one site can mean its route stopped logging — check
 *   that BLOCKED_LOG_WEBHOOK is still set on that Vercel project.
 * • Layer "delivered-no-js" is NOT a block. The visitor's JavaScript never ran, so
 *   the form posted with an empty _ts. The lead WAS delivered, flagged for review.
 *   These rows only exist to show how many submissions arrive without JS.
 *
 * ── Spike alerts (v7) ───────────────────────────────────────────
 * One email the moment one delivery-related rule (SPIKE_LAYERS) reaches SPIKE_THRESHOLD
 * rows on one site in a day (SHEET_FAILED_SPIKE_THRESHOLD for delivered-sheet-failed).
 * Bot floods never trigger it. A config mistake — a
 * domain missing from allowedOrigins, a broken client Apps Script, a rule suddenly
 * catching real customers — produces many rows of one kind, and used to show up only
 * as a count in the next morning's digest. Sent once per site + rule per day.
 *
 * ── Resend bounce alerts (v7) ───────────────────────────────────
 * Resend accepting a lead email doesn't mean the client received it: a mistyped
 * recipient, a full mailbox or a server rejecting our domain bounces minutes later.
 * Point a Resend webhook at this script's /exec URL for email.bounced and
 * email.complained. Each one becomes an urgent row + immediate email with the lead's
 * subject, so it can be forwarded and the address fixed. Repeat deliveries of the
 * same event are ignored.
 *
 * ── Deploy ──────────────────────────────────────────────────────
 * The sheet exists and its ID is already filled in below — nothing to edit.
 *
 * 1. Open the sheet:
 *    https://docs.google.com/spreadsheets/d/1LIcJM6u41o_z3OwH2hEZQ6-9naCtcoImtXokjUoOu0g/edit
 * 2. Extensions -> Apps Script. Paste this over everything in Code.gs.
 * 3. Save (Cmd+S) FIRST — a deployment snapshots SAVED code, so deploying before
 *    saving ships nothing.
 * 4. Run setupTriggers() ONCE from the editor (pick it in the function dropdown,
 *    press Run). Authorise when prompted — this is what grants the script
 *    permission to send mail, and it installs the 7am digest trigger.
 * 5. Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy.
 *    That keeps the same /exec URL, so no Vercel env var has to change.
 *    (First time only: Deploy -> New deployment -> Web app, Execute as Me,
 *    Who has access Anyone, then set the /exec URL as BLOCKED_LOG_WEBHOOK.)
 * 6. Check: opening the /exec URL in a browser returns
 *    {"ok":true,"status":"listening",...} with the current VERSION below.
 *    sendDailyDigest() can be run by hand any time to see the digest immediately.
 *
 * ── Redeploy after editing ──────────────────────────────────────
 * Save, then Deploy -> Manage deployments -> pencil -> Version: New version -> Deploy.
 * "New deployment" mints a NEW url and every project's BLOCKED_LOG_WEBHOOK would
 * have to change to match.
 */

// Bump whenever this script changes. The health check reports it, so you can tell
// which version is actually deployed rather than assuming the last paste went live.
var VERSION = 'v7-spikes-bounces';

// The Blocked Submissions sheet, already created:
// https://docs.google.com/spreadsheets/d/1LIcJM6u41o_z3OwH2hEZQ6-9naCtcoImtXokjUoOu0g/edit
var SHEET_ID = '1LIcJM6u41o_z3OwH2hEZQ6-9naCtcoImtXokjUoOu0g';

var TAB_NAME = 'Blocked';
var TIMEZONE = 'America/Chicago';

// Where alerts go. Override with a Script Property named ALERT_TO if it ever moves.
var DEFAULT_ALERT_TO = 'support@getroundhouse.com';

/**
 * Ceiling on immediate emails per site per day. Beyond this the rows are still
 * logged and still appear in the digest — only the interruption stops. This is the
 * backstop that a serverless route could never implement, because it cannot count
 * what other invocations have already sent.
 */
var MAX_IMMEDIATE_PER_SITE_PER_DAY = 3;

/** Rows of one rule on one site in one day that trigger a spike alert. */
var SPIKE_THRESHOLD = 10;
/** A client sheet failing is serious sooner — every lead is missing from their sheet. */
var SHEET_FAILED_SPIKE_THRESHOLD = 3;
/**
 * Only rows about leads that reached — or failed to reach — a client. A flood of bot
 * blocks (the 2026-09-08 sqlmap run) is the filter working and must stay silent; a
 * misconfiguration shows up here instead (a domain missing from allowedOrigins is
 * delivered-flagged, a broken client sheet is delivered-sheet-failed).
 */
var SPIKE_LAYERS = {
  'delivered-flagged': true, 'delivered-sheet-failed': true,
  'delivered-email-failed': true, 'delivery-failed': true
};

/** Hour (local) the digest is sent. */
var DIGEST_HOUR = 7;

/** Never scan the entire sheet — recent history is all any of this needs. */
var MAX_SCAN_ROWS = 2000;

// "Reviewed" is written by a human, never by this script — it is the column for
// marking that a false positive has been chased up.
var HEADERS = [
  'Timestamp', 'Site', 'Layer', 'Matched', 'Name', 'Phone', 'Email',
  'Message', 'Source', 'Origin', 'Referer', 'User Agent', 'IP', 'Reviewed', 'Urgent',
  // v5 (2026-09-16): "Yes" when the lead WAS delivered to the client and the row is here
  // only for visibility (delivered-no-js, delivered-honeypot-autofill). Five of ten
  // "good leads marked as spam" reported that day had in fact reached the client.
  'Delivered'
];

var COL = { TIMESTAMP: 0, SITE: 1, LAYER: 2, MATCHED: 3, NAME: 4, PHONE: 5, EMAIL: 6,
            MESSAGE: 7, SOURCE: 8, ORIGIN: 9, REFERER: 10, UA: 11, IP: 12,
            REVIEWED: 13, URGENT: 14, DELIVERED: 15 };

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
      writeHeader_(sheet);
    } else if (!headerIsCurrent_(sheet)) {
      // v3 had 14 columns; v4 adds "Urgent". Rewriting row 1 is safe and leaves
      // every existing data row untouched, just blank in the new column.
      writeHeader_(sheet);
    }
    removeStrayHeaderRows_(sheet);
  } finally {
    lock.releaseLock();
  }
  return sheet;
}

function writeHeader_(sheet) {
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
       .setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);
}

/** True when row 1 already holds the header, whatever else is in the sheet. */
function hasHeader_(sheet) {
  if (sheet.getLastRow() < 1) return false;
  var row = sheet.getRange(1, 1, 1, 2).getValues()[0];
  return String(row[0]).trim() === HEADERS[0] && String(row[1]).trim() === HEADERS[1];
}

/** True when row 1 matches the CURRENT header, including columns added since v3. */
function headerIsCurrent_(sheet) {
  var row = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  for (var i = 0; i < HEADERS.length; i++) {
    if (String(row[i]).trim() !== HEADERS[i]) return false;
  }
  return true;
}

/**
 * Deletes any DATA row that is really a duplicate header. v1's race left one of
 * these behind; without this it would sit in the log for ever and be counted as a
 * blocked submission. Only removes rows that match the header exactly.
 */
function removeStrayHeaderRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return;
  var width = Math.max(sheet.getLastColumn(), 2);
  var values = sheet.getRange(2, 1, last - 1, width).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][0]).trim() === HEADERS[0] &&
        String(values[i][1]).trim() === HEADERS[1]) {
      sheet.deleteRow(i + 2);
    }
  }
}

// ── Reading rows back ────────────────────────────────────────────

/**
 * A timestamp cell may come back as a String or as a Date depending on whether
 * Sheets decided to parse it. Handle both rather than assuming.
 */
function rowDate_(value) {
  if (value instanceof Date) return value;
  var d = new Date(String(value).replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
}

/** The most recent rows as arrays, newest last. Never reads the whole sheet. */
function recentRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var start = Math.max(2, last - MAX_SCAN_ROWS + 1);
  return sheet.getRange(start, 1, last - start + 1, HEADERS.length).getValues();
}

function dayKey_(date) {
  return Utilities.formatDate(date, TIMEZONE, 'yyyy-MM-dd');
}

/**
 * The "is this worth interrupting someone" test, mirroring looksLikeRealEnquiry()
 * in the npm package. Used only as a FALLBACK: the route sends an `urgent` flag,
 * but a site whose package-lock.json has not been bumped yet is still on the old
 * package and sends no flag at all. Recomputing here means the staggered rollout
 * never silently loses urgency.
 */
function looksLikeRealEnquiry_(name, phone, message) {
  var digits = String(phone || '').replace(/\D/g, '');
  return String(name || '').trim().length > 1 &&
         digits.length >= 7 &&
         String(message || '').trim().length > 0;
}

/**
 * Layers that are never worth an immediate email, whatever else the row contains.
 * The pre-split "content" label is deliberately absent: it could be a URL or
 * Cyrillic block, which is exactly where false positives live.
 */
var NEVER_URGENT_LAYERS = {
  'origin': true, 'timing': true, 'missing-fields': true,
  'content:short-phone': true, 'delivered-no-js': true,
  'delivered-honeypot-autofill': true, 'validation': true
};

/** Mirrors isDelivered() in the package, for sites still on an older package. */
function isDelivered_(payload) {
  if (payload.delivered) return String(payload.delivered).toLowerCase() === 'yes';
  return String(payload.layer || '').indexOf('delivered-') === 0;
}

function isUrgent_(payload) {
  // The current package decides this and sends it, so one definition governs both.
  if (payload.urgent !== undefined && payload.urgent !== null) {
    return String(payload.urgent).toLowerCase() === 'yes';
  }
  // No flag at all means the site is still on the pre-2026-09-08 package — its
  // package-lock.json has not been bumped yet. Recompute so a staggered rollout
  // never silently drops urgency.
  if (NEVER_URGENT_LAYERS[payload.layer]) return false;
  return looksLikeRealEnquiry_(payload.name, payload.phone, payload.message);
}

// ── Intake ───────────────────────────────────────────────────────

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

    // A Resend webhook event rather than a row from a contact route.
    if (p && typeof p.type === 'string' && p.type.indexOf('email.') === 0) {
      return jsonOut_(recordResendEvent_(sheet, p));
    }

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
    var urgent = isUrgent_(p);

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
      '',                    // Reviewed — left for a human
      urgent ? 'yes' : '',
      isDelivered_(p) ? 'Yes' : ''
    ]);

    // Alerting must never cost us the row. If mail fails, the log still stands.
    var alerted = false;
    if (urgent) {
      try {
        alerted = maybeSendImmediate_(sheet, p, stamp);
      } catch (mailErr) {
        console.error('immediate alert failed: ' + mailErr);
      }
    }
    try {
      maybeSendSpike_(sheet, p);
    } catch (spikeErr) {
      console.error('spike alert failed: ' + spikeErr);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, version: VERSION, urgent: urgent, alerted: alerted }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, version: VERSION, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── Resend webhook events ────────────────────────────────────────

var RESEND_LAYERS = { 'email.bounced': 'email-bounced', 'email.complained': 'email-complained' };

/**
 * Records a bounced or spam-reported lead email. Other event types (sent, delivered,
 * opened…) are acknowledged and ignored, so subscribing to extra events is harmless.
 * Resend retries a webhook it thinks failed, so an event already in the log is skipped.
 */
function recordResendEvent_(sheet, p) {
  var layer = RESEND_LAYERS[p.type];
  if (!layer) return { ok: true, version: VERSION, ignored: p.type };
  var d = p.data || {};
  var emailId = String(d.email_id || '');
  var marker = '[' + emailId + ']';

  if (emailId) {
    var rows = recentRows_(sheet);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][COL.LAYER]) === layer && String(rows[i][COL.MATCHED]).indexOf(marker) !== -1) {
        return { ok: true, version: VERSION, duplicate: true };
      }
    }
  }

  var to = [].concat(d.to || []).join(', ');
  var from = String(d.from || '');
  // "Power Construction Leads <leads@…>" → "Power Construction Leads"
  var site = from.replace(/\s*<[^>]*>\s*$/, '').replace(/"/g, '') || '(resend)';
  var reason = d.bounce ? [d.bounce.type, d.bounce.subType, d.bounce.message].filter(Boolean).join(' — ') : '';
  var p2 = {
    site: site,
    layer: layer,
    matched: 'to ' + to + (reason ? ' | ' + reason : '') + ' ' + marker,
    message: String(d.subject || ''),
    source: 'Resend webhook'
  };
  var stamp = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow([stamp, p2.site, p2.layer, p2.matched, '', '', '', p2.message, p2.source,
                   '', '', '', '', '', 'yes', '']);

  var alerted = false;
  try {
    if (MailApp.getRemainingDailyQuota() >= 5) {
      MailApp.sendEmail({
        to: alertRecipient_(),
        subject: (layer === 'email-bounced' ? 'Lead email BOUNCED' : 'Lead email marked as spam') + ' — ' + site,
        htmlBody:
          '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#0f172a;">' +
          '<h2 style="margin:0 0 4px;">' + (layer === 'email-bounced' ? 'A lead email bounced' : 'A lead email was reported as spam') + '</h2>' +
          '<p style="margin:0 0 16px;color:#64748b;">' +
            (layer === 'email-bounced'
              ? 'Resend accepted this email but the receiving server rejected it, so the client never got it. ' +
                'Find the lead in the client\'s sheet (or the Vercel logs), forward it, then fix the recipient address or the client\'s mail setup.'
              : 'The recipient marked a lead email as spam. Future lead emails to them may be filtered — ask the client to mark our sender as safe.') +
          '</p>' +
          detailTable_({ 'Subject': d.subject, 'To': to, 'From': from, 'Reason': reason, 'Resend email id': emailId, 'When': p.created_at }) +
          '</div>'
      });
      alerted = true;
    }
  } catch (mailErr) {
    console.error('bounce alert failed: ' + mailErr);
  }
  return { ok: true, version: VERSION, recorded: layer, alerted: alerted };
}

// ── Spike alerts ─────────────────────────────────────────────────

/**
 * Emails once when one rule on one site reaches its threshold today. Counts the row
 * just appended, and fires only on exactly the threshold, so a flood sends one email.
 */
function maybeSendSpike_(sheet, p) {
  var layer = String(p.layer || '');
  var site = String(p.site || '(unknown)');
  if (!SPIKE_LAYERS[layer]) return false;
  var threshold = layer === 'delivered-sheet-failed' ? SHEET_FAILED_SPIKE_THRESHOLD : SPIKE_THRESHOLD;

  var today = dayKey_(new Date());
  var rows = recentRows_(sheet);
  var count = 0;
  var matchedCounts = {};
  for (var i = 0; i < rows.length; i++) {
    var d = rowDate_(rows[i][COL.TIMESTAMP]);
    if (!d || dayKey_(d) !== today) continue;
    if (String(rows[i][COL.SITE]) !== site || String(rows[i][COL.LAYER]) !== layer) continue;
    count++;
    // Group by the matched text without per-row details (ms, IPs) so the top reasons read cleanly.
    var key = String(rows[i][COL.MATCHED]).replace(/\d+/g, '#').slice(0, 140);
    matchedCounts[key] = (matchedCounts[key] || 0) + 1;
  }
  if (count !== threshold) return false;
  if (MailApp.getRemainingDailyQuota() < 5) return false;

  var top = Object.keys(matchedCounts)
    .sort(function (a, b) { return matchedCounts[b] - matchedCounts[a]; })
    .slice(0, 5)
    .map(function (k) { return '<li>' + esc_(k) + ' <strong>×' + matchedCounts[k] + '</strong></li>'; })
    .join('');

  var advice =
    layer === 'delivered-sheet-failed'
      ? 'Leads are reaching the client by email but NOT their sheet. Check the client\'s Apps Script deployment (access must be "Anyone") and its URL in GOOGLE_SHEET_WEBHOOK.'
      : layer === 'delivered-flagged'
      ? 'These leads WERE delivered. If the reasons say "origin not in allowedOrigins", the site is being served from a domain missing from its route config. If a keyword keeps matching real customers, remove it from the package.'
      : 'Lead email delivery is failing repeatedly on this site. Check Resend (quota, API key, sending domain) and the client\'s sheet script today.';

  MailApp.sendEmail({
    to: alertRecipient_(),
    subject: 'Spike: ' + layer + ' ×' + count + ' today — ' + site,
    htmlBody:
      '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#0f172a;">' +
      '<h2 style="margin:0 0 4px;">' + esc_(site) + ': ' + count + ' "' + esc_(layer) + '" rows today</h2>' +
      '<p style="margin:0 0 12px;color:#64748b;">' + advice + '</p>' +
      '<p style="margin:0 0 4px;font-weight:bold;">Most common reasons</p><ul style="margin:0 0 16px;">' + top + '</ul>' +
      '<p style="margin:0;color:#64748b;">This alert is sent once per site and rule per day.</p>' +
      '<p style="margin:16px 0 0;"><a href="' + sheetUrl_() + '">Open the Blocked Submissions log</a></p>' +
      '</div>'
  });
  return true;
}

// ── Immediate alerts ─────────────────────────────────────────────

function alertRecipient_() {
  var override = PropertiesService.getScriptProperties().getProperty('ALERT_TO');
  return override || DEFAULT_ALERT_TO;
}

/**
 * Sends the "you may have just lost a lead" email, unless this site has already
 * had its ration today. Returns whether an email actually went out.
 */
function maybeSendImmediate_(sheet, p, stamp) {
  var site = p.site || '(unknown)';
  var today = dayKey_(new Date());
  var rows = recentRows_(sheet);

  var urgentToday = 0;
  for (var i = 0; i < rows.length; i++) {
    var d = rowDate_(rows[i][COL.TIMESTAMP]);
    if (!d || dayKey_(d) !== today) continue;
    if (String(rows[i][COL.SITE]) !== site) continue;
    if (String(rows[i][COL.URGENT]).toLowerCase() === 'yes') urgentToday++;
  }

  // urgentToday includes the row just appended, so this is "the Nth of the day".
  if (urgentToday > MAX_IMMEDIATE_PER_SITE_PER_DAY) return false;

  if (MailApp.getRemainingDailyQuota() < 5) {
    console.warn('mail quota nearly exhausted — holding alert for the digest');
    return false;
  }

  var lastOfRation = urgentToday === MAX_IMMEDIATE_PER_SITE_PER_DAY;
  var html =
    '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#0f172a;">' +
      '<h2 style="margin:0 0 4px;">' + esc_(alertHeading_(p.layer)) + ' — ' + esc_(site) + '</h2>' +
      '<p style="margin:0 0 16px;color:#64748b;">' + alertExplanation_(p.layer) +
        (p.layer === 'honeypot'
          ? '<br><strong>A honeypot hit with a full name, phone and message is usually a ' +
            'password manager filling the hidden field — most likely a real customer.</strong>'
          : '') +
      '</p>' +
      detailTable_({
        'Time': stamp, 'Rule': p.layer, 'Matched': p.matched, 'Name': p.name,
        'Phone': p.phone, 'Email': p.email, 'Message': p.message, 'Source': p.source,
        'Origin': p.origin, 'Referer': p.referer, 'User agent': p.userAgent, 'IP': p.ip
      }) +
      (lastOfRation
        ? '<p style="margin:16px 0 0;color:#b45309;">That is ' + MAX_IMMEDIATE_PER_SITE_PER_DAY +
          ' immediate alerts for this site today — any further ones are logged and will ' +
          'appear in tomorrow morning\'s digest instead.</p>'
        : '') +
      '<p style="margin:16px 0 0;"><a href="' + sheetUrl_() + '">Open the Blocked Submissions log</a></p>' +
    '</div>';

  MailApp.sendEmail({
    to: alertRecipient_(),
    subject: alertHeading_(p.layer) + ': ' + (p.layer || '?') + ' — ' + site + (p.name ? ' (' + p.name + ')' : ''),
    htmlBody: html
  });
  return true;
}

/**
 * Since package 2.6.0 two kinds of row are urgent that are NOT spam blocks: a lead that
 * reached neither the sheet nor the email, and one that reached only the sheet. The
 * old "withheld by the rule" wording sent people looking for a spam rule to fix.
 */
function alertHeading_(layer) {
  if (layer === 'delivery-failed') return 'LEAD NOT DELIVERED';
  if (layer === 'delivered-email-failed') return 'Lead email failed';
  return 'Possible lost lead';
}

function alertExplanation_(layer) {
  if (layer === 'delivery-failed') {
    return '<strong>Neither the client\'s sheet nor the email accepted this lead.</strong> ' +
      'The details below are the only copy — send it to the client now, then check the ' +
      'Matched column for what failed (Resend quota or key, Apps Script deployment).';
  }
  if (layer === 'delivered-email-failed') {
    return 'This lead reached the client\'s leads sheet, but the email did not send, so a ' +
      'client who works from their inbox will not see it. Forward it, then check Resend ' +
      '(quota, API key, sending domain) — an email failure usually hits every site.';
  }
  return 'This was withheld from the client by the <strong>' + esc_(layer) + '</strong> rule, ' +
    'but it has a real name, a dialable phone and a message — so it may be a customer, not a ' +
    'bot. If it reads like one, call them, then fix the rule.';
}

// ── Daily digest ─────────────────────────────────────────────────

/**
 * One email a morning covering the last 24 hours across every site. This is what
 * replaced 10–76 individual emails a day. Sends nothing when there is nothing to
 * report — a silent morning should mean silence, not an empty email.
 *
 * Safe to run by hand from the editor at any time.
 */
function sendDailyDigest() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = getTab_(ss, false);
  if (!sheet) return;

  var cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  var rows = recentRows_(sheet).filter(function (r) {
    var d = rowDate_(r[COL.TIMESTAMP]);
    return d && d >= cutoff;
  });

  if (!rows.length) {
    console.log('digest: nothing in the last 24h — not sending');
    return;
  }

  // Group by site, then by layer, keeping the urgent rows aside for full detail.
  var bySite = {};
  var urgentRows = [];
  rows.forEach(function (r) {
    var site = String(r[COL.SITE]) || '(unknown)';
    var layer = String(r[COL.LAYER]) || '(unknown)';
    if (!bySite[site]) bySite[site] = { total: 0, layers: {} };
    bySite[site].total++;
    bySite[site].layers[layer] = (bySite[site].layers[layer] || 0) + 1;
    if (String(r[COL.URGENT]).toLowerCase() === 'yes') urgentRows.push(r);
  });

  var sites = Object.keys(bySite).sort(function (a, b) { return bySite[b].total - bySite[a].total; });

  var html =
    '<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#0f172a;">' +
    '<h2 style="margin:0 0 4px;">Blocked submissions — last 24 hours</h2>' +
    '<p style="margin:0 0 16px;color:#64748b;">' + rows.length + ' blocked across ' +
      sites.length + ' site' + (sites.length === 1 ? '' : 's') + '. ' +
      (urgentRows.length
        ? '<strong>' + urgentRows.length + ' need' + (urgentRows.length === 1 ? 's' : '') +
          ' a look</strong> — listed first.'
        : 'None of them looked like a real customer.') +
    '</p>';

  if (urgentRows.length) {
    html += '<h3 style="margin:24px 0 8px;">Worth reviewing</h3>' +
            '<p style="margin:0 0 12px;color:#64748b;">Each of these was withheld from the ' +
            'client but still had a real name, a dialable phone and a message.</p>';
    urgentRows.forEach(function (r) {
      html += '<div style="margin:0 0 16px;padding:12px;border:1px solid #e2e8f0;border-radius:6px;">' +
        '<div style="font-weight:bold;margin-bottom:8px;">' + esc_(r[COL.SITE]) + ' — ' +
          esc_(r[COL.LAYER]) + '</div>' +
        detailTable_({
          'Time': r[COL.TIMESTAMP], 'Matched': r[COL.MATCHED], 'Name': r[COL.NAME],
          'Phone': r[COL.PHONE], 'Email': r[COL.EMAIL], 'Message': r[COL.MESSAGE],
          'Source': r[COL.SOURCE]
        }) +
      '</div>';
    });
  }

  html += '<h3 style="margin:24px 0 8px;">Everything blocked, by site</h3>' +
          '<table style="border-collapse:collapse;width:100%;max-width:620px;">' +
          '<tr><th style="' + TH_ + '">Site</th><th style="' + TH_ + '">Rule</th>' +
          '<th style="' + TH_ + '">Count</th></tr>';
  sites.forEach(function (site) {
    var layers = bySite[site].layers;
    Object.keys(layers).sort(function (a, b) { return layers[b] - layers[a]; })
      .forEach(function (layer, i) {
        html += '<tr>' +
          '<td style="' + TD_ + '">' + (i === 0 ? esc_(site) : '') + '</td>' +
          '<td style="' + TD_ + '">' + esc_(layer) + '</td>' +
          '<td style="' + TD_ + 'text-align:right;">' + layers[layer] + '</td>' +
        '</tr>';
      });
  });
  html += '</table>' +
    '<p style="margin:16px 0 0;color:#64748b;">A big count on one site and one rule is ' +
    'usually a single scanner, not a problem with the filter. A "keyword:" or ' +
    '"content:" rule appearing across several sites at once is the shape of a false ' +
    'positive — check the wording before it costs a real lead.</p>' +
    '<p style="margin:16px 0 0;"><a href="' + sheetUrl_() + '">Open the Blocked Submissions log</a></p>' +
    '</div>';

  MailApp.sendEmail({
    to: alertRecipient_(),
    subject: 'Blocked submissions: ' + rows.length + ' in 24h' +
             (urgentRows.length ? ' — ' + urgentRows.length + ' to review' : ''),
    htmlBody: html
  });
  console.log('digest sent: ' + rows.length + ' rows, ' + urgentRows.length + ' urgent');
}

// ── Formatting helpers ───────────────────────────────────────────

var TH_ = 'padding:6px 10px;border:1px solid #e2e8f0;background:#f8fafc;text-align:left;';
var TD_ = 'padding:6px 10px;border:1px solid #e2e8f0;';

function esc_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function detailTable_(fields) {
  var html = '<table style="border-collapse:collapse;width:100%;max-width:620px;">';
  Object.keys(fields).forEach(function (label) {
    html += '<tr><td style="' + TD_ + 'font-weight:bold;background:#f8fafc;white-space:nowrap;">' +
      esc_(label) + '</td><td style="' + TD_ + '">' + (esc_(fields[label]) || '—') + '</td></tr>';
  });
  return html + '</table>';
}

function sheetUrl_() {
  return 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit';
}

// ── One-time setup ───────────────────────────────────────────────

/**
 * Run this ONCE from the editor after pasting the script. It authorises mail
 * sending and installs the morning digest trigger, replacing any earlier copy so
 * running it twice cannot produce two digests a day.
 */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyDigest').timeBased().atHour(DIGEST_HOUR).everyDays(1).create();
  console.log('Digest trigger installed for ~' + DIGEST_HOUR + ':00 ' + TIMEZONE +
              '. Alerts go to ' + alertRecipient_() + '.');
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

    var digestInstalled = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'sendDailyDigest';
    });

    return ContentService
      .createTextOutput(JSON.stringify({
        ok: true,
        status: 'listening',
        version: VERSION,
        tabExists: !!sheet,
        digestTriggerInstalled: digestInstalled,
        alertTo: alertRecipient_(),
        maxImmediatePerSitePerDay: MAX_IMMEDIATE_PER_SITE_PER_DAY,
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
