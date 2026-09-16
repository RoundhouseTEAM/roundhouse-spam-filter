/**
 * Tests for lead.js — the shared server handler. Network calls (client sheet, Resend,
 * central blocked log) are stubbed, so nothing real is sent. Run with: npm test
 */
import assert from "node:assert/strict";
import { handleLead, MAX_BODY_BYTES } from "./lead.js";
import { _resetRateLimitMemory } from "./ratelimit.js";
import { MESSAGES } from "./validate.js";

// ── Stubs ────────────────────────────────────────────────────────
const calls = { sheet: [], email: [], blocked: [] };
let sheetStatus = 200;
let emailBehaviour = "ok"; // "ok" | "reject" | "throw"
let redisBehaviour = "ok"; // "ok" | "down"
let redisCount = 0;

process.env.GOOGLE_SHEET_WEBHOOK = "https://sheet.test/exec";
process.env.RESEND_API_KEY = "re_test";
process.env.BLOCKED_LOG_WEBHOOK = "https://blocked.test/exec";

globalThis.fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : {};
  if (url === "https://sheet.test/exec") {
    calls.sheet.push(body);
    return new Response("ok", { status: sheetStatus });
  }
  if (url.startsWith("https://sheet.test/exec?")) {
    calls.sheet.push({ method: options.method, query: Object.fromEntries(new URL(url).searchParams) });
    return new Response("ok", { status: sheetStatus });
  }
  if (url === "https://api.resend.com/emails") {
    calls.email.push(body);
    if (emailBehaviour === "throw") throw new Error("network down");
    if (emailBehaviour === "reject") {
      return new Response(JSON.stringify({ name: "daily_quota_exceeded" }), { status: 429 });
    }
    return new Response(JSON.stringify({ id: "email_123" }), { status: 200 });
  }
  if (url === "https://redis.test/pipeline") {
    calls.redis = (calls.redis ?? 0) + 1;
    if (redisBehaviour === "down") return new Response("oops", { status: 500 });
    redisCount += 1;
    return new Response(JSON.stringify([{ result: redisCount }, { result: 1 }]), { status: 200 });
  }
  if (url === "https://blocked.test/exec") {
    calls.blocked.push(body);
    return new Response("ok", { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

// Keep test output readable — the handler logs failures on purpose.
const quiet = { warn: console.warn, error: console.error };
console.warn = () => {};
console.error = () => {};

const CONFIG = {
  site: "test-site",
  businessName: "Test Plumbing",
  phone: "(512) 555-0199",
  allowedOrigins: ["testplumbing.com", "localhost", ".vercel.app"],
  recipients: ["owner@testplumbing.com"],
  leadsSheetUrl: "https://docs.google.com/spreadsheets/d/x/edit",
  extraFields: [{ name: "address", label: "Address" }],
  successPath: "/thank-you",
};

let seq = 0;
function goodLead(overrides = {}) {
  seq++;
  return {
    name: "Jane Rivera",
    phone: "(512) 555-0100",
    email: "jane@example.com",
    // Unique per test so the double-click guard doesn't merge separate tests.
    message: `Water heater leaking, case ${seq}`,
    address: "12 Main St",
    source: "https://www.testplumbing.com/contact",
    _ts: Date.now() - 10_000,
    ...overrides,
  };
}

function jsonReq(body, headers = {}) {
  return new Request("https://www.testplumbing.com/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://www.testplumbing.com", ...headers },
    body: JSON.stringify(body),
  });
}

function nativeReq(fields, headers = {}) {
  return new Request("https://www.testplumbing.com/api/contact", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      referer: "https://www.testplumbing.com/contact",
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function reset() {
  _resetRateLimitMemory();
  redisCount = 0;
  redisBehaviour = "ok";
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  calls.sheet.length = 0;
  calls.email.length = 0;
  calls.blocked.length = 0;
  sheetStatus = 200;
  emailBehaviour = "ok";
}

let passed = 0;
async function test(label, fn) {
  reset();
  try {
    await fn();
    passed++;
  } catch (err) {
    console.log = quiet.warn;
    quiet.error(`FAIL: ${label}`);
    throw err;
  }
}

// ── Delivery ─────────────────────────────────────────────────────
await test("a good lead is delivered: sheet, email, delivered flag, leadId", async () => {
  const res = await handleLead(jsonReq(goodLead()), CONFIG);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.delivered, true);
  assert.ok(data.leadId);
  assert.equal(calls.sheet.length, 1);
  assert.equal(calls.sheet[0].address, "12 Main St");
  assert.equal(calls.sheet[0].leadId, data.leadId);
  assert.equal(calls.email.length, 1);
  assert.deepEqual(calls.email[0].to, ["owner@testplumbing.com"]);
  assert.equal(calls.email[0].reply_to, "jane@example.com");
  assert.ok(!calls.email[0].subject.includes("Unverified"), "no Unverified subject");
  assert.equal(calls.blocked.length, 0, "a clean lead writes nothing to the blocked log");
});

await test("the sheet is written BEFORE the email", async () => {
  const order = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    order.push(url.includes("sheet") ? "sheet" : url.includes("resend") ? "email" : "other");
    return real(url, o);
  };
  await handleLead(jsonReq(goodLead()), CONFIG);
  globalThis.fetch = real;
  assert.deepEqual(order.filter((o) => o !== "other"), ["sheet", "email"]);
});

await test("email HTML escapes visitor input", async () => {
  await handleLead(jsonReq(goodLead({ message: "<script>alert(1)</script> leak" })), CONFIG);
  assert.ok(!calls.email[0].html.includes("<script>"));
  assert.ok(calls.email[0].html.includes("&lt;script&gt;"));
});

// ── Silent blocks ────────────────────────────────────────────────
for (const [label, body, headers, layer] of [
  ["wrong origin", goodLead(), { origin: "https://evil.example" }, "origin"],
  ["too fast", goodLead({ _ts: Date.now() - 200 }), {}, "timing"],
  ["honeypot filled by a bot (no JS)", goodLead({ _ts: undefined, referral_code: "http://spam" }), {}, "honeypot"],
  ["honeypot filled under 3s", goodLead({ _ts: Date.now() - 2000, referral_code: "x" }), {}, "honeypot"],
  ["Cyrillic", goodLead({ message: "Здравствуйте, аудит сайта" }), {}, "content:non-latin"],
  ["keyword", goodLead({ message: "We offer virtual assistants for your team" }), {}, "keyword:virtualAssistant"],
  ["blocklisted phone", goodLead({ phone: "307-207-6448" }), {}, "phone"],
]) {
  await test(`silent block: ${label}`, async () => {
    const res = await handleLead(jsonReq(body, headers), CONFIG);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(data, { ok: true }, "same success shape, but no delivered flag");
    assert.equal(calls.sheet.length, 0);
    assert.equal(calls.email.length, 0);
    assert.equal(calls.blocked.length, 1);
    assert.equal(calls.blocked[0].layer, layer);
    assert.equal(calls.blocked[0].delivered, "");
  });
}

// ── Visible validation ───────────────────────────────────────────
await test("validation: short phone gets a visible message, not a silent block", async () => {
  const res = await handleLead(jsonReq(goodLead({ phone: "5551" })), CONFIG);
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.deepEqual(data.errors, { phone: MESSAGES.phoneLength });
  assert.equal(calls.email.length, 0);
});

await test("validation: every missing field reported at once", async () => {
  const res = await handleLead(jsonReq({ _ts: Date.now() - 10_000 }), CONFIG);
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(data.errors).sort(), ["address", "email", "message", "name", "phone"], "visible extra fields are required too");
});

