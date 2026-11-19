/**
 * Tests for meta-router.js — the shared Meta leadgen webhook that forwards each lead to
 * its client site. Every fetch is stubbed. Run with: npm test
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { routeMetaLead, splitByRoute } from "./meta-router.js";
import { verifySignature } from "./meta-lead.js";

const APP_SECRET = "router-secret";
const SIMPLY = "https://simply.test/api/meta-lead/";
const POWER = "https://power.test/api/meta-lead/";
const ROUTES = { "111": SIMPLY, "222": POWER };
const CONFIG = { routes: ROUTES, appSecret: APP_SECRET, verifyToken: "vt", forwardTimeoutMs: 200 };

process.env.BLOCKED_LOG_WEBHOOK = "https://blocked.test/exec";

const calls = { site: [], blocked: [] };
const siteBehaviour = new Map(); // url → "ok" | "500" | "down" | "hang"
globalThis.fetch = async (url, options = {}) => {
  if (url === "https://blocked.test/exec") {
    calls.blocked.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  if (url === SIMPLY || url === POWER) {
    calls.site.push({ url, body: options.body, sig: options.headers["X-Hub-Signature-256"], router: options.headers["X-Roundhouse-Meta-Router"] });
    const b = siteBehaviour.get(url) ?? "ok";
    if (b === "down") throw new Error("ECONNREFUSED");
    if (b === "hang") return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    if (b === "500") return new Response("lead not delivered — retry", { status: 500 });
    return new Response("EVENT_RECEIVED", { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

const quiet = { warn: console.warn, error: console.error, log: console.log };
console.warn = console.error = console.log = () => {};

const change = (page, id) => ({ field: "leadgen", value: { leadgen_id: id, page_id: page, form_id: "f" + id, ad_id: "a" + id, created_time: 1 } });
const body = (...entries) => JSON.stringify({ object: "page", entry: entries });
const sign = (raw, secret = APP_SECRET) => `sha256=${createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;
const post = (raw, sig = sign(raw)) =>
  routeMetaLead(new Request("https://router.test/api/meta-lead", { method: "POST", headers: { "content-type": "application/json", ...(sig ? { "x-hub-signature-256": sig } : {}) }, body: raw }), CONFIG);
const reset = () => {
  calls.site.length = 0;
  calls.blocked.length = 0;
  siteBehaviour.clear();
};

let passed = 0;
async function test(name, fn) {
  reset();
  try {
    await fn();
    passed++;
  } catch (err) {
    Object.assign(console, quiet);
    console.error(`FAIL ${name}`);
    throw err;
  }
}

await test("GET verification echoes the challenge only with the right token", async () => {
  const ok = await routeMetaLead(new Request("https://r.test/?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42"), CONFIG);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "42");
  const bad = await routeMetaLead(new Request("https://r.test/?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42"), CONFIG);
  assert.equal(bad.status, 403);
});

await test("one Page → original bytes and Meta's own signature forwarded untouched", async () => {
  const raw = body({ id: "111", time: 1, changes: [change("111", "L1")] });
  const res = await post(raw);
  assert.equal(res.status, 200);
  assert.equal(calls.site.length, 1);
  assert.equal(calls.site[0].url, SIMPLY);
  assert.equal(calls.site[0].body, raw);
  assert.equal(calls.site[0].sig, sign(raw));
  assert.equal(calls.site[0].router, "1");
});

await test("each client gets only its own lead (Power)", async () => {
  const raw = body({ id: "222", time: 1, changes: [change("222", "P1")] });
  assert.equal((await post(raw)).status, 200);
  assert.deepEqual(calls.site.map((c) => c.url), [POWER]);
});

await test("mixed body is split and each piece re-signed so the site verifies it", async () => {
  const raw = body({ id: "111", time: 1, changes: [change("111", "L1")] }, { id: "222", time: 1, changes: [change("222", "P1")] });
  assert.equal((await post(raw)).status, 200);
  assert.equal(calls.site.length, 2);
  for (const c of calls.site) {
    const parsed = JSON.parse(c.body);
    const pages = parsed.entry.flatMap((e) => e.changes.map((ch) => ch.value.page_id));
    assert.deepEqual(pages, [c.url === SIMPLY ? "111" : "222"]);
    assert.ok(verifySignature(c.body, c.sig, APP_SECRET).ok, "split body must carry a valid signature");
  }
});

await test("a split body is NOT re-signed when Meta's signature didn't verify", async () => {
  const raw = body({ id: "111", time: 1, changes: [change("111", "L1")] }, { id: "222", time: 1, changes: [change("222", "P1")] });
  const forged = sign(raw, "wrong-secret");
  assert.equal((await post(raw, forged)).status, 200);
  assert.equal(calls.site.length, 2);
  for (const c of calls.site) {
    assert.equal(c.sig, forged);
    assert.equal(verifySignature(c.body, c.sig, APP_SECRET).ok, false);
  }
});

await test("unknown Page → urgent meta-unrouted row, 200, nothing forwarded", async () => {
  const raw = body({ id: "999", time: 1, changes: [change("999", "X1")] });
  const res = await post(raw);
  assert.equal(res.status, 200);
  assert.equal(calls.site.length, 0);
  assert.equal(calls.blocked.length, 1);
  assert.equal(calls.blocked[0].layer, "meta-unrouted");
  assert.equal(calls.blocked[0].urgent, "yes");
  assert.match(calls.blocked[0].matched, /leadgen X1 · page 999/);
});

await test("unrouted lead next to a routed one: routed one still forwarded (split)", async () => {
  const raw = body({ id: "999", time: 1, changes: [change("999", "X1")] }, { id: "222", time: 1, changes: [change("222", "P1")] });
  assert.equal((await post(raw)).status, 200);
  assert.deepEqual(calls.site.map((c) => c.url), [POWER]);
  assert.ok(verifySignature(calls.site[0].body, calls.site[0].sig, APP_SECRET).ok);
  assert.deepEqual(calls.blocked.map((b) => b.layer), ["meta-unrouted"]);
});

for (const behaviour of ["500", "down", "hang"]) {
  await test(`site ${behaviour} → 500 so Meta retries, plus urgent meta-forward-failed`, async () => {
    siteBehaviour.set(POWER, behaviour);
    const raw = body({ id: "222", time: 1, changes: [change("222", "P1")] });
    const res = await post(raw);
    assert.equal(res.status, 500);
    assert.equal(calls.blocked.length, 1);
    assert.equal(calls.blocked[0].layer, "meta-forward-failed");
    assert.equal(calls.blocked[0].urgent, "yes");
  });
}

await test("one site failing still forwards the other, answer 500", async () => {
  siteBehaviour.set(SIMPLY, "500");
  const raw = body({ id: "111", time: 1, changes: [change("111", "L1")] }, { id: "222", time: 1, changes: [change("222", "P1")] });
  assert.equal((await post(raw)).status, 500);
  assert.equal(calls.site.length, 2);
});

await test("non-leadgen events and junk are answered without forwarding", async () => {
  assert.equal((await post(JSON.stringify({ object: "page", entry: [{ id: "111", changes: [{ field: "feed", value: {} }] }] }))).status, 200);
  assert.equal((await post("not json")).status, 400);
  assert.equal(calls.site.length, 0);
});

await test("oversized body refused", async () => {
  const raw = body({ id: "111", changes: [change("111", "L1")], pad: "x".repeat(70 * 1024) });
  assert.equal((await post(raw)).status, 413);
  assert.equal(calls.site.length, 0);
});

await test("splitByRoute uses entry.id when the change has no page_id", () => {
  const { groups, total } = splitByRoute({ object: "page", entry: [{ id: "222", changes: [{ field: "leadgen", value: { leadgen_id: "Z" } }] }] }, ROUTES);
  assert.equal(total, 1);
  assert.deepEqual([...groups.keys()], [POWER]);
});

Object.assign(console, quiet);
console.log(`meta-router: ${passed} tests passed`);
