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
let sheetBody = JSON.stringify({ ok: true });
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
    return new Response(sheetBody, { status: sheetStatus });
  }
  if (url.startsWith("https://sheet.test/exec?")) {
    calls.sheet.push({ method: options.method, query: Object.fromEntries(new URL(url).searchParams) });
    return new Response(sheetBody, { status: sheetStatus });
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
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

// Keep test output readable — the handler logs failures on purpose. Captured so tests can
// assert what reached the Vercel logs.
const quiet = { warn: console.warn, error: console.error, log: console.log };
const consoleLines = [];
const capture = (...args) => consoleLines.push(args.map(String).join(" "));
console.warn = capture;
console.error = capture;
console.log = capture;

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
    _elapsed: 10_000,
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

await test("sheet and email are sent in parallel — a slow sheet doesn't delay the email", async () => {
  const started = [];
  const real = globalThis.fetch;
  let releaseSheet;
  globalThis.fetch = async (url, o) => {
    if (url.includes("sheet")) {
      started.push("sheet");
      await new Promise((r) => (releaseSheet = r));
    }
    if (url.includes("resend")) {
      started.push("email");
      releaseSheet?.();
    }
    return real(url, o);
  };
  const res = await handleLead(jsonReq(goodLead()), CONFIG);
  globalThis.fetch = real;
  assert.equal((await res.json()).delivered, true);
  assert.deepEqual(started, ["sheet", "email"], "email started while the sheet was still pending");
});

await test("the full lead is written to the Vercel logs BEFORE delivery is attempted", async () => {
  const real = globalThis.fetch;
  let loggedFirst = false;
  globalThis.fetch = async (url, o) => {
    if (url.includes("sheet") || url.includes("resend")) {
      loggedFirst ||= consoleLines.some((l) => l.includes("[lead] RECEIVED") && l.includes("Jane Rivera"));
    }
    return real(url, o);
  };
  await handleLead(jsonReq(goodLead()), CONFIG);
  globalThis.fetch = real;
  assert.ok(loggedFirst);
});

await test("email HTML escapes visitor input", async () => {
  await handleLead(jsonReq(goodLead({ message: "<script>alert(1)</script> leak" })), CONFIG);
  assert.ok(!calls.email[0].html.includes("<script>"));
  assert.ok(calls.email[0].html.includes("&lt;script&gt;"));
});

// ── Withheld (only what a customer can't produce) ────────────────
for (const [label, body, headers, layer] of [
  ["blocklisted phone", goodLead({ phone: "307-207-6448" }), {}, "phone"],
  ["blocklisted email domain", goodLead({ email: "sam@vettedvas.com" }), {}, "email-domain"],
  ["sqlmap: referer is the API path, no JavaScript", goodLead({ _elapsed: undefined }), { origin: "", referer: "https://www.testplumbing.com/api/contact" }, "automation"],
  ["script: no origin/referer headers, no JavaScript", goodLead({ _elapsed: undefined }), { origin: "" }, "automation"],
  ["form bot: honeypot filled, no JavaScript", goodLead({ _elapsed: undefined, referral_code: "http://spam" }), {}, "automation"],
  ["bot: honeypot filled AND submitted instantly", goodLead({ _elapsed: 200, referral_code: "x" }), {}, "automation"],
  ["bot: instant submit from a foreign origin", goodLead({ _elapsed: 100 }), { origin: "https://evil.example" }, "automation"],
]) {
  await test(`withheld: ${label}`, async () => {
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

// ── Delivered and flagged (used to be silent blocks) ────────────
for (const [label, body, headers, flag] of [
  ["wrong origin alone (domain missing from allowedOrigins)", goodLead(), { origin: "https://www.newdomain.com", referer: "https://www.newdomain.com/contact" }, /origin not in allowedOrigins/],
  ["too fast alone", goodLead({ _elapsed: 200 }), {}, /submitted 200ms/],
  ["Cyrillic name", goodLead({ name: "Олена Коваль" }), {}, /non-latin/],
  ["keyword phrase", goodLead({ message: "My virtual assistant will schedule, need a plumber at our office" }), {}, /keyword:virtualAssistant/],
  ["unusual TLD", goodLead({ email: "owner@smith.top" }), {}, /email-tld/],
  ["gibberish", goodLead({ message: "NAEWTRER365118NEYHRTGE" }), {}, /gibberish/],
]) {
  await test(`delivered + flagged: ${label}`, async () => {
    const res = await handleLead(jsonReq(body, headers), CONFIG);
    const data = await res.json();
    assert.equal(data.delivered, true);
    assert.equal(calls.sheet.length, 1);
    assert.equal(calls.email.length, 1);
    assert.ok(!calls.email[0].html.toLowerCase().includes("flag"), "the client never sees a spam label");
    const row = calls.blocked.find((b) => b.layer === "delivered-flagged");
    assert.ok(row, "flagged row logged");
    assert.match(row.matched, flag);
    assert.equal(row.delivered, "Yes");
    assert.equal(row.urgent, "", "a delivered lead never raises an urgent alert");
  });
}

// ── The audit's false positives (2026-09-16) — all must reach the client ─────
for (const message of [
  "Leaking water heater, can send a 30 second video of it",
  "Found you on the first page of google, need a quote for a new roof",
  "Commercial kitchen at the Hard Rock casino needs a grease trap pumped",
  "We are open to selling the house after the repair, need estimate",
  "Our sprinklers run on autopilot but zone 3 is broken",
  "Please reply yes and I will send pictures",
]) {
  await test(`real customer wording is delivered unflagged: "${message.slice(0, 40)}…"`, async () => {
    const res = await handleLead(jsonReq(goodLead({ message })), CONFIG);
    assert.equal((await res.json()).delivered, true);
    assert.equal(calls.blocked.length, 0);
  });
}

// ── Device clocks ────────────────────────────────────────────────
await test("clock: form open 3 minutes on a device 5 minutes FAST → delivered (old _ts page)", async () => {
  const res = await handleLead(jsonReq(goodLead({ _elapsed: undefined, _ts: Date.now() - 180_000 + 300_000 })), CONFIG);
  assert.equal((await res.json()).delivered, true);
  assert.equal(calls.blocked.length, 0, "an implausible clock is unknown time, not a signal");
});

await test("clock: _elapsed is used even when _ts disagrees wildly", async () => {
  const res = await handleLead(jsonReq(goodLead({ _elapsed: 45_000, _ts: Date.now() + 3_600_000 })), CONFIG);
  assert.equal((await res.json()).delivered, true);
  assert.equal(calls.blocked.length, 0);
});

await test("clock: autofilled honeypot on a fast-clock device (old _ts page) → delivered", async () => {
  const res = await handleLead(
    jsonReq(goodLead({ _elapsed: undefined, _ts: Date.now() + 120_000, referral_code: "Jane" })),
    CONFIG
  );
  assert.equal((await res.json()).delivered, true);
});

await test("a page open for 6 hours → delivered, unflagged", async () => {
  const res = await handleLead(jsonReq(goodLead({ _elapsed: 6 * 3600_000 })), CONFIG);
  assert.equal((await res.json()).delivered, true);
  assert.equal(calls.blocked.length, 0);
});

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
await test("autofill: honeypot filled, JS ran, open 3s+ → delivered, flagged Delivered=Yes", async () => {
  const res = await handleLead(jsonReq(goodLead({ referral_code: "DLNR DOBOR" })), CONFIG);
  const data = await res.json();
  assert.equal(data.delivered, true);
  assert.equal(calls.email.length, 1);
  assert.equal(calls.blocked.length, 1);
  assert.equal(calls.blocked[0].layer, "delivered-flagged");
  assert.match(calls.blocked[0].matched, /browser autofill/);
  assert.equal(calls.blocked[0].delivered, "Yes");
  assert.equal(calls.blocked[0].urgent, "", "a delivered lead never raises an urgent alert");
});

await test("no timing token (JS never ran) → delivered, normal subject, flagged Delivered=Yes", async () => {
  const res = await handleLead(jsonReq(goodLead({ _elapsed: undefined })), CONFIG);
  assert.equal((await res.json()).delivered, true);
  assert.ok(!calls.email[0].subject.includes("Unverified"));
  assert.equal(calls.blocked[0].layer, "delivered-flagged");
  assert.match(calls.blocked[0].matched, /no JavaScript/);
  assert.equal(calls.blocked[0].delivered, "Yes");
});

// ── Failure handling ─────────────────────────────────────────────
await test("email rejected (quota) but sheet ok → still delivered, logged urgent", async () => {
  emailBehaviour = "reject";
  const res = await handleLead(jsonReq(goodLead()), CONFIG);
  assert.equal((await res.json()).delivered, true);
  assert.equal(calls.blocked[0].layer, "delivered-email-failed");
  assert.match(calls.blocked[0].matched, /sheet confirmed the row/);
  assert.equal(calls.blocked[0].urgent, "yes", "the client may never look at the sheet");
});

await test("sheet down but email ok → delivered, sheet failure logged (not urgent)", async () => {
  sheetStatus = 500;
  const res = await handleLead(jsonReq(goodLead()), CONFIG);
  assert.equal((await res.json()).delivered, true);
  assert.equal(calls.blocked.length, 1);
  assert.equal(calls.blocked[0].layer, "delivered-sheet-failed");
  assert.equal(calls.blocked[0].urgent, "");
});

for (const [label, status, bodyText] of [
  ["Apps Script threw ({ok:false} with 200)", 200, JSON.stringify({ ok: false, error: "TypeError: sheet is null" })],
  ["Google sign-in page with 200", 200, '<!DOCTYPE html><html><head><title>Sign in</title></head><body><a href="https://accounts.google.com/ServiceLogin">Sign in</a></body></html>'],
  ["Google script error page with 200", 200, "<!DOCTYPE html><html><head><title>Error</title></head><body>TypeError: Cannot read properties of null</body></html>"],
  ["health-check answer (no fields arrived)", 200, JSON.stringify({ ok: true, status: "listening" })],
]) {
  await test(`sheet: ${label} counts as NOT recorded`, async () => {
    sheetStatus = status;
    sheetBody = bodyText;
    emailBehaviour = "reject";
    const res = await handleLead(jsonReq(goodLead()), CONFIG);
    assert.equal(res.status, 500, "both failed → visitor told to call, never a fake thanks");
    assert.equal(calls.blocked[0].layer, "delivery-failed");
  });
}

await test("sheet: a plain-text success from an older client script is accepted", async () => {
  sheetBody = "Success";
  emailBehaviour = "reject";
  const res = await handleLead(jsonReq(goodLead()), CONFIG);
  assert.equal((await res.json()).delivered, true);
});

await test("total failure: UNDELIVERED lead reaches the Vercel logs even if the central log is broken", async () => {
  sheetStatus = 500;
  emailBehaviour = "throw";
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) =>
    url === "https://blocked.test/exec" ? new Response(JSON.stringify({ ok: false, error: "boom" }), { status: 200 }) : real(url, o);
  const res = await handleLead(jsonReq(goodLead({ name: "Lost Lead Larry" })), CONFIG);
  globalThis.fetch = real;
  assert.equal(res.status, 500);
  assert.ok(consoleLines.some((l) => l.includes("UNDELIVERED LEAD") && l.includes("Lost Lead Larry")));
  assert.ok(consoleLines.some((l) => l.includes("ROW NOT RECORDED")), "a broken central log is called out");
});

await test("a withheld lead is recoverable from the Vercel logs when the central log is broken", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) =>
    url === "https://blocked.test/exec" ? new Response("<html>Sign in</html>", { status: 200 }) : real(url, o);
  await handleLead(jsonReq(goodLead({ phone: "307-207-6448", name: "Withheld Wendy" })), CONFIG);
  globalThis.fetch = real;
  assert.ok(consoleLines.some((l) => l.includes("Withheld Wendy") && l.includes("307-207-6448")));
  assert.ok(consoleLines.some((l) => l.includes("ROW NOT RECORDED")));
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

await test("resubmitting with a corrected address is delivered, not swallowed as a duplicate", async () => {
  const body = goodLead();
  await handleLead(jsonReq(body), CONFIG);
  const fixed = await (await handleLead(jsonReq({ ...body, address: "14 Main St" }), CONFIG)).json();
  assert.equal(fixed.delivered, true);
  assert.equal(calls.email.length, 2);
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

await test("rate limit: an office sending 6 real leads in 10 minutes → all delivered, the 6th flagged", async () => {
  const ipHeaders = { "x-forwarded-for": "203.0.113.7" };
  for (let i = 0; i < 5; i++) {
    const r = await handleLead(jsonReq(goodLead(), ipHeaders), CONFIG);
    assert.equal((await r.json()).delivered, true, `lead ${i + 1}`);
  }
  assert.equal(calls.blocked.length, 0);
  const sixth = await handleLead(jsonReq(goodLead({ name: "Sixth Person" }), ipHeaders), CONFIG);
  assert.equal((await sixth.json()).delivered, true);
  assert.equal(calls.email.length, 6);
  const row = calls.blocked.find((b) => b.layer === "delivered-flagged");
  assert.match(row.matched, /rate-limit/);
});

await test("rate limit: a flood (31st in 10 minutes) is withheld and logged with the full lead", async () => {
  const ipHeaders = { "x-forwarded-for": "203.0.113.70" };
  for (let i = 0; i < 30; i++) await handleLead(jsonReq(goodLead(), ipHeaders), CONFIG);
  assert.equal(calls.email.length, 30);
  const flood = await handleLead(jsonReq(goodLead({ name: "Flood Person" }), ipHeaders), CONFIG);
  assert.deepEqual(await flood.json(), { ok: true });
  assert.equal(calls.email.length, 30);
  const row = calls.blocked.find((b) => b.layer === "rate-limit-flood");
  assert.equal(row.name, "Flood Person");
  assert.equal(row.urgent, "", "a flood never spends the urgent-alert ration");
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

await test("rate limit: withheld spam and validation errors never count toward the limit", async () => {
  const ipHeaders = { "x-forwarded-for": "203.0.113.50" };
  for (let i = 0; i < 10; i++) await handleLead(jsonReq(goodLead({ email: "x@vettedvas.com" }), ipHeaders), CONFIG);
  for (let i = 0; i < 10; i++) await handleLead(jsonReq(goodLead({ phone: "555" }), ipHeaders), CONFIG);
  const real = await handleLead(jsonReq(goodLead(), ipHeaders), CONFIG);
  assert.equal((await real.json()).delivered, true);
  assert.equal(calls.blocked.filter((b) => b.layer === "delivered-flagged").length, 0);
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
  for (let i = 0; i < 35; i++) {
    const r = await handleLead(jsonReq(goodLead(), { "x-forwarded-for": "203.0.113.8" }), { ...CONFIG, rateLimit: false });
    assert.equal((await r.json()).delivered, true);
  }
});

// ── Native (no-JavaScript) posts ─────────────────────────────────
await test("native post: delivered lead redirects to the success page with the leadId", async () => {
  const { _elapsed, ...fields } = goodLead();
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

await test("native post: a keyword match is still delivered", async () => {
  const { _elapsed, ...fields } = goodLead({ message: "seo audit for your site" });
  const res = await handleLead(nativeReq(fields), CONFIG);
  assert.equal(res.status, 303);
  assert.match(res.headers.get("location"), /^\/thank-you\?lead=/);
  assert.equal(calls.email.length, 1);
});

await test("native post: no-referrer policy (Origin: null, no Referer) → delivered, flagged", async () => {
  const { _elapsed, ...fields } = goodLead();
  const res = await handleLead(nativeReq(fields, { referer: "", origin: "null" }), CONFIG);
  assert.equal(res.status, 303);
  assert.equal(calls.email.length, 1);
});

await test("native post: withheld submission redirects to the success page with no leadId", async () => {
  const { _elapsed, ...fields } = goodLead({ email: "sam@vettedvas.com" });
  const res = await handleLead(nativeReq(fields), CONFIG);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/thank-you");
});

// ── Monitor mode ─────────────────────────────────────────────────
const SECRET = "monitor-secret-0123456789";
async function withSecret(fn) {
  process.env.LEAD_MONITOR_SECRET = SECRET;
  try {
    await fn();
  } finally {
    delete process.env.LEAD_MONITOR_SECRET;
  }
}

await test("monitor: runs the real checks and email, never reaches the client", async () => {
  await withSecret(async () => {
    const res = await handleLead(jsonReq(goodLead(), { "x-roundhouse-monitor": SECRET }), CONFIG);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.delivered, false, "no conversion can fire");
    assert.equal(data.monitor.email, "sent");
    assert.equal(data.monitor.emailId, "email_123");
    assert.deepEqual(data.monitor.flags, []);
    assert.equal(data.monitor.sheetConfigured, true);
    assert.equal(calls.sheet.length, 0, "client sheet untouched");
    assert.deepEqual(calls.email[0].to, ["delivered@resend.dev"], "email goes to Resend's sink only");
    assert.ok(calls.email[0].subject.startsWith("[MONITOR] "));
    assert.equal(calls.blocked.length, 0, "nothing in the central log");
  });
});

await test("monitor: a misconfigured domain shows up as a flag", async () => {
  await withSecret(async () => {
    const res = await handleLead(
      jsonReq(goodLead(), { "x-roundhouse-monitor": SECRET, origin: "https://www.newdomain.com" }),
      CONFIG
    );
    assert.match((await res.json()).monitor.flags.join(" "), /origin not in allowedOrigins/);
  });
});

await test("monitor: a withheld submission and a Resend failure are reported, not hidden", async () => {
  await withSecret(async () => {
    const withheld = await handleLead(
      jsonReq(goodLead({ email: "x@vettedvas.com" }), { "x-roundhouse-monitor": SECRET }),
      CONFIG
    );
    assert.equal((await withheld.json()).monitor.withheld, "email-domain");
    reset();
    emailBehaviour = "reject";
    const failed = await handleLead(jsonReq(goodLead(), { "x-roundhouse-monitor": SECRET }), CONFIG);
    assert.match((await failed.json()).monitor.email, /Resend 429/);
    assert.equal(calls.blocked.length, 0);
  });
});

await test("monitor: a wrong or missing secret is treated as a normal lead", async () => {
  await withSecret(async () => {
    const res = await handleLead(jsonReq(goodLead(), { "x-roundhouse-monitor": "monitor-secret-WRONG56789" }), CONFIG);
    const data = await res.json();
    assert.equal(data.delivered, true);
    assert.equal(data.monitor, undefined);
    assert.deepEqual(calls.email[0].to, ["owner@testplumbing.com"]);
  });
  reset();
  const noSecretSet = await handleLead(jsonReq(goodLead(), { "x-roundhouse-monitor": "" }), CONFIG);
  assert.equal((await noSecretSet.json()).delivered, true, "no LEAD_MONITOR_SECRET → monitor mode can't be enabled");
});

console.warn = quiet.warn;
console.error = quiet.error;
console.log = quiet.log;
console.log(`lead: ${passed} passed`);