await test("validation: a link in the name is visible; a link in the message is allowed", async () => {
  const bad = await handleLead(jsonReq(goodLead({ name: "www.seo.com" })), CONFIG);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).errors.name, MESSAGES.nameHasLink);

  reset();
  const ok = await handleLead(
    jsonReq(goodLead({ message: "The house is here https://maps.google.com/?q=12+Main" })),
    CONFIG
  );
  assert.equal((await ok.json()).delivered, true);
});

await test("validation: message over 600 characters", async () => {
  const res = await handleLead(jsonReq(goodLead({ message: "x".repeat(601) })), CONFIG);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errors.message, MESSAGES.messageTooLong);
});

// ── Delivered but recorded ───────────────────────────────────────
await test("autofill: honeypot filled, JS ran, open 3s+ → delivered, logged Delivered=Yes", async () => {
  const res = await handleLead(jsonReq(goodLead({ referral_code: "DLNR DOBOR" })), CONFIG);
  const data = await res.json();
  assert.equal(data.delivered, true);
  assert.equal(calls.email.length, 1);
  assert.equal(calls.blocked.length, 1);
  assert.equal(calls.blocked[0].layer, "delivered-honeypot-autofill");
  assert.equal(calls.blocked[0].delivered, "Yes");
  assert.equal(calls.blocked[0].urgent, "", "a delivered lead never raises an urgent alert");
});

