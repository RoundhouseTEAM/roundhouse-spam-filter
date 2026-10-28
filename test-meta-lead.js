/**
 * Tests for meta-lead.js — Meta instant-form webhooks. Network calls (Graph API, client
 * sheet, Resend, central blocked log) are stubbed, so nothing real is sent.
 * Run with: npm test
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleMetaLead, mapMetaLead, verifySignature, leadgenChanges, _resetMetaLeadMemory } from "./meta-lead.js";

// ── Stubs ────────────────────────────────────────────────────────
const APP_SECRET = "app-secret-123";
const calls = { graph: [], sheet: [], email: [], blocked: [] };
const leads = new Map(); // leadgen_id → Graph lead
let graphBehaviour = "ok"; // "ok" | "denied" | "down"
let sheetBody = JSON.stringify({ ok: true });
let emailBehaviour = "ok"; // "ok" | "reject"

process.env.GOOGLE_SHEET_WEBHOOK = "https://sheet.test/exec";
process.env.RESEND_API_KEY = "re_test";
process.env.BLOCKED_LOG_WEBHOOK = "https://blocked.test/exec";

globalThis.fetch = async (url, options = {}) => {
  if (url.startsWith("https://graph.facebook.com/")) {
    const u = new URL(url);
    calls.graph.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), auth: options.headers?.Authorization });
    if (graphBehaviour === "down") throw new Error("network down");
    const id = decodeURIComponent(u.pathname.split("/").pop());
    if (graphBehaviour === "denied" || !leads.has(id)) {
      return new Response(JSON.stringify({ error: { message: "Unsupported get request", code: 100 } }), { status: 400 });
    }
    return new Response(JSON.stringify(leads.get(id)), { status: 200 });
  }
  const body = options.body ? JSON.parse(options.body) : {};
  if (url === "https://sheet.test/exec") {
    calls.sheet.push(body);
    return new Response(sheetBody, { status: 200 });
  }
  if (url === "https://api.resend.com/emails") {
    calls.email.push(body);
    if (emailBehaviour === "reject") return new Response(JSON.stringify({ name: "daily_quota_exceeded" }), { status: 429 });
    return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
  }
  if (url === "https://blocked.test/exec") {
    calls.blocked.push(body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const quiet = { warn: console.warn, error: console.error, log: console.log };
const consoleLines = [];
const capture = (...args) => consoleLines.push(args.map(String).join(" "));
console.warn = capture;
console.error = capture;
console.log = capture;

const PAGE_ID = "111222333";
const CONFIG = {
  site: "test-site",
  businessName: "Test Plumbing",
  phone: "(512) 555-0199",
  allowedOrigins: ["testplumbing.com", "localhost", ".vercel.app"],
  recipients: ["owner@testplumbing.com"],
  leadsSheetUrl: "https://docs.google.com/spreadsheets/d/x/edit",
  extraFields: [{ name: "service", label: "Service", hidden: true }],
  sheetPayload: ({ name, phone, email, service, message, source }) => ({ name, phone, email, service, message, source }),
  appSecret: APP_SECRET,
  verifyToken: "verify-me",
  accessToken: "EAAtoken",
  pageIds: [PAGE_ID],
  metaFields: { "What do you need help with?": "service" },
  metaFlagAnswers: { "is_this_for_your_home?": ["No, a business"] },
};

let seq = 0;
/** Registers a Graph lead and returns its leadgen id. */
function addLead(overrides = {}, fields = {}) {
  const id = `lead${++seq}`;
  const f = {
    full_name: "Jane Rivera",
    phone_number: "+16155550100",
    email: "jane@example.com",
    zip_code: "37130",
    "what_do_you_need_help_with?": "Water heater",
    "is_this_for_your_home?": "Yes, my home",
    ...fields,
  };
  leads.set(id, {
    id,
    created_time: "2026-10-19T15:00:00+0000",
    form_id: "form9",
    ad_id: "ad7",
    ad_name: "SP_Water-Heater",
    campaign_name: "SP_Leads_InstantForm_10.26",
    platform: "fb",
    is_organic: false,
    field_data: Object.entries(f).filter(([, v]) => v !== undefined).map(([name, v]) => ({ name, values: [v] })),
    ...overrides,
  });
  return id;
}

function webhookBody(ids, pageId = PAGE_ID) {
  return JSON.stringify({
    object: "page",
    entry: [
      {
        id: pageId,
        time: 1760886000,
        changes: ids.map((leadgen_id) => ({
          field: "leadgen",
          value: { leadgen_id, page_id: pageId, form_id: "form9", ad_id: "ad7", adgroup_id: "adset5", created_time: 1760886000 },
        })),
      },
    ],
  });
}

