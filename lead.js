/**
 * Roundhouse lead handler — the ENTIRE server side of a contact form, in one place.
 *
 * Every client site used to carry its own copy of this logic in app/api/contact/route.ts.
 * The copies drifted: a fix made on one site on one day was still missing on another a
 * week later, and real leads were lost in the gap (Indiana Flow's hidden-input wipe fixed
 * 9/15 was still live on Power Construction 9/16; the Brandon form could not submit at all
 * for 16 days). A site's route is now:
 *
 *   import { handleLead } from "@roundhouse/spam-filter/lead";
 *   export const POST = (req: Request) => handleLead(req, LEAD_CONFIG);
 *
 * WHEN IN DOUBT, DELIVER IT — 2.6.0 (Philip, 2026-09-16)
 * ──────────────────────────────────────────────────────
 * Up to 2.5.0 every spam rule was a hard block: one matching phrase, a fast device clock,
 * or a sixth lead from an office IP withheld a real customer from the client while they
 * saw "thanks". A lost $10,000 job costs far more than a spam email, so now:
 *
 *  - WITHHELD (silent success, logged in full) only on evidence a customer can't produce:
 *      an oversized body, a request posted from another website (Sec-Fetch-Site),
 *      a confirmed spammer's email domain or phone number, a flood from one IP, or TWO
 *      automation signals together (see AUTOMATION below).
 *  - DELIVERED AND FLAGGED everything else that used to block: keyword phrases, odd TLDs,
 *      gibberish, Cyrillic/Greek, a wrong origin, a too-fast submit or a filled honeypot
 *      on its own, no JavaScript, more than 5 leads from one IP. The client gets the lead
 *      exactly as normal (no label in their inbox); the central log gets a
 *      "delivered-flagged" row so the rules can be tuned.
 *  - VISIBLE messages for anything a person can fix (validation.js).
 *
 * ORDER
 * ─────
 *  1. Size / cross-site         withheld
 *  2. Automation signals        collected; withheld only when two line up
 *  3. Validation                visible per-field messages
 *  4. Content (non-Latin, list) blocklisted domain/phone withheld; the rest flagged
 *  5. Double-click              same lead within 2 minutes → the first lead's id
 *  6. Rate limit                over `limit` flagged; over `floodLimit` withheld
 *  7. Record                    the full lead goes to the Vercel logs BEFORE any delivery
 *  8. Deliver                   client sheet and Resend email in parallel; each counts only
 *                               on a verified answer. Either one keeps the lead. Both
 *                               failing → the visitor is told to call.
 *  9. Log                       flags and any partial failure, after delivery, in parallel
 *
 * Withheld submissions return exactly the same response as a real lead EXCEPT
 * `delivered`, which is what conversions fire on.
 *
 * MONITOR MODE (2.7.0)
 * ────────────────────
 * The daily monitor submits a real lead through each live form with the header
 * `x-roundhouse-monitor: <LEAD_MONITOR_SECRET>`. It runs every check above for real —
 * the live domain against allowedOrigins, validation, classification, the env vars,
 * the Resend key, quota and sending domain — but it never reaches the client: the
 * email goes to Resend's test inbox (delivered@resend.dev), the client's sheet is not
 * written, nothing is logged centrally, and `delivered` is false so no conversion can
 * fire. The response carries a `monitor` block saying exactly what happened.
 *
 * Works with both a fetch() JSON post (the shared form) and a native form post (a
 * visitor whose JavaScript never ran): JSON in → JSON out, form post in → redirect or a
 * plain HTML page out.
 */

import { checkSpam, checkContent, logBlocked } from "./index.js";
import { checkRateLimit, clientIp, DEFAULT_LIMIT, DEFAULT_WINDOW_MS, DEFAULT_FLOOD_LIMIT } from "./ratelimit.js";
import {
  validateLead,
  normalizePhone,
  isChecked,
  deliveryFailedMessage,
  STANDARD_FIELDS,
} from "./validate.js";

/**
 * Largest request accepted. The biggest possible real submission — every field at its
 * maximum, a 600-character message and a long Google Ads URL — is under 10 KB, so 64 KB
 * can never cut off a real lead; it only stops someone POSTing megabytes at the endpoint.
 */
export const MAX_BODY_BYTES = 64 * 1024;

