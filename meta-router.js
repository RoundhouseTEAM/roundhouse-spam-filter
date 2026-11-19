/**
 * Roundhouse Meta lead-webhook router — 2.54.0.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A Meta app has ONE Page webhook URL, and every Page subscribed to the app sends its
 * leadgen events there. Our system-user token lives in one app, so once a second client
 * runs instant forms, one URL has to receive every client's leads and hand each to the
 * right site. That is this module. The router delivers nothing itself: each site's own
 * /api/meta-lead (handleMetaLead) still fetches the lead and delivers it with the site's
 * own sheet, recipients and fields, exactly as before.
 *
 *   import { routeMetaLead } from "@roundhouse/spam-filter/meta-router";
 *   const ROUTES = { "639041002619024": "https://simplyplumbingtn.com/api/meta-lead/" };
 *   export const GET = (req: Request) => routeMetaLead(req, { routes: ROUTES });
 *   export const POST = (req: Request) => routeMetaLead(req, { routes: ROUTES });
 *
 * HOW A WEBHOOK IS FORWARDED
 * ──────────────────────────
 *  - Every leadgen change is grouped by page_id → site URL.
 *  - One site gets the whole body → the ORIGINAL bytes and X-Hub-Signature-256 are
 *    forwarded untouched, so the site checks Meta's own signature.
 *  - A body that mixes Pages is split, one body per site. A split body is re-signed with
 *    the app secret ONLY when Meta's signature on the original verified; otherwise the
 *    original header is passed on, it fails at the site, and the site's usual rule
 *    applies (flagged if the lead still fetches with our token, refused if not). The
 *    router never launders an unsigned request into a signed one.
 *  - A site that answers non-2xx, or can't be reached, → the router answers 500 so Meta
 *    re-sends the webhook (it retries for hours). Sites skip leads they already captured.
 *  - A lead for a Page with no route → an URGENT "meta-unrouted" row in the central log
 *    with every id needed to find it in Leads Center; answered 200 (a retry can't help).
 */

import { createHmac } from "node:crypto";
import { logBlocked } from "./index.js";
import { verifySignature } from "./meta-lead.js";

const MAX_BODY_BYTES = 64 * 1024;
// The site fetches the lead, then waits on the client's Apps Script (up to ~25s) and
// Resend. Leave room for all of it inside a 60s function.
const DEFAULT_FORWARD_TIMEOUT_MS = 55000;
const SITE = "roundhouse-meta-router";

function text(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

function pageOf(entry, change) {
  return String(change?.value?.page_id ?? entry?.id ?? "");
}

/**
 * Splits a webhook body by destination.
 * @returns {{ groups: Map<string, { pages: Set<string>, entries: object[], count: number }>, unrouted: object[], total: number }}
 */
export function splitByRoute(body, routes) {
  const groups = new Map();
  const unrouted = [];
  let total = 0;
  if (body?.object !== "page" || !Array.isArray(body.entry)) return { groups, unrouted, total };
  for (const entry of body.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== "leadgen") continue;
      total++;
      const pageId = pageOf(entry, change);
      const url = routes[pageId];
      if (!url) {
        unrouted.push({ ...change.value, page_id: pageId });
        continue;
      }
      if (!groups.has(url)) groups.set(url, { pages: new Set(), entries: new Map(), count: 0 });
      const g = groups.get(url);
      g.pages.add(pageId);
      g.count++;
      // Keep each change inside a copy of its own entry, so the site sees Meta's shape.
      if (!g.entries.has(entry)) g.entries.set(entry, { ...entry, changes: [] });
      g.entries.get(entry).changes.push(change);
    }
  }
  for (const g of groups.values()) g.entries = [...g.entries.values()];
  return { groups, unrouted, total };
}

async function forward(url, rawBody, signature, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "Content-Type": "application/json", "X-Roundhouse-Meta-Router": "1" };
    if (signature) headers["X-Hub-Signature-256"] = signature;
    const res = await fetch(url, { method: "POST", headers, body: rawBody, signal: controller.signal });
    const answer = (await res.text().catch(() => "")).slice(0, 160);
    return { ok: res.ok, detail: `${res.status} ${answer}`.trim() };
  } catch (err) {
    return { ok: false, detail: String(err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : err).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole server side of the shared Meta webhook: GET is the verification handshake,
 * POST forwards each lead to its site.
 *
 * @param {Request} req
 * @param {import("./meta-router").MetaRouterConfig} config
 * @returns {Promise<Response>}
 */
export async function routeMetaLead(req, config) {
  const routes = Object.fromEntries(Object.entries(config.routes ?? {}).map(([k, v]) => [String(k), String(v)]));
  const appSecret = config.appSecret ?? process.env.META_APP_SECRET ?? "";
  const verifyToken = config.verifyToken ?? process.env.META_VERIFY_TOKEN ?? "";
  const timeoutMs = config.forwardTimeoutMs ?? DEFAULT_FORWARD_TIMEOUT_MS;

  if (req.method === "GET") {
    const q = new URL(req.url).searchParams;
    if (!verifyToken) return text("verify token not configured", 403);
    if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === verifyToken) return text(q.get("hub.challenge") ?? "");
    return text("forbidden", 403);
  }

  try {
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return text("too large", 413);
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return text("too large", 413);

    const header = req.headers.get("x-hub-signature-256");
    const sig = verifySignature(raw, header, appSecret);
    if (!sig.ok) console.warn(`[meta-router] ${sig.note}`);

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return text("bad request", 400);
    }

    const { groups, unrouted, total } = splitByRoute(body, routes);
    if (!total) return text("EVENT_RECEIVED");

    for (const u of unrouted) {
      const ref = `leadgen ${u.leadgen_id || "?"} · page ${u.page_id || "?"} · form ${u.form_id || "?"} · ad ${u.ad_id || "?"}`;
      console.error(`[meta-router] NO ROUTE for page ${u.page_id} — lead is only in Meta Leads Center: ${ref}`);
      await logBlocked({
        site: SITE,
        layer: "meta-unrouted",
        matched: `no site for this Page in the router's routes${sig.ok ? "" : ` (${sig.note})`} — download it from Meta Business Suite → Leads Center; ${ref}`,
        source: "Facebook lead form",
        req,
      });
    }

    const single = groups.size === 1 && !unrouted.length;
    const results = await Promise.all(
      [...groups].map(async ([url, g]) => {
        let payload = raw;
        let signature = header;
        if (!single) {
          payload = JSON.stringify({ ...body, entry: g.entries });
          signature = sig.ok ? `sha256=${createHmac("sha256", appSecret).update(payload, "utf8").digest("hex")}` : header;
        }
        const r = await forward(url, payload, signature, timeoutMs);
        const pages = [...g.pages].join(",");
        if (r.ok) {
          console.log(`[meta-router] forwarded ${g.count} lead(s) for page ${pages} → ${url} (${r.detail})`);
        } else {
          console.error(`[meta-router] FORWARD FAILED page ${pages} → ${url}: ${r.detail} — Meta will retry`);
          await logBlocked({
            site: SITE,
            layer: "meta-forward-failed",
            matched: `${url} answered ${r.detail}; page ${pages}; Meta re-sends the webhook — if this repeats, the leads are in Meta Leads Center`,
            source: "Facebook lead form",
            req,
          });
        }
        return r;
      })
    );

    if (results.some((r) => !r.ok)) return text("not delivered to every site — retry", 500);
    return text("EVENT_RECEIVED");
  } catch (err) {
    console.error("[meta-router] unhandled error", err);
    return text("error", 500);
  }
}

export default routeMetaLead;
