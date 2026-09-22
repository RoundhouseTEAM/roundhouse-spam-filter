/**
 * Roundhouse blocked-submission recorder.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Every spam layer returns a deliberate fake success so bots can't tell they were
 * caught. The side effect is that a WRONGLY blocked submission — a real customer
 * whose wording tripped a keyword — vanishes with no trace at all. The customer
 * sees "thanks", the lead never arrives, and nobody finds out.
 *
 * This module makes every block leave a record, so a false positive can be spotted
 * and the lead recovered. It never changes whether something is blocked; it only
 * writes down that it happened.
 *
 * WHERE IT WRITES
 * ───────────────
 * One central Roundhouse "Blocked Submissions" sheet shared by every client site —
 * NOT the client's own leads sheet. Clients should never see spam noise, and a
 * single shared log is the only way a portfolio-wide false-positive pattern
 * becomes visible ("every site is dropping leads on keyword:coldOutreach").
 *
 * THIS MODULE NEVER SENDS EMAIL — 2026-09-08
 * ──────────────────────────────────────────
 * It used to email Roundhouse via Resend on every content/keyword block. On
 * 2026-09-08 a sqlmap scanner hit Indiana Flow's /api/contact 66 times in 19
 * minutes; all 66 were blocked correctly, and all 66 sent an alert, which put the
 * Resend account over its limit. Because blocked-alerts and real customer lead
 * emails share one Resend account, anyone with a shell script could take out lead
 * delivery for every client at once.
 *
 * So alerting moved OUT of the request path and INTO the Apps Script behind the
 * sheet (docs/blocked-log-apps-script.gs), which sends on Google Workspace's own
 * quota and can rate-limit itself because it can see the whole log. The route now
 * only ever writes a row. No volume of spam can touch lead delivery again — that is
 * a structural guarantee, not a tuning knob.
 *
 * The `urgent` flag below is what tells the Apps Script which rows deserve an
 * immediate email rather than the daily digest. Computing it here keeps one
 * definition of "this might be a real customer" instead of two.
 *
 * FAILURE POLICY
 * ──────────────
 * This must never break a contact route. Every path is wrapped and bounded by a
 * timeout. The FULL row (name, phone, message) is written to the console before the
 * webhook is tried, so a withheld lead can still be recovered from the Vercel runtime
 * logs when the sheet is down. Until 2.6.0 the console line held only the rule name,
 * and a 200 from the webhook counted as success even when the Apps Script had answered
 * {ok:false} — a broken log meant withheld leads left no trace at all.
 */

/**
 * Layers where only a bot realistically lands. Never worth an immediate email.
 *
 * "honeypot" is deliberately NOT in this set. It was, until a real submission was
 * blocked by it on Indiana Flow on 2026-08-31 — a password manager had filled the
 * hidden field. A honeypot hit is therefore NOT proof of a bot, so it is judged on
 * whether the rest of the submission reads like a person.
 */
const NEVER_URGENT_LAYERS = new Set([
  "origin",
  "timing",
  "missing-fields",
  // Blocked purely on a phone too short to dial. That also means there is no lead
  // to rescue even if it were a person, so it never warrants waking anyone up.
  // This is the rule the 2026-09-08 sqlmap run tripped 66 times.
  "content:short-phone",
  // NOT a block. A visitor whose JavaScript never ran submits with an empty _ts;
  // the lead IS delivered (flagged for review) and recorded here purely so the
  // volume of no-JS submissions is visible.
  "delivered-no-js",
  // NOT a block either: browser autofill filled the honeypot on a real visit, and the
  // lead WAS delivered normally. An urgent alert for a lead the client already has would
  // just be noise.
  "delivered-honeypot-autofill",
  // A visitor was shown a message telling them what to fix. Nothing was lost.
  "validation",
  // 30+ deliverable submissions from one IP in 10 minutes. Every row is still logged in
  // full; the per-day cap would be spent on one flood otherwise.
  "rate-limit-flood",
  // No fields were even parsed — there is no lead to rescue.
  "too-large",
  // Posted from another website's page — never our own form.
  "fetch-metadata",
  // A known bot template (BLOCKED_MESSAGES) with a fake 555-01xx phone. Always a bot, and
  // it arrives several times a day across sites — the digest is enough (2026-09-21).
  "template",
  // SEO / digital-marketing pitch (BLOCKED_KEYWORDS). Philip, 2026-09-22: record it, don't alert.
  "blocked-keyword",
]);

/** Rows that record a lead the client DID receive — shown as "Yes" in the Delivered column. */
function isDelivered(layer) {
  return String(layer).startsWith("delivered-");
}

/**
 * A name, a dialable phone and an actual message together. Bots frequently miss at
 * least one; a real customer caught by a filter has all three. This is the whole
 * test for "there is a lead here worth rescuing today".
 */
export function looksLikeRealEnquiry(row) {
  const digits = String(row?.phone || "").replace(/\D/g, "");
  return String(row?.name || "").trim().length > 1 &&
         digits.length >= 7 &&
         String(row?.message || "").trim().length > 0;
}

/**
 * Whether this block should reach a human immediately rather than in the digest.
 * Everything is logged either way — this only decides the urgency of the read.
 */
function isUrgent(row) {
  if (NEVER_URGENT_LAYERS.has(row.layer)) return false;
  // The client HAS a delivered lead, so there is nothing to rescue — except when only
  // the sheet caught it: a client who works from their inbox won't see it, and a
  // failing email usually means every site's email is failing.
  if (isDelivered(row.layer)) return row.layer === "delivered-email-failed";
  return looksLikeRealEnquiry(row);
}

