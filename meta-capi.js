/**
 * Meta Conversions API (CAPI) for a delivered website lead — 2.53.0.
 *
 * A site whose form is the destination of Facebook/Instagram ads sets `metaCapi` on its
 * LeadConfig. After a lead is DELIVERED (never a withheld, duplicate or monitor
 * submission), handleLead sends one server-side `Lead` event with `event_id` = the lead
 * id. The thank-you page fires the browser Pixel `Lead` with the same id as `eventID`
 * (see fireMetaLead in ./conversion), so Meta keeps one of the two and counts the lead
 * once — and still gets it when an ad blocker or iOS kills the browser pixel.
 *
 * Personal data is SHA-256 hashed before it leaves the server, as Meta requires.
 * This never throws and never delays the visitor: it runs after the response.
 * A failure is logged to the Vercel runtime logs as `[meta-capi] FAILED` — the lead
 * itself was already delivered, so it is not a lead loss and not a central-log row.
 */
import { createHash } from "node:crypto";

export const META_GRAPH_VERSION = "v21.0";
const TIMEOUT_MS = 8000;

const sha = (v) => createHash("sha256").update(v).digest("hex");

function readCookie(header, name) {
  for (const part of String(header ?? "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

/** `fbc` from the _fbc cookie, or built from an fbclid on the page address. */
export function fbcFrom(cookieHeader, sourceUrl, now = Date.now()) {
  const cookie = readCookie(cookieHeader, "_fbc");
  if (cookie) return cookie;
  try {
    const id = new URL(sourceUrl).searchParams.get("fbclid");
    if (id) return `fb.1.${now}.${id}`;
  } catch {
    /* no usable URL */
  }
  return "";
}

/**
 * The user_data block: hashed contact fields, plus the unhashed browser identifiers Meta
 * matches on (IP, user agent, _fbp, _fbc).
 */
export function metaUserData({ lead, ip, userAgent, cookieHeader, zipField = "zip", extra = {} }) {
  const ud = {};
  const email = String(lead.email ?? "").trim().toLowerCase();
  if (email) ud.em = [sha(email)];
  let digits = String(lead.phone ?? "").replace(/\D/g, "");
  if (digits.length === 10) digits = `1${digits}`;
  if (digits) ud.ph = [sha(digits)];
  const parts = String(lead.name ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length) ud.fn = [sha(parts[0])];
  if (parts.length > 1) ud.ln = [sha(parts[parts.length - 1])];
  const zip = String(lead[zipField] ?? "").trim().slice(0, 5);
  if (/^\d{5}$/.test(zip)) ud.zp = [sha(zip)];
  for (const [k, v] of Object.entries(extra)) {
    const val = String(v ?? "").trim().toLowerCase();
    if (val) ud[k] = [sha(val)];
  }
  if (ip) ud.client_ip_address = ip;
  if (userAgent) ud.client_user_agent = userAgent;
  const fbp = readCookie(cookieHeader, "_fbp");
  if (fbp) ud.fbp = fbp;
  const fbc = fbcFrom(cookieHeader, lead.source);
  if (fbc) ud.fbc = fbc;
  return ud;
}

/**
 * Sends one Lead event. Resolves { ok, detail } — never rejects.
 *
 * @param {object} input
 * @param {import("./lead").MetaCapiConfig} input.config
 * @param {Record<string, string>} input.lead
 * @param {string} input.leadId
 * @param {string} input.site
 * @param {string} [input.ip]
 * @param {string} [input.userAgent]
 * @param {string} [input.cookieHeader]
 */
export async function sendMetaLead({ config, lead, leadId, site, ip = "", userAgent = "", cookieHeader = "" }) {
  const pixelId = config.pixelId ?? process.env.META_PIXEL_ID ?? process.env.NEXT_PUBLIC_META_PIXEL_ID;
  const token = config.accessToken ?? process.env.META_CAPI_TOKEN;
  if (!pixelId || !token) {
    console.warn(`[meta-capi] SKIPPED ${site}: ${!pixelId ? "no pixel id" : "no META_CAPI_TOKEN"} — lead ${leadId}`);
    return { ok: false, detail: "not configured" };
  }
  const event = {
    event_name: config.eventName ?? "Lead",
    event_time: Math.floor(Date.now() / 1000),
    event_id: leadId,
    action_source: "website",
    user_data: metaUserData({ lead, ip, userAgent, cookieHeader, zipField: config.zipField, extra: config.userData }),
  };
  if (lead.source) event.event_source_url = lead.source;
  const payload = { data: [event] };
  const testCode = config.testEventCode ?? process.env.META_TEST_EVENT_CODE;
  if (testCode) payload.test_event_code = testCode;

  const url = `https://graph.facebook.com/${config.apiVersion ?? META_GRAPH_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    // Success is events_received: 1, not just HTTP 200.
    if (res.ok && data.events_received >= 1) {
      console.log(`[meta-capi] SENT ${site} lead ${leadId}${testCode ? " (test event)" : ""}`);
      return { ok: true, detail: "sent" };
    }
    const detail = `HTTP ${res.status}: ${(data.error?.message ?? text).slice(0, 300)}`;
    console.error(`[meta-capi] FAILED ${site} lead ${leadId} — ${detail}`);
    return { ok: false, detail };
  } catch (err) {
    const detail = String(err?.message ?? err);
    console.error(`[meta-capi] FAILED ${site} lead ${leadId} — ${detail}`);
    return { ok: false, detail };
  }
}
