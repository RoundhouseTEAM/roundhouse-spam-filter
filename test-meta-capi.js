/**
 * Tests for meta-capi.js and the 2.53.0 additions (metaCapi on handleLead, ZIP fields).
 * Every network call is stubbed. Run with: npm test
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleLead } from "./lead.js";
import { metaUserData, fbcFrom } from "./meta-capi.js";
import { validateLead, validateField, MESSAGES } from "./validate.js";
import { _resetRateLimitMemory } from "./ratelimit.js";
import { _resetRepeatMemory } from "./repeat.js";

const sha = (v) => createHash("sha256").update(v).digest("hex");

const calls = { sheet: 0, email: 0, blocked: 0, meta: [] };
let metaBehaviour = "ok"; // "ok" | "error" | "throw"

process.env.GOOGLE_SHEET_WEBHOOK = "https://sheet.test/exec";
process.env.RESEND_API_KEY = "re_test";
process.env.BLOCKED_LOG_WEBHOOK = "https://blocked.test/exec";

globalThis.fetch = async (url, options = {}) => {
  if (url === "https://sheet.test/exec") {
    calls.sheet++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (url === "https://api.resend.com/emails") {
    calls.email++;
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  if (url === "https://blocked.test/exec") {
    calls.blocked++;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (String(url).startsWith("https://graph.facebook.com/")) {
    calls.meta.push({ url: String(url), body: JSON.parse(options.body) });
    if (metaBehaviour === "throw") throw new Error("network down");
    if (metaBehaviour === "error") {
      return new Response(JSON.stringify({ error: { message: "Invalid OAuth access token" } }), { status: 400 });
    }
    return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const quiet = { warn: console.warn, error: console.error, log: console.log };
const lines = [];
const capture = (...a) => lines.push(a.map(String).join(" "));
console.warn = capture;
console.error = capture;
console.log = capture;

const ZIP = { name: "zip", label: "ZIP code", format: "zip" };
const CONFIG = {
  site: "test-site",
  businessName: "Test Plumbing",
  phone: "(512) 555-2199",
  allowedOrigins: ["testplumbing.com", "localhost", ".vercel.app"],
  recipients: ["owner@testplumbing.com"],
  extraFields: [ZIP],
  metaCapi: { pixelId: "111", accessToken: "tok", userData: { st: "hi", country: "us" } },
};

let seq = 0;
function lead(overrides = {}) {
  seq++;
  return {
    name: "Jane Q Rivera",
    phone: "(512) 555-2100",
    email: " Jane@Example.com ",
    message: `Kitchen sink is backed up, case ${seq}`,
    zip: "96792",
    source: "https://www.testplumbing.com/lp/fb/drain-cleaning/?area=westside&fbclid=ABC123",
    _elapsed: 10_000,
    ...overrides,
  };
}
const req = (body, headers = {}) =>
  new Request("https://www.testplumbing.com/api/contact", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://www.testplumbing.com",
      "user-agent": "Mozilla/5.0 test",
      "x-forwarded-for": "203.0.113.9",
      ...headers,
    },
    body: JSON.stringify(body),
  });

let passed = 0;
async function test(label, fn) {
  _resetRateLimitMemory();
  _resetRepeatMemory();
  calls.sheet = calls.email = calls.blocked = 0;
  calls.meta.length = 0;
  metaBehaviour = "ok";
  lines.length = 0;
  try {
    await fn();
    passed++;
  } catch (err) {
    quiet.error(`FAIL: ${label}`);
    throw err;
  }
}

// ── ZIP format ───────────────────────────────────────────────────
await test("ZIP: 5 digits and ZIP+4 are valid", () => {
  assert.equal(validateField("zip", "96792", [ZIP]), "");
  assert.equal(validateField("zip", " 96792-1234 ", [ZIP]), "");
});
await test("ZIP: wrong length or letters get a visible message", () => {
  for (const bad of ["9679", "967921", "abcde", "96 792"]) {
    assert.equal(validateField("zip", bad, [ZIP]), MESSAGES.zipInvalid, bad);
  }
});
await test("ZIP: required like every visible field", () => {
  assert.equal(validateLead({ name: "A B", phone: "5125552100", email: "a@b.com", message: "x" }, [ZIP]).zip, "Please enter your zip code.");
});
await test("a field without format is unaffected by the ZIP rule", () => {
  assert.equal(validateField("area", "Waianae", [{ name: "area", label: "Area" }]), "");
});

// ── user_data ────────────────────────────────────────────────────
await test("user_data hashes contact fields the way Meta specifies", () => {
  const ud = metaUserData({
    lead: { name: "Jane Q Rivera", phone: "(512) 555-2100", email: " Jane@Example.com ", zip: "96792-1234", source: "" },
    ip: "203.0.113.9",
    userAgent: "UA",
    cookieHeader: "_fbp=fb.1.1.222; other=x",
    extra: { st: "HI" },
  });
  assert.deepEqual(ud.em, [sha("jane@example.com")]);
  assert.deepEqual(ud.ph, [sha("15125552100")]);
  assert.deepEqual(ud.fn, [sha("jane")]);
  assert.deepEqual(ud.ln, [sha("rivera")]);
  assert.deepEqual(ud.zp, [sha("96792")]);
  assert.deepEqual(ud.st, [sha("hi")]);
  assert.equal(ud.client_ip_address, "203.0.113.9");
  assert.equal(ud.client_user_agent, "UA");
  assert.equal(ud.fbp, "fb.1.1.222");
  assert.equal(ud.fbc, undefined);
});
await test("fbc: cookie wins, else built from fbclid, else empty", () => {
  assert.equal(fbcFrom("_fbc=fb.1.5.XYZ", "https://x.com/?fbclid=ABC"), "fb.1.5.XYZ");
  assert.equal(fbcFrom("", "https://x.com/?fbclid=ABC", 42), "fb.1.42.ABC");
  assert.equal(fbcFrom("", "https://x.com/"), "");
  assert.equal(fbcFrom("", "not a url"), "");
});

// ── handleLead + metaCapi ────────────────────────────────────────
await test("a delivered lead sends ONE Lead event with event_id = leadId", async () => {
  const res = await handleLead(req(lead()), CONFIG);
  const data = await res.json();
  assert.equal(data.delivered, true);
  assert.equal(calls.meta.length, 1);
  const { url, body } = calls.meta[0];
  assert.match(url, /\/v21\.0\/111\/events\?access_token=tok$/);
  const ev = body.data[0];
  assert.equal(ev.event_name, "Lead");
  assert.equal(ev.event_id, data.leadId);
  assert.equal(ev.action_source, "website");
  assert.match(ev.event_source_url, /area=westside/);
  assert.deepEqual(ev.user_data.zp, [sha("96792")]);
  assert.deepEqual(ev.user_data.country, [sha("us")]);
  assert.match(ev.user_data.fbc, /^fb\.1\.\d+\.ABC123$/);
  assert.equal(body.test_event_code, undefined);
});
await test("no metaCapi on the config → nothing sent to Meta", async () => {
  const { metaCapi, ...plain } = CONFIG;
  const res = await handleLead(req(lead()), plain);
  assert.equal((await res.json()).delivered, true);
  assert.equal(calls.meta.length, 0);
});
await test("a withheld submission never reaches Meta", async () => {
  const res = await handleLead(req(lead({ message: "We offer SEO for plumbers" })), CONFIG);
  assert.equal((await res.json()).delivered, undefined);
  assert.equal(calls.meta.length, 0);
});
await test("a double-click duplicate sends no second event", async () => {
  const body = lead();
  await handleLead(req(body), CONFIG);
  await handleLead(req(body), CONFIG);
  assert.equal(calls.meta.length, 1);
});
await test("a validation error (bad ZIP) sends nothing and names the field", async () => {
  const res = await handleLead(req(lead({ zip: "967" })), CONFIG);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).errors.zip, MESSAGES.zipInvalid);
  assert.equal(calls.meta.length, 0);
});
await test("Meta rejecting the event never affects the lead", async () => {
  metaBehaviour = "error";
  const res = await handleLead(req(lead()), CONFIG);
  assert.equal((await res.json()).delivered, true);
  assert.ok(lines.some((l) => l.includes("[meta-capi] FAILED") && l.includes("Invalid OAuth")));
});
await test("Meta unreachable never affects the lead", async () => {
  metaBehaviour = "throw";
  const res = await handleLead(req(lead()), CONFIG);
  assert.equal((await res.json()).delivered, true);
  assert.ok(lines.some((l) => l.includes("[meta-capi] FAILED")));
});
await test("missing token: skipped with a warning, lead delivered", async () => {
  const res = await handleLead(req(lead()), { ...CONFIG, metaCapi: { pixelId: "111" } });
  assert.equal((await res.json()).delivered, true);
  assert.equal(calls.meta.length, 0);
  assert.ok(lines.some((l) => l.includes("[meta-capi] SKIPPED") && l.includes("META_CAPI_TOKEN")));
});
await test("META_TEST_EVENT_CODE is passed through while testing", async () => {
  process.env.META_TEST_EVENT_CODE = "TEST123";
  try {
    await handleLead(req(lead()), CONFIG);
    assert.equal(calls.meta[0].body.test_event_code, "TEST123");
  } finally {
    delete process.env.META_TEST_EVENT_CODE;
  }
});
await test("a monitor request never reaches Meta", async () => {
  process.env.LEAD_MONITOR_SECRET = "monitor-secret-0123456789";
  try {
    await handleLead(req(lead(), { "x-roundhouse-monitor": "monitor-secret-0123456789" }), CONFIG);
    assert.equal(calls.meta.length, 0);
  } finally {
    delete process.env.LEAD_MONITOR_SECRET;
  }
});

quiet.log(`meta-capi: ${passed} passed`);
