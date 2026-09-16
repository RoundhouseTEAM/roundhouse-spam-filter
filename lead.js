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
 * ORDER — every step, and why it is where it is
 * ─────────────────────────────────────────────
 *  1. Origin       wrong site → silent success, logged
 *  2. Timing       _ts present and under 1.5s → silent, logged. MISSING _ts never blocks.
 *  3. Honeypot     filled → silent, logged — UNLESS JS ran and the form was open 3s+,
 *                  which is browser autofill (Edge/Chrome ignore autocomplete="off"),
 *                  so it continues and is delivered.
 *  4. Validation   any fixable mistake → a VISIBLE message per field (validate.js).
 *                  Runs before the spam content checks so a real person is always told.
 *  5. Non-Latin    Cyrillic/Greek in name or message → silent, logged.
 *  6. Keyword list checkSpam() → silent, logged.
 *  7. Duplicate    same phone + message within 2 minutes (a double-click) → success,
 *                  not delivered twice.
 *  8. Deliver      client sheet FIRST, then the Resend email. Either one alone keeps
 *                  the lead. Both failing → the visitor is told to call, the full lead
 *                  is written to the Vercel logs and the central log.
 *
 * Silent steps return exactly the same response as a real lead EXCEPT `delivered`,
 * which is what the form fires Google Ads / GA conversions on — so blocked spam never
 * counts as a conversion.
 *
 * Works with both a fetch() JSON post (the shared form) and a native form post (a
 * visitor whose JavaScript never ran): JSON in → JSON out, form post in → redirect or a
 * plain HTML page out.
 */

import { checkOrigin, checkContent, checkSpam, logBlocked } from "./index.js";
import {
  validateLead,
  normalizePhone,
  deliveryFailedMessage,
  STANDARD_FIELDS,
} from "./validate.js";

const MIN_FILL_MS = 1500;
const AUTOFILL_MIN_OPEN_MS = 3000;
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
// Generous on purpose. Apps Script routinely takes 5–15s (cold start, script lock), and
// the 6s limit shipped in 2.0.0 aborted a real Power Construction sheet write on
// 2026-09-16. The pre-package routes had no timeout at all. These only stop a truly hung
// request from holding the visitor forever; routes set maxDuration = 60 to allow them.
const SHEET_TIMEOUT_MS = 25000;
const EMAIL_TIMEOUT_MS = 15000;

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
  if (type.includes("application/json")) {
    return { body: await req.json(), native: false };
  }
  const fd = await req.formData();
  const body = {};
  for (const [k, v] of fd.entries()) if (typeof v === "string") body[k] = v;
  return { body, native: true };
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

/**
 * @param {Request} req
 * @param {import("./lead").LeadConfig} config
 * @returns {Promise<Response>}
 */