await test("no _ts (JS never ran) → delivered, normal subject, logged Delivered=Yes", async () => {
  const res = await handleLead(jsonReq(goodLead({ _ts: undefined })), CONFIG);
  assert.equal((await res.json()).delivered, true);
  assert.ok(!calls.email[0].subject.includes("Unverified"));
  assert.equal(calls.blocked[0].layer, "delivered-no-js");
  assert.equal(calls.blocked[0].delivered, "Yes");
});

// ── Failure handling ─────────────────────────────────────────────
await test("email rejected (quota) but sheet ok → still delivered, delivery-failed logged", async () => {
  emailBehaviour = "reject";
  const res = await handleLead(jsonReq(goodLead()), CONFIG);
  assert.equal((await res.json()).delivered, true);
  assert.equal(calls.blocked[0].layer, "delivery-failed");
  assert.match(calls.blocked[0].matched, /IS in the client's sheet/);
});

await test("sheet down but email ok → delivered", async () => {
  sheetStatus = 500;
  const res = await handleLead(jsonReq(goodLead()), CONFIG);
  assert.equal((await res.json()).delivered, true);
  assert.equal(calls.blocked.length, 0);
});

await test("sheet AND email fail → visitor told to call, lead in the blocked log", async () => {
  sheetStatus = 500;
  emailBehaviour = "throw";
  const res = await handleLead(jsonReq(goodLead()), CONFIG);
  const data = await res.json();
  assert.equal(res.status, 500);
  assert.equal(data.ok, false);
  assert.match(data.error, /\(512\) 555-0199/);
  assert.equal(calls.blocked[0].layer, "delivery-failed");
});

await test("a retry after a total failure is delivered, not treated as a duplicate", async () => {
  const body = goodLead();
  sheetStatus = 500;
  emailBehaviour = "throw";
  await handleLead(jsonReq(body), CONFIG);
  reset();
  const res = await handleLead(jsonReq(body), CONFIG);
  assert.equal((await res.json()).delivered, true);
  assert.equal(calls.email.length, 1);
});

await test("double-click: second identical submission is not delivered twice", async () => {
  const body = goodLead();
  const first = await (await handleLead(jsonReq(body), CONFIG)).json();
  const second = await (await handleLead(jsonReq(body), CONFIG)).json();
  assert.equal(second.delivered, true);
  assert.equal(second.leadId, first.leadId, "same leadId, so Ads dedupes too");
  assert.equal(calls.email.length, 1);
  assert.equal(calls.sheet.length, 1);
});

// ── Adapting to each client's existing Apps Script ───────────────
await test("sheetMethod GET sends the row as query params", async () => {
  await handleLead(jsonReq(goodLead()), { ...CONFIG, sheetMethod: "GET" });
  assert.equal(calls.sheet.length, 1);
  assert.equal(calls.sheet[0].method, "GET");
  assert.equal(calls.sheet[0].query.name, "Jane Rivera");
  assert.equal(calls.sheet[0].query.address, "12 Main St");
});

await test("sheetPayload reshapes the row (rename keys, add a constant)", async () => {
  await handleLead(jsonReq(goodLead()), {
    ...CONFIG,
    sheetMethod: "GET",
    sheetPayload: (l) => ({ sheet: "Brandon Google Ads", name: l.name, phone: l.phone, pageUrl: l.source }),
  });
  assert.deepEqual(calls.sheet[0].query, {
    sheet: "Brandon Google Ads",
    name: "Jane Rivera",
    phone: "(512) 555-0100",
    pageUrl: "https://www.testplumbing.com/contact",
  });
});

await test("a visible extra field left blank is rejected with a visible message", async () => {
  const res = await handleLead(jsonReq(goodLead({ address: "" })), CONFIG);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errors.address, "Please enter your address.");
  assert.equal(calls.email.length, 0);
});

