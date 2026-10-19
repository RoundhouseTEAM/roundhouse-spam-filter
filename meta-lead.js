/**
 * Roundhouse Meta (Facebook / Instagram) instant-form lead handler — 2.24.0.
 *
 * Meta never emails form leads to anyone: they sit in the Page's Leads Center until
 * someone downloads them. This turns each one into the same lead a site's contact form
 * produces and sends it down the SAME delivery path (lead.js deliverLead): the full lead
 * in the Vercel logs first, then the client's sheet and the Resend email in parallel, and
 * the central Blocked Submissions log for flags and partial failures. A site's route is
 * config only:
 *
 *   import { handleMetaLead } from "@roundhouse/spam-filter/meta-lead";
 *   export const GET = (req: Request) => handleMetaLead(req, META_CONFIG);
 *   export const POST = (req: Request) => handleMetaLead(req, META_CONFIG);
 *
 * HOW META DELIVERS A LEAD
 * ────────────────────────
 *  GET   Once, when the webhook is set up: Meta sends hub.mode=subscribe,
 *        hub.verify_token and hub.challenge; we echo the challenge if the token matches.
 *  POST  For every lead: {"object":"page","entry":[{"changes":[{"field":"leadgen",
 *        "value":{"leadgen_id","page_id","form_id","ad_id","adgroup_id","created_time"}}]}]}
 *        signed with X-Hub-Signature-256 (HMAC-SHA256 of the raw body, app secret).
 *        The webhook carries no answers — the lead is fetched from the Graph API by
 *        leadgen_id with the system-user token.
 *
 * WHEN IN DOUBT, DELIVER IT
 * ─────────────────────────
 * A person tapped an ad on their own Facebook account and Meta already checked the
 * phone and email, so nothing here blocks on wording a customer could write:
 *  - Validation problems (a 7-digit phone, an empty answer) are FLAGS, never a block.
 *  - Answers the site wants a second look at (metaFlagAnswers, e.g. "No, a business")
 *    are delivered and flagged.
 *  - A signature that doesn't verify is flagged, not refused, when the lead itself
 *    fetches fine — the Graph fetch with our own token is what proves the lead is real,
 *    so a wrong META_APP_SECRET can't silently drop every lead. Only a bad signature
 *    whose lead id ALSO can't be read is refused (that request isn't from Meta).
 *  - Withheld only on the same hard evidence handleLead withholds on: a blocklisted
 *    email domain or phone, a bot template, a BLOCKED_KEYWORDS term, link markup.
 *  - A lead that can't be fetched is logged as "meta-fetch-failed" (always urgent) with
 *    every id needed to find it in Leads Center, and Meta is answered 500 so it retries.
 *
 * Meta's own Lead Ads Testing Tool sends real webhooks whose answers read
 * "<test lead: dummy data for …>"; those are delivered (that is how the setup is
 * verified) and flagged as test leads.
 *
 * Retries: Meta re-sends a webhook it didn't get a 200 for. A lead already captured on
 * this instance is not sent twice. Not a cross-instance guarantee — a rare duplicate
 * email costs a delete; a dropped lead costs a job.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { checkContent, findLinkMarkup, findBlockedTemplate, findBlockedKeyword, checkSpam, logBlocked } from "./index.js";
import { deliverLead, WITHHELD_CONTENT_RULES, MAX_BODY_BYTES } from "./lead.js";
import { afterResponse } from "./apps-script.js";
import { validateLead, normalizePhone } from "./validate.js";

export const DEFAULT_GRAPH_VERSION = "v23.0";
const GRAPH_TIMEOUT_MS = 10000;
const GRAPH_ATTEMPTS = 2;
const RECENT_WINDOW_MS = 6 * 60 * 60 * 1000;
const LEAD_FIELDS = "id,created_time,field_data,ad_id,ad_name,adset_name,campaign_name,form_id,platform,is_organic";

/** Meta's standard question keys, in the order they're tried. */
const NAME_KEYS = ["full_name", "name"];
const PHONE_KEYS = ["phone_number", "phone"];
const EMAIL_KEYS = ["email", "email_address"];
const ZIP_KEYS = ["zip_code", "zip", "post_code", "postal_code", "zipcode"];
const STANDARD_KEYS = new Set([...NAME_KEYS, "first_name", "last_name", ...PHONE_KEYS, ...EMAIL_KEYS].map((k) => normalizeKey(k)));

/** leadgen_id → { at, leadId } for leads captured on this instance. */
const recent = new Map();

function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