export async function handleLead(req, config) {
  const {
    site,
    businessName,
    phone: businessPhone,
    allowedOrigins,
    recipients,
    extraFields = [],
    successPath = "/",
    nonLatin = true,
  } = config;

  let native = false;
  let lead = {};

  try {
    const parsed = await readBody(req);
    native = parsed.native;
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
    for (const f of extraFields) lead[f.name] = str(body[f.name]);
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

    const silent = async (layer, matched = "") => {
      await logBlocked({ ...logFields, layer, matched });
      return native ? redirect(successPath) : json({ ok: true });
    };

    // 1. Origin
    const origin = checkOrigin({
      origin: req.headers.get("origin") ?? "",
      referer: req.headers.get("referer") ?? "",
      allowed: allowedOrigins,
    });
    if (!origin.ok) return silent("origin", origin.reason);

    // 2. Timing. A missing token is a visitor whose JavaScript never ran — not a bot.
    const tsRaw = body._ts;
    const ts = typeof tsRaw === "number" ? tsRaw : parseInt(str(tsRaw) || "0", 10);
    const jsRan = ts > 0;
    const openMs = jsRan ? Date.now() - ts : 0;
    if (jsRan && openMs < MIN_FILL_MS) return silent("timing", `${openMs}ms after render`);

    // 3. Honeypot, autofill-aware. `website` is still read for forms not yet migrated.
    const honeypot = str(body.referral_code) || str(body.website);
    const honeypotAutofill = Boolean(honeypot) && jsRan && openMs >= AUTOFILL_MIN_OPEN_MS;
    if (honeypot && !honeypotAutofill) return silent("honeypot", `filled: ${honeypot.slice(0, 80)}`);

    // 4. Validation — visible, per field.
    const errors = validateLead(lead, extraFields);
    if (Object.keys(errors).length) {
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

    // 5. Non-Latin script (name + message). The phone/URL rules are validation now.
    const content = checkContent({
      name: lead.name,
      phone: lead.phoneDigits,
      message: lead.message,
      nonLatin,
      allowMessageUrls: true,
    });
    if (content.blocked) return silent(content.layer ?? "content", content.reason ?? "");

    // 6. Shared keyword / domain / phone blocklist.
    const verdict = checkSpam({ name: lead.name, email: lead.email, phone: lead.phone, message: lead.message });
    if (verdict.blocked) return silent(verdict.rule ?? "keyword", verdict.reason ?? "");

    // 7. Double-click.
    const dupeKey = `${site}|${lead.phoneDigits}|${lead.message.slice(0, 200)}`;
    const dupe = isDuplicate(dupeKey);
    if (dupe) {
      return native ? redirect(`${successPath}?lead=${dupe.leadId}`) : json({ ok: true, delivered: true, leadId: dupe.leadId });
    }
    const leadId = newLeadId();

    // Not blocks — recorded so they stay visible, marked Delivered in the log.
    if (honeypotAutofill) {
      await logBlocked({
        ...logFields,
        layer: "delivered-honeypot-autofill",
        matched: `honeypot filled (${honeypot.slice(0, 80)}), form open ${Math.round(openMs / 1000)}s — browser autofill`,
      });
    }
    if (!jsRan) {
      await logBlocked({ ...logFields, layer: "delivered-no-js", matched: "no _ts — JavaScript did not run" });
    }

    // 8a. Client sheet first — the cheapest, most durable record.
    const sheetWebhook = config.sheetWebhook ?? process.env.GOOGLE_SHEET_WEBHOOK;
    let sheetOk = false;
    if (!sheetWebhook) {
      console.error(`[lead] ${site}: GOOGLE_SHEET_WEBHOOK is not set — lead not written to the sheet`);
    } else {
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
        sheetOk = res.ok;
        if (!res.ok) console.error(`[lead] ${site}: sheet webhook returned ${res.status}`);
      } catch (err) {
        console.error(`[lead] ${site}: sheet webhook error`, err);
      }
    }

    // 8b. Email via the Resend REST API. Success means an id came back — a 401 or an
    // exhausted quota returns an error body, not an exception.
    const apiKey = config.resendApiKey ?? process.env.RESEND_API_KEY;
    let emailOk = false;
    if (!apiKey) {
      console.error(`[lead] ${site}: RESEND_API_KEY is not set — lead email not sent`);
    } else {
      try {
        const res = await fetchWithTimeout(
          "https://api.resend.com/emails",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: config.from ?? `${businessName} Leads <leads@resend.getroundhouse.com>`,
              to: recipients,
              reply_to: lead.email,
              subject: `New Lead — ${lead.name} | ${businessName}`,
              html: emailHtml(lead, config),
            }),
          },
          EMAIL_TIMEOUT_MS
        );
        const data = await res.json().catch(() => ({}));
        emailOk = res.ok && Boolean(data?.id);
        if (!emailOk) console.error(`[lead] ${site}: Resend rejected send (${res.status})`, JSON.stringify(data));
      } catch (err) {
        console.error(`[lead] ${site}: Resend send error`, err);
      }
    }

    if (!emailOk) {
      await logBlocked({
        ...logFields,
        layer: "delivery-failed",
        matched: sheetOk
          ? "email failed — the lead IS in the client's sheet"
          : "email AND sheet both failed — recover the lead from this row",
      });
    }

    if (!emailOk && !sheetOk) {
      // Last-resort record: the Vercel runtime logs, which don't depend on Google.
      console.error(`[lead] UNDELIVERED LEAD ${site}`, JSON.stringify({ leadId, ...lead }));
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