await test("a hidden per-page value (declared as an extra field) reaches sheet and email", async () => {
  const cfg = { ...CONFIG, extraFields: [...CONFIG.extraFields, { name: "service", label: "Service", hidden: true }] };
  await handleLead(jsonReq(goodLead({ service: "Water heater replacement" })), cfg);
  assert.equal(calls.sheet[0].service, "Water heater replacement");
  assert.ok(calls.email[0].html.includes("Water heater replacement"));
});

await test("consent checkbox: unchecked → visible 400; checked → 'Yes' in sheet and email", async () => {
  const cfg = {
    ...CONFIG,
    extraFields: [...CONFIG.extraFields, { name: "consent", label: "Consent to contact", checkbox: true, required: true }],
  };
  const bad = await handleLead(jsonReq(goodLead()), cfg);
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).errors.consent);
  assert.equal(calls.email.length, 0);

  reset();
  const ok = await handleLead(jsonReq(goodLead({ consent: "yes" })), cfg);
  assert.equal((await ok.json()).delivered, true);
  assert.equal(calls.sheet[0].consent, "Yes");
  assert.ok(calls.email[0].html.includes("Consent to contact"));
});

await test("subjectPrefix is prepended to the email subject", async () => {
  await handleLead(jsonReq(goodLead()), { ...CONFIG, subjectPrefix: "[TEST] " });
  assert.ok(calls.email[0].subject.startsWith("[TEST] New Lead — "));
});

await test("a hidden extra field that is absent never blocks a lead", async () => {
  const cfg = { ...CONFIG, extraFields: [...CONFIG.extraFields, { name: "service", label: "Service", hidden: true }] };
  const res = await handleLead(jsonReq(goodLead()), cfg);
  assert.equal((await res.json()).delivered, true);
});

// ── Request size, Fetch Metadata, rate limiting ─────────────────
await test("oversized body (actual bytes) → silent, logged too-large, nothing delivered", async () => {
  const res = await handleLead(jsonReq(goodLead({ message: "x".repeat(MAX_BODY_BYTES) })), CONFIG);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(calls.email.length, 0);
  assert.equal(calls.sheet.length, 0);
  assert.equal(calls.blocked[0].layer, "too-large");
});

await test("oversized declared Content-Length → rejected without reading the body", async () => {
  const req = new Request("https://www.testplumbing.com/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://www.testplumbing.com", "content-length": String(MAX_BODY_BYTES + 1) },
    body: JSON.stringify(goodLead()),
  });
  assert.deepEqual(await (await handleLead(req, CONFIG)).json(), { ok: true });
  assert.equal(calls.email.length, 0);
  assert.equal(calls.blocked[0].layer, "too-large");
});

await test("the largest possible real lead is far under the size cap and delivered", async () => {
  const big = goodLead({
    name: "N".repeat(100),
    email: `${"e".repeat(240)}@example.com`,
    message: "M".repeat(600),
    address: "A".repeat(200),
    source: `https://www.testplumbing.com/lp/water-heater?gclid=${"g".repeat(900)}&gbraid=${"b".repeat(300)}`,
  });
  assert.ok(JSON.stringify(big).length < 10_000);
  assert.equal((await (await handleLead(jsonReq(big), CONFIG)).json()).delivered, true);
});

await test("Sec-Fetch-Site: cross-site → silent, logged fetch-metadata", async () => {
  const res = await handleLead(jsonReq(goodLead(), { "sec-fetch-site": "cross-site" }), CONFIG);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(calls.email.length, 0);
  assert.equal(calls.blocked[0].layer, "fetch-metadata");
});

await test("Sec-Fetch-Site missing (older Safari), same-origin or same-site → delivered", async () => {
  for (const headers of [{}, { "sec-fetch-site": "same-origin" }, { "sec-fetch-site": "same-site" }]) {
    reset();
    const res = await handleLead(jsonReq(goodLead(), headers), CONFIG);
    assert.equal((await res.json()).delivered, true, JSON.stringify(headers));
  }
});