/** Sheets tops out at 50k chars per cell; stay well clear and keep rows readable. */
const MAX_FIELD = 4000;

import { callAppsScript } from "./apps-script.js";

// From Vercel the central script takes 20–30s to RUN (2026-09-16), so the run gets 24s and
// reading its answer a separate 4s — see apps-script.js. handleLead sends these after the
// response where the platform allows, so a visitor never waits on them.
const WEBHOOK_RUN_TIMEOUT_MS = 24000;
const WEBHOOK_READ_TIMEOUT_MS = 4000;

function clip(value, limit = MAX_FIELD) {
  const s = String(value ?? "").trim();
  return s.length > limit ? `${s.slice(0, limit)}… [truncated]` : s;
}


/**
 * Pulls forensics off the request. A submission with NO origin, NO referer and a
 * blank source is the fingerprint of a script POSTing the endpoint directly — the
 * pattern behind the 2026-08-09/10 Alpha Omega run. Recording them makes that
 * diagnosis possible from the sheet alone instead of guessing.
 */
function readRequestMeta(req) {
  const meta = { origin: "", referer: "", userAgent: "", ip: "" };
  try {
    const h = req?.headers;
    if (!h || typeof h.get !== "function") return meta;
    meta.origin = h.get("origin") ?? "";
    meta.referer = h.get("referer") ?? "";
    meta.userAgent = h.get("user-agent") ?? "";
    meta.ip =
      (h.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
      h.get("x-real-ip") ||
      "";
  } catch {
    /* headers are best-effort — never let this break the log */
  }
  return meta;
}

/**
 * Records one blocked submission. Await it before returning the fake success —
 * on serverless, a fire-and-forget fetch is killed when the response is sent.
 *
 * @param {object} entry
 * @param {string} entry.site    Project slug, e.g. "newmans-plumbing".
 * @param {string} entry.layer   Which rule fired: "honeypot" | "origin" | "timing" |
 *                               "content:short-phone" | "content:url" |
 *                               "content:non-latin" | "missing-fields" | a
 *                               checkSpam verdict.rule.
 * @param {string} [entry.matched] The specific term or condition that matched.
 * @param {object} [entry.req]   The request, for origin/referer/UA forensics.
 * @returns {Promise<void>} Never rejects.
 */
export async function logBlocked(entry = {}) {
  try {
    const {
      site = process.env.BLOCKED_LOG_SITE || "unknown",
      layer = "unknown",
      matched = "",
      name = "",
      email = "",
      phone = "",
      message = "",
      source = "",
      req,
    } = entry;

    const meta = readRequestMeta(req);

    const row = {
      timestamp: new Date().toISOString(),
      site: clip(site, 100),
      layer: clip(layer, 100),
      matched: clip(matched, 200),
      name: clip(name, 200),
      phone: clip(phone, 100),
      email: clip(email, 200),
      message: clip(message),
      source: clip(source, 500),
      origin: clip(meta.origin, 200),
      referer: clip(meta.referer, 500),
      userAgent: clip(meta.userAgent, 500),
      ip: clip(meta.ip, 100),
    };

    // Tells the Apps Script whether to email now or leave it for the daily digest.
    // Sent as a string because the sheet stores it as one.
    row.urgent = isUrgent({ layer: row.layer, name, phone, message }) ? "yes" : "";
    // So a delivered lead in this sheet is never mistaken for a lost one (2026-09-16:
    // five of ten "good leads marked as spam" had actually reached the client).
    row.delivered = isDelivered(row.layer) ? "Yes" : "";

    // Console first, with the whole row — this is the fallback record if the webhook is
    // unset, down or broken, and it is what shows up in Vercel runtime logs.
    console.warn(
      `[blocked-log] ${row.site} | ${row.layer} | ${row.matched || "—"}${row.urgent ? " | URGENT" : ""}`,
      JSON.stringify(row)
    );

    const webhook = process.env.BLOCKED_LOG_WEBHOOK;
    if (!webhook) {
      console.warn("[blocked-log] BLOCKED_LOG_WEBHOOK not set — console only");
      return;
    }

    const call = await callAppsScript(
      webhook,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(row) },
      { runTimeoutMs: WEBHOOK_RUN_TIMEOUT_MS, readTimeoutMs: WEBHOOK_READ_TIMEOUT_MS }
    );
    if (call.unread) {
      // The script finished (Google only redirects afterwards) — the row is almost
      // certainly there, but its answer couldn't be confirmed.
      console.warn(`[blocked-log] row sent; ${call.detail}`);
      return;
    }
    if (!call.response) {
      console.error(`[blocked-log] ROW NOT RECORDED (${call.detail}) — the row above is the only copy`);
      return;
    }
    // The Apps Script answers {ok:false} when it throws, and Google answers 200 with a
    // sign-in page when the deployment's access changes — only {ok:true} counts.
    const text = await call.response.text().catch(() => "");
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!call.response.ok || data?.ok !== true) {
      console.error(
        `[blocked-log] ROW NOT RECORDED (${call.response.status}: ${text.replace(/\s+/g, " ").slice(0, 160)}) — the row above is the only copy`
      );
    }
  } catch (err) {
    console.error("[blocked-log] failed to record blocked submission:", err);
  }
}

export default logBlocked;