/** "Is this for your home?" and "is_this_for_your_home?" compare equal. */
export function normalizeKey(k) {
  return String(k ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** "is_this_for_your_home?" → "Is this for your home?" */
function humanize(key) {
  const s = String(key).replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Whether X-Hub-Signature-256 is the HMAC of this exact body. */
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret) return { ok: false, note: "META_APP_SECRET not set — signature unchecked" };
  const given = String(header ?? "");
  if (!given.startsWith("sha256=")) return { ok: false, note: "no X-Hub-Signature-256 header" };
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(given.slice(7), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, note: "X-Hub-Signature-256 did not match META_APP_SECRET" };
  }
  return { ok: true, note: "" };
}

/** Every leadgen change in a webhook body. */
export function leadgenChanges(body) {
  if (body?.object !== "page" || !Array.isArray(body.entry)) return [];
  const out = [];
  for (const entry of body.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.field === "leadgen" && change.value?.leadgen_id) out.push({ ...change.value, page_id: String(change.value.page_id ?? entry.id ?? "") });
    }
  }
  return out;
}

/**
 * Turns a Graph API lead into the lead shape handleLead delivers: name / phone / email /
 * message / source plus the site's extraFields. Answers mapped by `metaFields` fill an
 * extra field (or `message`); every other answer — ZIP included — becomes a
 * "Question: answer" line in the message, so nothing a person told us is lost and the
 * client's existing sheet columns hold all of it.
 *
 * @returns {{ lead: Record<string,string>, answers: Array<{key:string,label:string,value:string}> }}
 */
export function mapMetaLead(graphLead, config = {}) {
  const answers = (graphLead?.field_data ?? []).map((f) => ({
    key: String(f?.name ?? ""),
    label: humanize(f?.name ?? ""),
    value: (Array.isArray(f?.values) ? f.values : [f?.values]).filter((v) => v != null && v !== "").map(String).join(", ").trim(),
  }));
  const byKey = new Map(answers.map((a) => [normalizeKey(a.key), a]));
  const pick = (keys) => keys.map((k) => byKey.get(normalizeKey(k))?.value).find(Boolean) ?? "";

  const name = pick(NAME_KEYS) || [pick(["first_name"]), pick(["last_name"])].filter(Boolean).join(" ");
  const lead = { name, phone: pick(PHONE_KEYS), email: pick(EMAIL_KEYS), message: "", source: "" };
  for (const f of config.extraFields ?? []) lead[f.name] = "";

  const mapped = new Map(Object.entries(config.metaFields ?? {}).map(([k, v]) => [normalizeKey(k), v]));
  const lines = [];
  const zipKeys = new Set(ZIP_KEYS.map(normalizeKey));
  // ZIP first, then the custom questions in the order the form asks them.
  const ordered = [...answers.filter((a) => zipKeys.has(normalizeKey(a.key))), ...answers.filter((a) => !zipKeys.has(normalizeKey(a.key)))];
  for (const a of ordered) {
    const nk = normalizeKey(a.key);
    if (STANDARD_KEYS.has(nk)) continue;
    const target = mapped.get(nk);
    if (target && target !== "message") {
      lead[target] = a.value;
      continue;
    }
    if (!a.value) continue;
    const label = zipKeys.has(nk) ? "ZIP code" : (config.metaLabels?.[a.key] ?? a.label);
    lines.push(target === "message" ? a.value : `${label}: ${a.value}`);
  }
  lead.message = lines.join("\n");

  const ids = [graphLead?.form_id && `form ${graphLead.form_id}`, graphLead?.ad_id && `ad ${graphLead.ad_id}`].filter(Boolean);
  lead.source = ["Facebook lead form", ...ids].join(" · ") + (graphLead?.is_organic ? " (organic)" : "");
  return { lead, answers };
}