await test("rate limit: 5 real leads from one IP delivered, the 6th is silent and logged with the full lead", async () => {
  const ipHeaders = { "x-forwarded-for": "203.0.113.7" };
  for (let i = 0; i < 5; i++) {
    const r = await handleLead(jsonReq(goodLead(), ipHeaders), CONFIG);
    assert.equal((await r.json()).delivered, true, `lead ${i + 1}`);
  }
  const sixth = await handleLead(jsonReq(goodLead({ name: "Sixth Person" }), ipHeaders), CONFIG);
  assert.deepEqual(await sixth.json(), { ok: true });
  assert.equal(calls.email.length, 5);
  const row = calls.blocked.find((b) => b.layer === "rate-limit");
  assert.ok(row, "rate-limit row logged");
  assert.equal(row.name, "Sixth Person", "the full lead is kept in the log");
  assert.equal(row.urgent, "yes", "a real-looking lead over the limit raises the urgent alert");
});

await test("rate limit: a different IP is unaffected; unknown IP is never limited", async () => {
  for (let i = 0; i < 6; i++) await handleLead(jsonReq(goodLead(), { "x-forwarded-for": "203.0.113.7" }), CONFIG);
  const other = await handleLead(jsonReq(goodLead(), { "x-forwarded-for": "198.51.100.9" }), CONFIG);
  assert.equal((await other.json()).delivered, true);
  reset();
  for (let i = 0; i < 8; i++) {
    const r = await handleLead(jsonReq(goodLead()), CONFIG);
    assert.equal((await r.json()).delivered, true, "no IP header → never limited");
  }
});

await test("rate limit: blocked spam and validation errors never count toward the limit", async () => {
  const ipHeaders = { "x-forwarded-for": "203.0.113.50" };
  for (let i = 0; i < 10; i++) await handleLead(jsonReq(goodLead({ message: "seo audit for your site" }), ipHeaders), CONFIG);
  for (let i = 0; i < 10; i++) await handleLead(jsonReq(goodLead({ phone: "555" }), ipHeaders), CONFIG);
  const real = await handleLead(jsonReq(goodLead(), ipHeaders), CONFIG);
  assert.equal((await real.json()).delivered, true);
});

await test("rate limit: uses Upstash when configured; falls back to memory when Upstash is down", async () => {
  process.env.UPSTASH_REDIS_REST_URL = "https://redis.test";
  process.env.UPSTASH_REDIS_REST_TOKEN = "tok";
  const ipHeaders = { "x-forwarded-for": "203.0.113.99" };
  await handleLead(jsonReq(goodLead(), ipHeaders), CONFIG);
  assert.equal(calls.redis, 1);
  redisBehaviour = "down";
  const r = await handleLead(jsonReq(goodLead(), ipHeaders), CONFIG);
  assert.equal((await r.json()).delivered, true, "a store outage never blocks a lead");
  calls.redis = 0;
});

await test("rate limit can be disabled per site", async () => {
  for (let i = 0; i < 7; i++) {
    const r = await handleLead(jsonReq(goodLead(), { "x-forwarded-for": "203.0.113.8" }), { ...CONFIG, rateLimit: false });
    assert.equal((await r.json()).delivered, true);
  }
});

// ── Native (no-JavaScript) posts ─────────────────────────────────
await test("native post: delivered lead redirects to the success page with the leadId", async () => {
  const { _ts, ...fields } = goodLead();
  const res = await handleLead(nativeReq(fields), CONFIG);
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /^\/thank-you\?lead=/);
  assert.equal(calls.email.length, 1);
});

await test("native post: validation errors render a plain page listing them", async () => {
  const res = await handleLead(nativeReq({ name: "Jane", phone: "555", email: "", message: "hi" }), CONFIG);
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.ok(html.includes(MESSAGES.phoneLength));
  assert.ok(html.includes(MESSAGES.emailMissing));
});

await test("native post: silent block redirects to the success page with no leadId", async () => {
  const { _ts, ...fields } = goodLead({ message: "seo audit for your site" });
  const res = await handleLead(nativeReq(fields), CONFIG);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/thank-you");
});

console.warn = quiet.warn;
console.error = quiet.error;
console.log(`lead: ${passed} passed`);