function sign(raw, secret = APP_SECRET) {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

function post(raw, { signature = sign(raw) } = {}) {
  const headers = { "content-type": "application/json" };
  if (signature) headers["x-hub-signature-256"] = signature;
  return new Request("https://www.testplumbing.com/api/meta-lead", { method: "POST", headers, body: raw });
}

function reset() {
  _resetMetaLeadMemory();
  for (const k of Object.keys(calls)) calls[k].length = 0;
  graphBehaviour = "ok";
  sheetBody = JSON.stringify({ ok: true });
  emailBehaviour = "ok";
  consoleLines.length = 0;
}

let passed = 0;
async function test(label, fn) {
  reset();
  try {
    await fn();
    passed++;
  } catch (err) {
    quiet.error(`FAIL: ${label}`);
    throw err;
  }
}

// ── Verification handshake ───────────────────────────────────────
await test("GET echoes hub.challenge when the verify token matches", async () => {
  const res = await handleMetaLead(
    new Request("https://x.test/api/meta-lead?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345"),
    CONFIG
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "12345");
});

await test("GET refuses a wrong token, and refuses everything when no token is configured", async () => {
  const wrong = await handleMetaLead(new Request("https://x.test/api/meta-lead?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1"), CONFIG);
  assert.equal(wrong.status, 403);
  const unset = await handleMetaLead(
    new Request("https://x.test/api/meta-lead?hub.mode=subscribe&hub.verify_token=&hub.challenge=1"),
    { ...CONFIG, verifyToken: "" }
  );
  assert.equal(unset.status, 403);
});

// ── Signature ────────────────────────────────────────────────────
await test("verifySignature: right secret passes; wrong secret, missing header and no secret fail", () => {
  const raw = '{"a":1}';
  assert.equal(verifySignature(raw, sign(raw), APP_SECRET).ok, true);
  assert.equal(verifySignature(raw, sign(raw, "other"), APP_SECRET).ok, false);
  assert.equal(verifySignature(raw, null, APP_SECRET).ok, false);
  assert.match(verifySignature(raw, sign(raw), "").note, /META_APP_SECRET not set/);
});

// ── Delivery ─────────────────────────────────────────────────────
await test("a lead is fetched by leadgen_id and delivered: sheet, email, nothing in the blocked log", async () => {
  const id = addLead();
  const res = await handleMetaLead(post(webhookBody([id])), CONFIG);
  assert.equal(res.status, 200);
  assert.equal(calls.graph.length, 1);
  assert.equal(calls.graph[0].path, `/v23.0/${id}`);
  assert.equal(calls.graph[0].auth, "Bearer EAAtoken");
  assert.ok(calls.graph[0].params.appsecret_proof, "appsecret_proof is sent");
  assert.ok(!("access_token" in calls.graph[0].params), "the token never goes in the URL");

  assert.equal(calls.sheet.length, 1);
  const row = calls.sheet[0];
  assert.equal(row.name, "Jane Rivera");
  assert.equal(row.phone, "+16155550100");
  assert.equal(row.email, "jane@example.com");
  assert.equal(row.service, "Water heater", "a mapped question fills its extra field");
  assert.match(row.message, /^ZIP code: 37130\nIs this for your home\?: Yes, my home$/);
  assert.equal(row.source, "Facebook lead form · form form9 · ad ad7");

  assert.equal(calls.email.length, 1);
  const email = calls.email[0];
  assert.equal(email.subject, "New Lead — Jane Rivera | Test Plumbing");
  assert.deepEqual(email.to, ["owner@testplumbing.com"]);
  assert.equal(email.reply_to, "jane@example.com");
  assert.match(email.html, /Facebook lead form/);
  assert.match(email.html, /form9/);
  assert.match(email.html, /SP_Water-Heater \(ad7\)/);
  assert.match(email.html, /tel:\+16155550100/);
  assert.equal(calls.blocked.length, 0);
});

await test("the full lead is written to the Vercel logs BEFORE delivery", async () => {
  const id = addLead();
  const real = globalThis.fetch;
  let loggedFirst = false;
  globalThis.fetch = async (url, o) => {
    if (url.includes("sheet") || url.includes("resend")) {
      loggedFirst ||= consoleLines.some((l) => l.includes("[lead] RECEIVED") && l.includes("Jane Rivera") && l.includes(id));
    }
    return real(url, o);
  };
  await handleMetaLead(post(webhookBody([id])), CONFIG);
  globalThis.fetch = real;
  assert.ok(loggedFirst);
});

await test('"No, a business" is delivered AND flagged — never withheld', async () => {
  const id = addLead({}, { "is_this_for_your_home?": "No, a business" });
  const res = await handleMetaLead(post(webhookBody([id])), CONFIG);
  assert.equal(res.status, 200);
  assert.equal(calls.email.length, 1);
  assert.equal(calls.sheet.length, 1);
  assert.equal(calls.blocked.length, 1);
  assert.equal(calls.blocked[0].layer, "delivered-flagged");
  assert.equal(calls.blocked[0].delivered, "Yes");
  assert.match(calls.blocked[0].matched, /Is this for your home\? = No, a business/);
});

await test("a short phone or missing email is delivered and flagged (Meta already checked them)", async () => {
  const id = addLead({}, { phone_number: "555-0100", email: undefined });
  const res = await handleMetaLead(post(webhookBody([id])), CONFIG);
  assert.equal(res.status, 200);
  assert.equal(calls.email.length, 1);
  assert.ok(!("reply_to" in calls.email[0]), "no reply_to without an email");
  assert.equal(calls.blocked[0].layer, "delivered-flagged");
  assert.match(calls.blocked[0].matched, /validation: phone/);
  assert.match(calls.blocked[0].matched, /validation: email/);
});

await test("first_name + last_name make the name; custom questions with no mapping go in the message", async () => {
  const id = addLead({}, { full_name: undefined, first_name: "Sam", last_name: "Okafor", "when_do_you_need_it?": "This week" });
  await handleMetaLead(post(webhookBody([id])), CONFIG);
  assert.equal(calls.sheet[0].name, "Sam Okafor");
  assert.match(calls.sheet[0].message, /When do you need it\?: This week/);
});

await test("Lead Ads Testing Tool dummy data is delivered and flagged as a test lead", async () => {
  const id = addLead({}, {
    full_name: "<test lead: dummy data for full_name>",
    phone_number: "<test lead: dummy data for phone_number>",
    email: "test@fb.com",
  });
  const res = await handleMetaLead(post(webhookBody([id])), CONFIG);
  assert.equal(res.status, 200);
  assert.equal(calls.email.length, 1);
  assert.match(calls.blocked[0].matched, /Meta test lead/);
});

await test("a bad signature is flagged but the lead is still delivered when it fetches", async () => {
  const id = addLead();
  const raw = webhookBody([id]);
  const res = await handleMetaLead(post(raw, { signature: sign(raw, "rotated-secret") }), CONFIG);
  assert.equal(res.status, 200);
  assert.equal(calls.email.length, 1);
  assert.match(calls.blocked[0].matched, /meta-signature/);
});

await test("a bad signature whose lead can't be read is refused (403) and logged, not alerted", async () => {
  const raw = webhookBody(["forged999"]);
  const res = await handleMetaLead(post(raw, { signature: "sha256=deadbeef" }), CONFIG);
  assert.equal(res.status, 403);
  assert.equal(calls.email.length, 0);
  assert.equal(calls.blocked.length, 1);
  assert.equal(calls.blocked[0].layer, "meta-signature");
  assert.equal(calls.blocked[0].urgent, "");
});

await test("a lead that can't be fetched → urgent meta-fetch-failed row with the ids, and 500 so Meta retries", async () => {
  const id = addLead();
  graphBehaviour = "denied";
  const res = await handleMetaLead(post(webhookBody([id])), CONFIG);
  assert.equal(res.status, 500);
  assert.equal(calls.email.length, 0);
  assert.equal(calls.blocked[0].layer, "meta-fetch-failed");
  assert.equal(calls.blocked[0].urgent, "yes");
  assert.match(calls.blocked[0].matched, new RegExp(`leadgen ${id}`));
  assert.match(calls.blocked[0].matched, /Leads Center/);
  assert.ok(consoleLines.some((l) => l.includes("LEAD NOT FETCHED")));
});

await test("Graph down: retried once, then meta-fetch-failed", async () => {
  const id = addLead();
  graphBehaviour = "down";
  const res = await handleMetaLead(post(webhookBody([id])), CONFIG);
  assert.equal(res.status, 500);
  assert.equal(calls.graph.length, 2);
  assert.equal(calls.blocked[0].layer, "meta-fetch-failed");
});

await test("no token configured → meta-fetch-failed naming the missing env var", async () => {
  const id = addLead();
  const res = await handleMetaLead(post(webhookBody([id])), { ...CONFIG, accessToken: "" , appSecret: APP_SECRET });
  // Falls back to process.env.META_LEAD_TOKEN, which is unset in tests.
  assert.equal(res.status, 500);
  assert.match(calls.blocked[0].matched, /META_LEAD_TOKEN not set/);
});

await test("both sheet and email failing → delivery-failed and 500; email-only failure still 200", async () => {
  const id = addLead();
  sheetBody = JSON.stringify({ ok: false, error: "boom" });
  emailBehaviour = "reject";
  const res = await handleMetaLead(post(webhookBody([id])), CONFIG);
  assert.equal(res.status, 500);
  assert.equal(calls.blocked.find((r) => r.layer === "delivery-failed")?.urgent, "yes");
  reset();
  const id2 = addLead();
  emailBehaviour = "reject";
  const ok = await handleMetaLead(post(webhookBody([id2])), CONFIG);
  assert.equal(ok.status, 200);
  assert.equal(calls.blocked[0].layer, "delivered-email-failed");
});

await test("Meta's retry of an already-captured lead is not delivered twice", async () => {
  const id = addLead();
  const raw = webhookBody([id]);
  await handleMetaLead(post(raw), CONFIG);
  const again = await handleMetaLead(post(raw), CONFIG);
  assert.equal(again.status, 200);
  assert.equal(calls.email.length, 1);
  assert.equal(calls.graph.length, 1);
});

await test("a failed lead IS delivered on Meta's retry", async () => {
  const id = addLead();
  graphBehaviour = "denied";
  await handleMetaLead(post(webhookBody([id])), CONFIG);
  graphBehaviour = "ok";
  const retry = await handleMetaLead(post(webhookBody([id])), CONFIG);
  assert.equal(retry.status, 200);
  assert.equal(calls.email.length, 1);
});

await test("a lead for another client's Page is skipped and logged, never delivered", async () => {
  const id = addLead();
  const res = await handleMetaLead(post(webhookBody([id], "999")), CONFIG);
  assert.equal(res.status, 200);
  assert.equal(calls.graph.length, 0);
  assert.equal(calls.email.length, 0);
  assert.equal(calls.blocked[0].layer, "meta-other-page");
});

await test("several leads in one webhook are each delivered", async () => {
  const a = addLead();
  const b = addLead({}, { full_name: "Pat Lee" });
  const res = await handleMetaLead(post(webhookBody([a, b])), CONFIG);
  assert.equal(res.status, 200);
  assert.equal(calls.email.length, 2);
  assert.deepEqual(calls.sheet.map((r) => r.name).sort(), ["Jane Rivera", "Pat Lee"]);
});

await test("hard withhold rules still apply: a blocklisted email domain is withheld and logged in full", async () => {
  const id = addLead({}, { email: "x@vettedvas.com" });
  const res = await handleMetaLead(post(webhookBody([id])), CONFIG);
  assert.equal(res.status, 200, "Meta is told it arrived, so it doesn't retry");
  assert.equal(calls.email.length, 0);
  assert.equal(calls.blocked[0].layer, "email-domain");
  assert.equal(calls.blocked[0].name, "Jane Rivera");
});

await test("a blocked name (Hame Walls) is withheld from a Meta lead too", async () => {
  const id = addLead({}, { full_name: "Hame Walls" });
  const res = await handleMetaLead(post(webhookBody([id])), CONFIG);
  assert.equal(res.status, 200);
  assert.equal(calls.email.length, 0);
  assert.equal(calls.blocked[0].layer, "blocked-name");
});

await test("non-leadgen webhooks and other objects are acknowledged and ignored", async () => {
  const raw = JSON.stringify({ object: "page", entry: [{ id: PAGE_ID, changes: [{ field: "feed", value: {} }] }] });
  const res = await handleMetaLead(post(raw), CONFIG);
  assert.equal(res.status, 200);
  assert.equal(calls.graph.length, 0);
  assert.deepEqual(leadgenChanges({ object: "user", entry: [] }), []);
});

await test("malformed JSON → 400, nothing sent", async () => {
  const res = await handleMetaLead(post("{nope"), CONFIG);
  assert.equal(res.status, 400);
  assert.equal(calls.email.length, 0);
});

await test("mapMetaLead: metaFields can route an answer into the message; organic leads say so", () => {
  const { lead } = mapMetaLead(
    {
      form_id: "f1",
      is_organic: true,
      field_data: [
        { name: "full_name", values: ["A B"] },
        { name: "describe_the_problem", values: ["Toilet running"] },
      ],
    },
    { metaFields: { describe_the_problem: "message" } }
  );
  assert.equal(lead.message, "Toilet running");
  assert.equal(lead.source, "Facebook lead form · form f1 (organic)");
});

console.warn = quiet.warn;
console.error = quiet.error;
console.log = quiet.log;
console.log(`meta-lead: ${passed} passed`);