const MIN_FILL_MS = 1500;
const AUTOFILL_MIN_OPEN_MS = 3000;
/** An old-style `_ts` implying the page was open longer than this is a wrong clock. */
const MAX_PLAUSIBLE_OPEN_MS = 7 * 24 * 60 * 60 * 1000;
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
// Generous on purpose. Apps Script routinely takes 5–15s (cold start, script lock), and
// the 6s limit shipped in 2.0.0 aborted a real Power Construction sheet write on
// 2026-09-16. Sheet and email run in parallel, so the slowest path is ~25s of delivery
// plus ~12s of logging — well inside the routes' maxDuration = 60.
const SHEET_TIMEOUT_MS = 25000;
const EMAIL_TIMEOUT_MS = 15000;

/** Resend's sink address: a real send through the real key and domain, delivered nowhere. */
export const MONITOR_EMAIL_SINK = "delivered@resend.dev";

/** Whether this request is the daily monitor, proven by the shared secret. */
export function isMonitorRequest(req) {
  const secret = process.env.LEAD_MONITOR_SECRET ?? "";
  const given = req.headers.get("x-roundhouse-monitor") ?? "";
  if (secret.length < 16 || given.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

/** Checks whose failure means the request did not come from a person on our form. */
const WITHHELD_CONTENT_RULES = new Set(["email-domain", "phone"]);

/**
 * Double-click guard. In-memory on purpose: a repeat click lands a second or two later
 * and almost always on the same warm instance. Not a cross-instance guarantee.
 */
const recent = new Map();

function isDuplicate(key) {
  const now = Date.now();
  for (const [k, v] of recent) if (now - v.at > DUPLICATE_WINDOW_MS) recent.delete(k);
  return recent.get(key);
}

function str(v) {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(str(v));
  return Number.isFinite(n) ? n : null;
}

function esc(s) {
  return String(s ?? "").replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function newLeadId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location } });
}