async function fetchGraphLead(leadgenId, { token, appSecret, graphVersion }) {
  if (!token) return { ok: false, detail: "META_LEAD_TOKEN not set" };
  const params = new URLSearchParams({ fields: LEAD_FIELDS });
  // Required when the app has "Require App Secret" on; harmless otherwise.
  if (appSecret) params.set("appsecret_proof", createHmac("sha256", appSecret).update(token).digest("hex"));
  const url = `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(leadgenId)}?${params}`;
  let detail = "";
  for (let attempt = 1; attempt <= GRAPH_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GRAPH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data?.field_data)) return { ok: true, lead: data };
      detail = `Graph ${res.status}: ${JSON.stringify(data?.error ?? data).slice(0, 200)}`;
      // A permission or bad-id answer won't change on a retry.
      if (res.status >= 400 && res.status < 500) break;
    } catch (err) {
      detail = `Graph request failed: ${String(err?.name === "AbortError" ? "timed out" : err).slice(0, 160)}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, detail };
}

function settings(config) {
  const pageIds = config.pageIds ?? String(process.env.META_PAGE_ID ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    appSecret: config.appSecret ?? process.env.META_APP_SECRET ?? "",
    verifyToken: config.verifyToken ?? process.env.META_VERIFY_TOKEN ?? "",
    token: config.accessToken ?? process.env.META_LEAD_TOKEN ?? "",
    graphVersion: config.graphVersion ?? DEFAULT_GRAPH_VERSION,
    pageIds: pageIds.map(String),
  };
}

/** The webhook-verification handshake. */
function answerChallenge(req, s, site) {
  const q = new URL(req.url).searchParams;
  if (!s.verifyToken) {
    console.error(`[meta-lead] ${site}: META_VERIFY_TOKEN is not set — cannot verify the webhook`);
    return text("verify token not configured", 403);
  }
  if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === s.verifyToken) {
    return text(q.get("hub.challenge") ?? "");
  }
  return text("forbidden", 403);
}

/**
 * One leadgen event, start to finish.
 * @returns {Promise<{ status: "captured"|"duplicate"|"withheld"|"skipped"|"forged"|"failed", leadId?: string }>}
 */
async function processLeadgen(change, ctx) {
  const { config, s, sig, req } = ctx;
  const { site } = config;
  const ref = `leadgen ${change.leadgen_id} · page ${change.page_id || "?"} · form ${change.form_id || "?"} · ad ${change.ad_id || "?"}`;

  if (s.pageIds.length && !s.pageIds.includes(String(change.page_id))) {
    // The app's single webhook URL receives every subscribed Page's leads. Another
    // client's lead must never reach this client.
    console.warn(`[meta-lead] ${site}: skipped a lead for another Page (${ref})`);
    await afterResponse(logBlocked({ site, layer: "meta-other-page", matched: `${ref} — not in pageIds ${s.pageIds.join(",")}`, source: "Facebook lead form", req }));
    return { status: "skipped" };
  }

  const seen = recent.get(change.leadgen_id);
  if (seen && Date.now() - seen.at < RECENT_WINDOW_MS) return { status: "duplicate", leadId: seen.leadId };

  const fetched = await fetchGraphLead(change.leadgen_id, s);
  if (!fetched.ok) {
    if (!sig.ok) {
      console.warn(`[meta-lead] ${site}: refused — ${sig.note}, and the lead could not be read (${fetched.detail}) (${ref})`);
      await afterResponse(logBlocked({ site, layer: "meta-signature", matched: `${sig.note}; ${fetched.detail}; ${ref}`, req }));
      return { status: "forged" };
    }
    console.error(`[meta-lead] ${site}: LEAD NOT FETCHED (${fetched.detail}) — download it from Meta Leads Center: ${ref}`);
    await afterResponse(
      logBlocked({
        site,
        layer: "meta-fetch-failed",
        matched: `${fetched.detail} — the lead is in Meta Business Suite → Leads Center; ${ref}`,
        source: "Facebook lead form",
        req,
      })
    );
    return { status: "failed" };
  }

  const g = fetched.lead;
  const { lead, answers } = mapMetaLead(g, config);
  lead.phoneDigits = normalizePhone(lead.phone);
  const extraFields = config.extraFields ?? [];
  const flags = [];
  if (!sig.ok) flags.push(`meta-signature: ${sig.note}`);

  if (answers.some((a) => /test lead: dummy data/i.test(a.value))) flags.push("Meta test lead (Lead Ads Testing Tool)");

  const flagAnswers = new Map(Object.entries(config.metaFlagAnswers ?? {}).map(([k, v]) => [normalizeKey(k), v.map((x) => String(x).toLowerCase().trim())]));
  for (const a of answers) {
    const watch = flagAnswers.get(normalizeKey(a.key));
    if (watch && watch.includes(a.value.toLowerCase().trim())) flags.push(`answer: ${a.label} = ${a.value}`);
  }

  // Validation only flags — Meta already checked the phone and email.
  const errors = validateLead(lead, extraFields);
  for (const [k, v] of Object.entries(errors)) flags.push(`validation: ${k}: ${v}`);

  const logFields = { site, name: lead.name, email: lead.email, phone: lead.phone, message: lead.message, source: lead.source, req };
  const withhold = async (layer, matched) => {
    console.warn(`[meta-lead] ${site}: withheld (${layer}: ${matched}) ${ref}`);
    await afterResponse(logBlocked({ ...logFields, layer, matched: `${matched} · ${ref}` }));
    return { status: "withheld" };
  };

  const typedText = [lead.name, lead.message, ...extraFields.map((f) => lead[f.name] ?? "")].join("\n");
  const markup = findLinkMarkup(typedText);
  if (markup) return withhold("link-markup", markup);
  const template = findBlockedTemplate(typedText);
  if (template) return withhold("template", template);
  const keyword =
    findBlockedKeyword([lead.message, ...extraFields.filter((f) => !f.hidden && !f.options).map((f) => lead[f.name] ?? "")].join("\n")) ||
    findBlockedKeyword(lead.name, { multiWordOnly: true });
  if (keyword) return withhold("blocked-keyword", keyword);

  const content = checkContent({ name: lead.name, phone: lead.phoneDigits, message: lead.message, nonLatin: config.nonLatin ?? true, allowMessageUrls: true });
  if (content.blocked) flags.push(`${content.layer}: ${content.reason}`);
  const verdict = checkSpam({ name: lead.name, email: lead.email, phone: lead.phone, message: lead.message });
  if (verdict.blocked) {
    if (WITHHELD_CONTENT_RULES.has(verdict.rule)) return withhold(verdict.rule, verdict.reason ?? "");
    flags.push(`${verdict.rule}: ${verdict.reason}`);
  }

  // Record before anything can fail.
  const leadId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const record = { leadId, ...lead };
  delete record.phoneDigits;
  const meta = {
    leadgenId: change.leadgen_id,
    pageId: change.page_id,
    formId: g.form_id ?? change.form_id ?? "",
    adId: g.ad_id ?? change.ad_id ?? "",
    adName: g.ad_name ?? "",
    campaign: g.campaign_name ?? "",
    platform: g.platform ?? "",
    createdTime: g.created_time ?? "",
  };
  console.log(`[lead] RECEIVED ${site} (Facebook lead form)`, JSON.stringify({ ...record, flags, meta }));

  const details = [
    ["Form ID", meta.formId],
    ["Ad", [meta.adName, meta.adId && `(${meta.adId})`].filter(Boolean).join(" ")],
    ["Campaign", meta.campaign],
    ["Platform", meta.platform],
    ["Meta lead ID", meta.leadgenId],
    ["Submitted", meta.createdTime],
  ].filter(([, v]) => v);

  const { captured } = await deliverLead({
    site,
    config,
    lead,
    leadId,
    record,
    flags,
    logFields,
    emailOpts: { heading: `New lead from the ${config.businessName} Facebook ad`, sourceLabel: "Source", details },
  });
  if (!captured) return { status: "failed", leadId };

  for (const [k, v] of recent) if (Date.now() - v.at > RECENT_WINDOW_MS) recent.delete(k);
  recent.set(change.leadgen_id, { at: Date.now(), leadId });
  return { status: "captured", leadId };
}

/**
 * The whole server side of a Meta instant-form webhook: GET is the verification
 * handshake, POST delivers each lead.
 *
 * @param {Request} req
 * @param {import("./meta-lead").MetaLeadConfig} config
 * @returns {Promise<Response>}
 */
export async function handleMetaLead(req, config) {
  const s = settings(config);
  const { site } = config;
  if (req.method === "GET") return answerChallenge(req, s, site);

  try {
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return text("too large", 413);
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return text("too large", 413);

    const sig = verifySignature(raw, req.headers.get("x-hub-signature-256"), s.appSecret);
    if (!sig.ok) console.warn(`[meta-lead] ${site}: ${sig.note}`);

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return text("bad request", 400);
    }
    const changes = leadgenChanges(body);
    if (!changes.length) return text("EVENT_RECEIVED");

    const results = await Promise.all(changes.map((c) => processLeadgen(c, { config, s, sig, req })));
    // Any lead that didn't reach the client → 500, so Meta re-sends the webhook (it
    // retries for hours). Leads already captured are not re-sent on the retry.
    if (results.some((r) => r.status === "failed")) return text("lead not delivered — retry", 500);
    if (results.every((r) => r.status === "forged")) return text("forbidden", 403);
    return text("EVENT_RECEIVED");
  } catch (err) {
    console.error(`[meta-lead] ${site}: unhandled error`, err);
    return text("error", 500);
  }
}

export function _resetMetaLeadMemory() {
  recent.clear();
}

export default handleMetaLead;
