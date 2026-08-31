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
 * single sheet is what makes a portfolio-wide false-positive pattern visible.
 *
 * ALERTING
 * ────────
 * Honeypot / origin / timing failures are effectively all bots and arrive in volume,
 * so they are logged silently. Content and keyword blocks are where false positives
 * actually live and are low volume, so those additionally email Roundhouse (never
 * the client) — a wrongly blocked lead is worth rescuing the same day rather than
 * whenever someone next opens the sheet.
 *
 * FAILURE POLICY
 * ──────────────
 * This must never break a contact route. Every path is wrapped, bounded by a
 * timeout, and falls back to console output. A logging outage degrades to today's
 * behaviour (silent discard) rather than throwing a 500 at a real visitor.
 */

/** Layers where only a bot realistically lands. Logged, never emailed. */
const SILENT_LAYERS = new Set(["honeypot", "origin", "timing", "missing-fields"]);

/** Sheets tops out at 50k chars per cell; stay well clear and keep rows readable. */
const MAX_FIELD = 4000;

const WEBHOOK_TIMEOUT_MS = 3000;
const EMAIL_TIMEOUT_MS = 3000;

function clip(value, limit = MAX_FIELD) {
  const s = String(value ?? "").trim();
  return s.length > limit ? `${s.slice(0, limit)}… [truncated]` : s;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** fetch with a hard ceiling — a hanging webhook must not hold a serverless response open. */
async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

async function sendAlertEmail(row) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.BLOCKED_ALERT_TO || "support@getroundhouse.com";

  // Every Roundhouse site already sends its leads from this one verified domain,
  // so the default works everywhere and the alerts need no per-project setup.
  // Override only if a site is ever moved to its own verified sending domain.
  const from =
    process.env.BLOCKED_ALERT_FROM ||
    "Roundhouse Blocked Submissions <leads@resend.getroundhouse.com>";

  if (!apiKey) {
    console.warn("[blocked-log] alert skipped — RESEND_API_KEY not set");
    return;
  }

  const field = (label, value) =>
    `<tr><td style="padding:6px 10px;border:1px solid #e2e8f0;font-weight:bold;background:#f8fafc;white-space:nowrap;">${label}</td><td style="padding:6px 10px;border:1px solid #e2e8f0;">${escapeHtml(value) || "—"}</td></tr>`;

  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#0f172a;">
      <h2 style="margin:0 0 4px;">Blocked submission — ${escapeHtml(row.site)}</h2>
      <p style="margin:0 0 16px;color:#64748b;">
        This was withheld from the client by the <strong>${escapeHtml(row.layer)}</strong> rule.
        If it reads like a real customer, the filter needs adjusting and this lead needs rescuing.
      </p>
      <table style="border-collapse:collapse;width:100%;max-width:620px;">
        ${field("Rule", row.layer)}
        ${field("Matched", row.matched)}
        ${field("Name", row.name)}
        ${field("Phone", row.phone)}
        ${field("Email", row.email)}
        ${field("Message", row.message)}
        ${field("Source", row.source)}
        ${field("Origin", row.origin)}
        ${field("Referer", row.referer)}
        ${field("User agent", row.userAgent)}
      </table>
    </div>`;

  const res = await fetchWithTimeout(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `Blocked: ${row.layer} — ${row.site}${row.name ? ` (${row.name})` : ""}`,
        html,
      }),
    },
    EMAIL_TIMEOUT_MS
  );

  if (!res.ok) {
    console.error("[blocked-log] alert email failed:", res.status, await res.text().catch(() => ""));
  }
}

/**
 * Records one blocked submission. Await it before returning the fake success —
 * on serverless, a fire-and-forget fetch is killed when the response is sent.
 *
 * @param {object} entry
 * @param {string} entry.site    Project slug, e.g. "newmans-plumbing".
 * @param {string} entry.layer   Which rule fired: "honeypot" | "origin" | "timing" |
 *                               "content" | "missing-fields" | a checkSpam verdict.rule.
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

    // Console first — this is the fallback record if the webhook is unset or down,
    // and it is what shows up in Vercel runtime logs.
    console.warn(`[blocked-log] ${row.site} | ${row.layer} | ${row.matched || "—"}`);

    const webhook = process.env.BLOCKED_LOG_WEBHOOK;
    const tasks = [];

    if (webhook) {
      tasks.push(
        fetchWithTimeout(
          webhook,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(row),
          },
          WEBHOOK_TIMEOUT_MS
        ).then((res) => {
          if (!res.ok) console.error("[blocked-log] webhook returned", res.status);
        })
      );
    } else {
      console.warn("[blocked-log] BLOCKED_LOG_WEBHOOK not set — console only");
    }

    if (!SILENT_LAYERS.has(row.layer)) {
      tasks.push(sendAlertEmail(row));
    }

    // allSettled so a failing webhook can't stop the alert, or vice versa.
    await Promise.allSettled(tasks);
  } catch (err) {
    console.error("[blocked-log] failed to record blocked submission:", err);
  }
}

export default logBlocked;