/** A minimal page for the rare visitor whose JavaScript never ran. */
function htmlPage(title, lines, backHref, status) {
  const items = lines.map((l) => `<li>${esc(l)}</li>`).join("");
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1f2937;line-height:1.6}
h1{font-size:22px}li{margin:6px 0}a{color:#1d4ed8;font-weight:600}</style></head>
<body><h1>${esc(title)}</h1><ul>${items}</ul><p><a href="${esc(backHref)}">&larr; Go back to the form</a></p></body></html>`;
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

async function readBody(req) {
  const type = req.headers.get("content-type") ?? "";
  const native = !type.includes("application/json");
  // Refuse by the declared size before reading anything, then check what actually arrived.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { body: {}, native, tooLarge: declared };
  const text = await req.text();
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_BODY_BYTES) return { body: {}, native, tooLarge: bytes };
  if (!native) return { body: text ? JSON.parse(text) : {}, native };
  let fd;
  if (type.includes("multipart/form-data")) {
    fd = await new Response(text, { headers: { "content-type": type } }).formData();
  } else {
    fd = new URLSearchParams(text);
  }
  const body = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string") body[k] = v;
  return { body, native };
}

/**
 * How long the form was open, as the visitor's own device measured it.
 *
 * The 2.6 form sends `_elapsed` — both ends of the measurement on the same clock. Until
 * 2.5 it sent only `_ts`, the device's clock reading at render, which the server
 * subtracted from ITS clock: a phone or PC running a few minutes fast produced a
 * negative time, read as "submitted in under 1.5s", and a real lead was silently
 * dropped with no alert. A page cached from before the upgrade still sends only `_ts`;
 * an implausible result there is treated as unknown, never as too fast.
 */
export function readOpenTime(body) {
  const elapsed = num(body?._elapsed);
  if (elapsed !== null && elapsed >= 0) return { jsRan: true, openMs: elapsed };
  const ts = num(body?._ts);
  if (ts !== null && ts > 0) {
    const open = Date.now() - ts;
    if (open >= MIN_FILL_MS && open <= MAX_PLAUSIBLE_OPEN_MS) return { jsRan: true, openMs: open };
    return { jsRan: true, openMs: null };
  }
  return { jsRan: false, openMs: null };
}

/**
 * AUTOMATION. Signals a script produces and a person on our form essentially never does.
 * Any one of them alone is delivered and flagged — each has a rare innocent cause (a
 * privacy tool stripping headers, an extension filling a hidden field). Withheld only
 * when at least one strong signal is backed by a second signal, which no real visitor
 * produces: e.g. sqlmap (referer is the API path + no JavaScript) or a form bot
 * (honeypot filled + no JavaScript).
 *
 * @returns {{ strong: string[], weak: string[], honeypot: string }}
 */
export function automationSignals({ body, headers, allowedOrigins, jsRan, openMs }) {
  const strong = [];
  const weak = [];

  const origin = headers.get("origin") ?? "";
  const referer = headers.get("referer") ?? "";
  const allowed = allowedOrigins ?? [];
  let refererIsApi = false;
  try {
    refererIsApi = referer !== "" && new URL(referer).pathname.startsWith("/api/");
  } catch {
    /* not a URL */
  }
  const originOk = origin !== "" && allowed.some((a) => origin.includes(a));
  const refererOk = referer !== "" && !refererIsApi && allowed.some((a) => referer.includes(a));

  if (!originOk && !refererOk) {
    if (refererIsApi) strong.push(`referer is an API path (${referer.slice(0, 120)})`);
    else if (origin === "" && referer === "") strong.push("no origin or referer header");
    // Present but not ours — a domain missing from allowedOrigins, a new domain at DNS
    // cutover, a translation proxy. Up to 2.5.0 this dropped every lead on a
    // misconfigured site with no alert.
    else weak.push(`origin not in allowedOrigins (origin="${origin.slice(0, 120)}" referer="${referer.slice(0, 120)}")`);
  }

  if (openMs !== null && openMs < MIN_FILL_MS) strong.push(`submitted ${Math.round(openMs)}ms after render`);

  const honeypot = str(body.referral_code) || str(body.website);
  if (honeypot) {
    // Edge/Chrome autofill ignores autocomplete="off": JS ran and the form was open a
    // while → a person's browser filled it.
    const autofill = jsRan && (openMs === null || openMs >= AUTOFILL_MIN_OPEN_MS);
    const note = `honeypot filled (${honeypot.slice(0, 80)})`;
    if (autofill) weak.push(`${note} — browser autofill`);
    else strong.push(note);
  }

  if (!jsRan) weak.push("no JavaScript (no _elapsed/_ts)");

  return { strong, weak, honeypot };
}

/**
 * Whether the client's Apps Script actually recorded the row. A 200 alone proves
 * nothing: Apps Script answers 200 with {ok:false} when its code throws, and Google
 * answers 200 with a sign-in or error PAGE when the deployment's access changes. Every
 * Roundhouse lead script returns {ok:true}; a plain-text reply from an older script is
 * accepted as long as it isn't a Google error page.
 */
export async function sheetAccepted(res) {
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
  const text = (await res.text().catch(() => "")).trim();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (data && typeof data === "object") {
    if (data.ok === false) return { ok: false, detail: `script error: ${String(data.error ?? "").slice(0, 200)}` };
    if (/^(error|fail)/i.test(String(data.result ?? data.status ?? ""))) {
      return { ok: false, detail: `script answered ${JSON.stringify(data).slice(0, 200)}` };
    }
    // The health-check answer: the script received no fields, so no row was written.
    if (data.status === "listening") return { ok: false, detail: "script answered 'listening' — no fields arrived, no row written" };
    return { ok: true, detail: "" };
  }
  if (/<html|<!doctype/i.test(text) && /accounts\.google\.com|ServiceLogin|<title>\s*Error|Script function not found|Exception:|TypeError|ReferenceError|not have permission|unable to open the file/i.test(text)) {
    return { ok: false, detail: `Google returned an error/sign-in page: ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160)}` };
  }
  return { ok: true, detail: "" };
}

function emailHtml(lead, config) {
  const color = config.brandColor || "#10244C";
  const cell = "padding:8px 10px;border:1px solid #e2e8f0;vertical-align:top;";
  const row = (label, value) =>
    `<tr><td style="${cell}font-weight:bold;width:130px;">${esc(label)}</td><td style="${cell}">${value}</td></tr>`;
  const extras = (config.extraFields ?? [])
    .filter((f) => lead[f.name])
    .map((f) => row(f.label || f.name, esc(lead[f.name])))
    .join("");
  const sheet = config.leadsSheetUrl
    ? `<p style="margin:24px 0 0;"><a href="${esc(config.leadsSheetUrl)}" style="display:inline-block;background:${esc(color)};color:#fff;padding:12px 22px;font-weight:bold;text-decoration:none;border-radius:6px;">View all leads</a></p>`
    : "";
  return `<div style="font-family:Arial,sans-serif;max-width:560px;color:#111827;">
  <h2 style="color:${esc(color)};margin:0 0 16px;">New lead from the ${esc(config.businessName)} website</h2>
  <table style="border-collapse:collapse;width:100%;">
    ${row("Name", esc(lead.name))}
    ${row("Phone", `<a href="tel:+1${esc(lead.phoneDigits)}" style="font-weight:bold;">${esc(lead.phone)}</a>`)}
    ${row("Email", `<a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a>`)}
    ${extras}
    ${row("Message", `<span style="white-space:pre-wrap;">${esc(lead.message)}</span>`)}
    ${row("Page", lead.source ? `<a href="${esc(lead.source)}">${esc(lead.source)}</a>` : "Unknown")}
  </table>
  ${sheet}
