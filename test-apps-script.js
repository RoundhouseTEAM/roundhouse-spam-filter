/**
 * Tests for docs/blocked-log-apps-script.gs.
 *
 * That script cannot be imported or run outside Google, and it is now the ONLY
 * thing that alerts anyone to a wrongly blocked lead — if it breaks, the failure is
 * silence, which is exactly the failure mode nobody notices. So it is loaded here
 * into a stubbed Apps Script runtime (a fake Sheet, MailApp, Utilities and the
 * rest) and driven through the cases that matter.
 *
 * The headline case is the 2026-09-08 sqlmap flood replayed in full: 66 probes must
 * produce 66 rows and zero emails.
 *
 * Run with: npm test
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// ── A stand-in for the Google Apps Script runtime ────────────────
const sent = [];
let dataRows = [];
let header = null;

const sheet = {
  getLastRow: () => (header ? 1 : 0) + dataRows.length,
  getLastColumn: () => 15,
  setFrozenRows: () => {},
  insertRowBefore: () => {},
  deleteRow: (n) => { dataRows.splice(n - 2, 1); },
  appendRow: (r) => dataRows.push(r.slice()),
  getRange: (r, c, nr, nc) => ({
    setValues: (v) => {
      if (r === 1) header = v[0].slice();
      return { setFontWeight: () => ({ setBackground: () => {} }) };
    },
    getValues: () =>
      r === 1
        ? [(header || []).slice(c - 1, c - 1 + nc)]
        : dataRows.slice(r - 2, r - 2 + nr).map((x) => x.slice(c - 1, c - 1 + nc)),
  }),
};

Object.assign(globalThis, {
  SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) },
  LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
  ScriptApp: {
    getProjectTriggers: () => [],
    newTrigger: () => ({ timeBased: () => ({ atHour: () => ({ everyDays: () => ({ create: () => {} }) }) }) }),
    deleteTrigger: () => {},
  },
  MailApp: { getRemainingDailyQuota: () => 1400, sendEmail: (o) => sent.push(o) },
  ContentService: { MimeType: { JSON: "json" }, createTextOutput: (t) => ({ setMimeType: () => t }) },
  Utilities: {
    formatDate: (d, tz, fmt) => {
      const p = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      }).formatToParts(d).reduce((a, x) => ((a[x.type] = x.value), a), {});
      const day = `${p.year}-${p.month}-${p.day}`;
      return fmt === "yyyy-MM-dd" ? day : `${day} ${p.hour}:${p.minute}:${p.second}`;
    },
  },
});

// The .gs is plain ES5 with top-level `var` and `function`, so running it inside a
// Function body and handing back the entry points needs no transformation at all.
const gs = readFileSync(join(here, "docs", "blocked-log-apps-script.gs"), "utf8");
const { doPost, sendDailyDigest } = new Function(
  gs + "\nreturn { doPost: doPost, sendDailyDigest: sendDailyDigest };"
)();

let fails = 0;
const ok = (label, cond, detail = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"} ${label}${cond || !detail ? "" : `  — ${detail}`}`);
};
const reset = () => { sent.length = 0; dataRows = []; header = null; };
const post = (p) => doPost({ postData: { contents: JSON.stringify(p) } });
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const headerRow = () => sheet.getRange(1, 1, 1, 15).getValues()[0];

const lead = {
  name: "Sarah Mitchell", phone: "317-555-0134", email: "s@gmail.com",
  message: "Water heater leaking", source: "/contact",
};

console.log("\n── Replaying the 2026-09-08 sqlmap flood ────────────────\n");
reset();
for (let i = 0; i < 66; i++) {
  post({ site: "indiana-flow-website", layer: "origin", urgent: "", timestamp: minsAgo(30),
         matched: "referer is an API path", name: "ORDER BY 1-- -", phone: "-5244",
         message: "CONCAT(0x7e" });
}
ok("all 66 probes are logged", dataRows.length === 66, `got ${dataRows.length}`);
ok("66 probes send ZERO emails", sent.length === 0, `sent ${sent.length}`);

console.log("\n── A real customer caught by a filter ───────────────────\n");
reset();
post({ site: "newmans-plumbing", layer: "keyword:coldOutreach", urgent: "yes",
       matched: "i came across your website", timestamp: minsAgo(5), ...lead });
ok("an urgent block emails immediately", sent.length === 1, `sent ${sent.length}`);
ok("the subject names the site and the rule",
   /Possible lost lead: keyword:coldOutreach — newmans-plumbing/.test(sent[0].subject), sent[0]?.subject);
ok("the body carries the phone number to call back", sent[0].htmlBody.includes("317-555-0134"));
ok("the row is marked Urgent in the sheet", dataRows[0][14] === "yes");

console.log("\n── Per-site daily cap ──────────────────────────────────\n");
reset();
for (let i = 0; i < 10; i++) {
  post({ site: "alpha-omega-website", layer: "content:url", urgent: "yes",
         timestamp: minsAgo(20 - i), ...lead, name: `Customer ${i}` });
}
ok("all 10 urgent rows are still logged", dataRows.length === 10, `got ${dataRows.length}`);
ok("only 3 immediate emails go out", sent.length === 3, `sent ${sent.length}`);
ok("the 3rd says further alerts are held for the digest",
   sent[2].htmlBody.includes("immediate alerts for this site today"));
const beforeOtherSite = sent.length;
post({ site: "taws-website", layer: "content:url", urgent: "yes", timestamp: minsAgo(1), ...lead });
ok("a different site gets its own ration", sent.length === beforeOtherSite + 1);

console.log("\n── Daily digest ────────────────────────────────────────\n");
reset();
for (let i = 0; i < 40; i++) post({ site: "indiana-flow-website", layer: "origin", urgent: "", timestamp: minsAgo(120) });
for (let i = 0; i < 12; i++) post({ site: "alpha-omega-website", layer: "content:short-phone", urgent: "", timestamp: minsAgo(200) });
post({ site: "newmans-plumbing", layer: "content:url", urgent: "yes", timestamp: minsAgo(60), ...lead });
post({ site: "irrigators-llc-website", layer: "timing", urgent: "", timestamp: minsAgo(3000) }); // >24h old
const beforeDigest = sent.length;
sendDailyDigest();
ok("the digest is exactly one email", sent.length === beforeDigest + 1, `sent ${sent.length - beforeDigest}`);
const digest = sent[sent.length - 1];
ok("the subject counts the window and the review items",
   /Blocked submissions: 53 in 24h — 1 to review/.test(digest.subject), digest.subject);
ok("rows older than 24h are excluded", !digest.htmlBody.includes("irrigators"));
ok("the one worth reviewing is listed in full", digest.htmlBody.includes("Water heater leaking"));
ok("the flood is rolled up as a count, not 40 entries", digest.htmlBody.includes(">40<"));

console.log("\n── A quiet day sends nothing ───────────────────────────\n");
reset();
sendDailyDigest();
ok("an empty 24 hours sends no digest at all", sent.length === 0);

console.log("\n── A site still on the old package ─────────────────────\n");
// Its package-lock.json has not been bumped, so it sends no `urgent` flag and the
// script has to work the urgency out for itself.
reset();
post({ site: "purkey-puppies", layer: "content", timestamp: minsAgo(2), ...lead });
ok('legacy "content" with real details is treated as urgent', sent.length === 1, `sent ${sent.length}`);
reset();
post({ site: "purkey-puppies", layer: "origin", timestamp: minsAgo(2), ...lead });
ok("a legacy bot-certain layer stays silent", sent.length === 0);

console.log("\n── Header migration from v3 ────────────────────────────\n");
reset();
post({ site: "x", layer: "origin", urgent: "", timestamp: minsAgo(1) });
ok("the header gained the Urgent column", headerRow()[14] === "Urgent", JSON.stringify(headerRow()));

console.log(`\n${fails === 0 ? "PASS" : "FAIL"} — Apps Script: ${fails} failure${fails === 1 ? "" : "s"}\n`);
process.exit(fails === 0 ? 0 : 1);