</div>`;
}

async function deliverToSheet(site, config, lead, leadId) {
  const sheetWebhook = config.sheetWebhook ?? process.env.GOOGLE_SHEET_WEBHOOK;
  if (!sheetWebhook) {
    console.error(`[lead] ${site}: GOOGLE_SHEET_WEBHOOK is not set — lead not written to the sheet`);
    return { ok: false, configured: false, detail: "GOOGLE_SHEET_WEBHOOK not set" };
  }
  try {
    const base = { ...lead, leadId, submittedAt: new Date().toISOString() };
    delete base.phoneDigits;
    // Each client's Apps Script already expects particular keys (and some a GET with
    // query params). sheetPayload/sheetMethod adapt to it, so migrating a site never
    // means editing the client's own sheet script.
    const payload = config.sheetPayload ? config.sheetPayload(base) : base;
    const request =
      config.sheetMethod === "GET"
        ? {
            url: `${sheetWebhook}${sheetWebhook.includes("?") ? "&" : "?"}${new URLSearchParams(
              Object.entries(payload).map(([k, v]) => [k, String(v ?? "")])
            )}`,
            options: { method: "GET", redirect: "follow" },
          }
        : {
            url: sheetWebhook,
            options: {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              redirect: "follow",
            },
          };
    const res = await fetchWithTimeout(request.url, request.options, SHEET_TIMEOUT_MS);
    const verdict = await sheetAccepted(res);
    if (!verdict.ok) console.error(`[lead] ${site}: sheet did not record the lead — ${verdict.detail}`);
    return { ...verdict, configured: true };
  } catch (err) {
    console.error(`[lead] ${site}: sheet webhook error`, err);
    return { ok: false, configured: true, detail: `request failed: ${String(err?.name === "AbortError" ? "timed out" : err).slice(0, 160)}` };
  }
}

async function deliverByEmail(site, config, lead) {
  const apiKey = config.resendApiKey ?? process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error(`[lead] ${site}: RESEND_API_KEY is not set — lead email not sent`);
    return { ok: false, detail: "RESEND_API_KEY not set" };
  }
  try {
    const res = await fetchWithTimeout(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: config.from ?? `${config.businessName} Leads <leads@resend.getroundhouse.com>`,
          to: config.recipients,
          reply_to: lead.email,
          subject: `${config.subjectPrefix ?? ""}New Lead — ${lead.name} | ${config.businessName}`,
          html: emailHtml(lead, config),
        }),
      },
      EMAIL_TIMEOUT_MS
    );
    // Success means an id came back — a 401 or an exhausted quota returns an error body,
    // not an exception.
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.id) return { ok: true, detail: "", id: data.id };
    console.error(`[lead] ${site}: Resend rejected send (${res.status})`, JSON.stringify(data));
    return { ok: false, detail: `Resend ${res.status}: ${JSON.stringify(data).slice(0, 160)}` };
  } catch (err) {
    console.error(`[lead] ${site}: Resend send error`, err);
    return { ok: false, detail: `request failed: ${String(err?.name === "AbortError" ? "timed out" : err).slice(0, 160)}` };
  }
}

/**
 * @param {Request} req
 * @param {import("./lead").LeadConfig} config
 * @returns {Promise<Response>}
 */
export async function handleLead(req, config) {
  const {
    site,
    phone: businessPhone,
    allowedOrigins,
    extraFields = [],
    successPath = "/",
    nonLatin = true,
  } = config;

  let native = false;
  let lead = {};
  const monitor = isMonitorRequest(req);

  try {
    const parsed = await readBody(req);
    native = parsed.native;
    if (parsed.tooLarge) {
      // No fields are parsed, so there is nothing to show a visitor — and no real form
      // can produce this.
      await logBlocked({ site, layer: "too-large", matched: `${parsed.tooLarge} bytes (max ${MAX_BODY_BYTES})`, req });
      return native ? redirect(successPath) : json({ ok: true });
    }
    const body = parsed.body ?? {};

    lead = {
      name: str(body.name),
      phone: str(body.phone),
      email: str(body.email),
      message: str(body.message),
      // A native post from a no-JS visitor has no stamped source, so fall back to the
      // page the browser says it came from.
      source: str(body.source) || (native ? req.headers.get("referer") ?? "" : ""),
    };
    for (const f of extraFields) {
      lead[f.name] = f.checkbox ? (isChecked(body[f.name]) ? "Yes" : "") : str(body[f.name]);
    }
    lead.phoneDigits = normalizePhone(lead.phone);

    const logFields = {
      site,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      message: lead.message,
      source: lead.source,
      req,
    };

    const withhold = async (layer, matched = "") => {
      if (monitor) return json({ ok: true, monitor: { withheld: layer, matched } });
      await logBlocked({ ...logFields, layer, matched });
      return native ? redirect(successPath) : json({ ok: true });
    };

    // Things a delivered lead is flagged with in the central log. Never shown to the client.
    const flags = [];

    // 1. Posted from another website's page. A browser labels a request made from ANOTHER
    // site "cross-site"; our own form is "same-origin" (or "same-site" across a
    // subdomain). A missing header (Safari before 16.4) is fine.
    if ((req.headers.get("sec-fetch-site") ?? "").toLowerCase() === "cross-site") {
      return withhold("fetch-metadata", "sec-fetch-site: cross-site");
    }

    // 2. Automation signals.
    const { jsRan, openMs } = readOpenTime(body);
    const auto = automationSignals({ body, headers: req.headers, allowedOrigins, jsRan, openMs });
    if (auto.strong.length && auto.strong.length + auto.weak.length >= 2) {
      return withhold("automation", [...auto.strong, ...auto.weak].join(" | "));
    }
    flags.push(...auto.strong, ...auto.weak);

    // 3. Validation — visible, per field.
    const errors = validateLead(lead, extraFields);
    if (Object.keys(errors).length) {
      if (monitor) return json({ ok: false, errors, monitor: { validation: errors } }, 400);
      await logBlocked({
        ...logFields,
        layer: "validation",
        matched: Object.entries(errors).map(([k, v]) => `${k}: ${v}`).join(" | "),
      });
      if (native) {
        return htmlPage("Please fix the following", Object.values(errors), lead.source || "/", 400);
      }
      return json({ ok: false, errors }, 400);
    }

    // 4. Content. Cyrillic/Greek, keyword phrases, odd TLDs and gibberish are how real
    // customers sometimes write too — flagged. A confirmed spammer's domain or number is
    // withheld.
    const content = checkContent({
      name: lead.name,
      phone: lead.phoneDigits,
      message: lead.message,
      nonLatin,
      allowMessageUrls: true,
    });
    if (content.blocked) flags.push(`${content.layer}: ${content.reason}`);

    const verdict = checkSpam({ name: lead.name, email: lead.email, phone: lead.phone, message: lead.message });
    if (verdict.blocked) {
      if (WITHHELD_CONTENT_RULES.has(verdict.rule)) return withhold(verdict.rule, verdict.reason ?? "");
      flags.push(`${verdict.rule}: ${verdict.reason}`);
    }

    // 5. Double-click. Every field is in the key, so a resubmission that corrects the
    // address is delivered rather than swallowed.
    const dupeKey = [
      site,
      lead.phoneDigits,
      lead.name,
      lead.email,
      lead.message.slice(0, 200),
      ...extraFields.map((f) => lead[f.name] ?? ""),
    ].join("|");
    const dupe = isDuplicate(dupeKey);
    if (dupe) {
      return native ? redirect(`${successPath}?lead=${dupe.leadId}`) : json({ ok: true, delivered: true, leadId: dupe.leadId });
    }

    // 6. Rate limit — counted only here, after the checks above, so only submissions
    // that would reach the client count. An office, a property manager or a client
    // testing their own site can pass `limit`; that is flagged, not withheld. Only a
    // flood is withheld. The limiter allows the lead whenever it can't decide.
    if (config.rateLimit !== false && !monitor) {
      const ip = clientIp(req);
      const limit = config.rateLimit?.limit ?? DEFAULT_LIMIT;
      const floodLimit = Math.max(config.rateLimit?.floodLimit ?? DEFAULT_FLOOD_LIMIT, limit);
      const windowMs = (config.rateLimit?.windowMinutes ?? DEFAULT_WINDOW_MS / 60000) * 60000;
      const rl = await checkRateLimit(ip ? `${site}:${ip}` : "", { limit: floodLimit, windowMs });
      const describe = () =>
        `${rl.count} deliverable submissions from ${ip} within ${Math.round(windowMs / 60000)} min (${rl.store})`;
      if (!rl.allowed) return withhold("rate-limit-flood", `${describe()} — flood limit ${floodLimit}`);
      if (rl.count > limit) flags.push(`rate-limit: ${describe()} — over ${limit}`);
    }

    // 7. Record before anything can fail. If the function is killed mid-delivery, the
    // lead still exists in the Vercel runtime logs.
    const leadId = newLeadId();
    const record = { leadId, ...lead };
    delete record.phoneDigits;
    console.log(`[lead] ${monitor ? "MONITOR" : "RECEIVED"} ${site}`, JSON.stringify({ ...record, flags }));

    if (monitor) {
      const sheetConfigured = Boolean(config.sheetWebhook ?? process.env.GOOGLE_SHEET_WEBHOOK);
      const email = await deliverByEmail(site, { ...config, recipients: [MONITOR_EMAIL_SINK], subjectPrefix: "[MONITOR] " }, lead);
      return json({
        ok: true,
        delivered: false,
        monitor: {
          flags,
          email: email.ok ? "sent" : email.detail,
          emailId: email.id ?? "",
          sheetConfigured,
          blockedLogConfigured: Boolean(process.env.BLOCKED_LOG_WEBHOOK),
          clientRecipients: (config.recipients ?? []).length,
        },
      });
    }

    // 8. Deliver — in parallel, so a slow Apps Script can't eat the email's time.
    const [sheet, email] = await Promise.all([
      deliverToSheet(site, config, lead, leadId),
      deliverByEmail(site, config, lead),
    ]);

    // 9. Log what happened. Delivered rows carry Delivered = Yes in the central sheet.
    const logs = [];
    if (!email.ok && !sheet.ok) {
      console.error(`[lead] UNDELIVERED LEAD ${site}`, JSON.stringify(record));
      logs.push(
        logBlocked({
          ...logFields,
          layer: "delivery-failed",
          matched: `sheet: ${sheet.detail} | email: ${email.detail} — recover the lead from this row`,
        })
      );
    } else {
      if (!email.ok) {
        logs.push(
          logBlocked({
            ...logFields,
            layer: "delivered-email-failed",
            matched: `email failed (${email.detail}) — the client's sheet confirmed the row`,
          })
        );
      }
      if (!sheet.ok && sheet.configured) {
        logs.push(
          logBlocked({
            ...logFields,
            layer: "delivered-sheet-failed",
            matched: `sheet failed (${sheet.detail}) — the email was sent`,
          })
        );
      }
      if (flags.length) {
        logs.push(logBlocked({ ...logFields, layer: "delivered-flagged", matched: flags.join(" | ") }));
      }
    }
    await Promise.all(logs);

    if (!email.ok && !sheet.ok) {
      const msg = deliveryFailedMessage(businessPhone);
      return native
        ? htmlPage("We couldn't send your request", [msg], lead.source || "/", 500)
        : json({ ok: false, error: msg }, 500);
    }

    // Remembered only once the lead is actually captured, so a visitor retrying after a
    // failed delivery is delivered again rather than told it already went through.
    recent.set(dupeKey, { at: Date.now(), leadId });

    return native
      ? redirect(`${successPath}?lead=${leadId}`)
      : json({ ok: true, delivered: true, leadId });
  } catch (err) {
    console.error(`[lead] ${site}: unhandled error`, err, JSON.stringify(lead));
    const msg = deliveryFailedMessage(businessPhone);
    return native
      ? htmlPage("We couldn't send your request", [msg], "/", 500)
      : json({ ok: false, error: msg }, 500);
  }
}

export { STANDARD_FIELDS };
export default handleLead;
