/**
 * Tests for the blocked-submission recorder.
 *
 * The point of this module is that it can NEVER break a contact route, so most of
 * these assert failure behaviour: a missing webhook, a dead webhook, a hanging
 * webhook and a malformed request must all resolve quietly rather than throw.
 */

import { logBlocked } from "./log-blocked.js";

let failures = 0;
const results = [];

function check(label, condition, detail = "") {
  if (condition) {
    results.push(`  ✓ ${label}`);
  } else {
    failures++;
    results.push(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`);
  }
}

/** Swaps in a fake fetch + captured console for one call, then restores everything. */
async function withHarness({ fetchImpl, env = {} }, fn) {
  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const realError = console.error;
  const realEnv = { ...process.env };

  const calls = [];
  const logs = [];

  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return fetchImpl ? fetchImpl(url, options) : new Response("{}", { status: 200 });
  };
  console.warn = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));

  for (const key of ["BLOCKED_LOG_WEBHOOK", "RESEND_API_KEY", "BLOCKED_ALERT_FROM", "BLOCKED_ALERT_TO"]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);

  try {
    return await fn(calls, logs);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    console.error = realError;
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, realEnv);
  }
}

// RESEND_API_KEY is deliberately SET here. This module must not send email even
// when it perfectly well could — that is the guarantee, not an accident of config.
const FULL_ENV = {
  BLOCKED_LOG_WEBHOOK: "https://script.google.com/exec",
  RESEND_API_KEY: "re_test",
};

/** The row this call posted to the sheet. */
const rowOf = (calls) =>
  JSON.parse(calls.find((c) => c.url.includes("script.google.com")).options.body);
const emailed = (calls) => calls.some((c) => c.url.includes("api.resend.com"));

const req = {
  headers: {
    get(name) {
      return {
        origin: "https://www.newmansplumbingservice.com",
        referer: "https://www.newmansplumbingservice.com/contact",
        "user-agent": "Mozilla/5.0",
        "x-forwarded-for": "203.0.113.9, 70.41.3.18",
      }[name.toLowerCase()] ?? null;
    },
  },
};

const lead = {
  site: "newmans-plumbing",
  name: "Sarah Mitchell",
  phone: "757-555-0134",
  email: "sarah@gmail.com",
  message: "I came across your website. Water heater leaking.",
  source: "/contact",
  req,
};

console.log("\n── Blocked-submission recorder ──────────────────────────\n");

// A keyword block is where false positives live — logged, and flagged urgent so
// the Apps Script emails it now rather than in tomorrow's digest.
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ ...lead, layer: "keyword:coldOutreach", matched: "i came across your website" });
  const sheet = calls.find((c) => c.url.includes("script.google.com"));
  check("keyword block writes to the sheet", !!sheet);

  const row = JSON.parse(sheet.options.body);
  check("keyword block is flagged urgent", row.urgent === "yes");
  check("row carries the site", row.site === "newmans-plumbing");
  check("row carries the rule", row.layer === "keyword:coldOutreach");
  check("row carries the matched term", row.matched === "i came across your website");
  check("row carries the full message", row.message.includes("Water heater leaking"));
  check("row captures the origin header", row.origin.includes("newmansplumbingservice.com"));
  check("row captures the client IP, not the proxy chain", row.ip === "203.0.113.9");
  check("row is timestamped", !Number.isNaN(Date.parse(row.timestamp)));
});

// THE guarantee of the 2026-09-08 change: a spam flood must never be able to spend
// the Resend quota that real customer lead emails depend on. No layer may email,
// even with a key present and a submission that reads exactly like a real person.
for (const layer of [
  "honeypot", "origin", "timing", "missing-fields", "content:short-phone",
  "content:url", "content:non-latin", "keyword:coldOutreach", "gibberish", "delivered-no-js",
]) {
  await withHarness({ env: FULL_ENV }, async (calls) => {
    await logBlocked({ ...lead, layer });
    check(`"${layer}" never calls Resend`, !emailed(calls));
    check(`"${layer}" is logged to the sheet`, calls.some((c) => c.url.includes("script.google")));
  });
}

// Bot-certain layers carry no urgency — they are digest material at most.
for (const layer of ["origin", "timing", "missing-fields", "delivered-no-js", "template"]) {
  await withHarness({ env: FULL_ENV }, async (calls) => {
    await logBlocked({ ...lead, layer });
    check(`"${layer}" is not urgent even from a real-looking entry`, rowOf(calls).urgent === "");
  });
}

// The rule that fired 66 times in 19 minutes on 2026-09-08. A submission with no
// dialable number is not a rescuable lead, so it must never be urgent.
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ site: "indiana-flow-website", layer: "content:short-phone",
                     matched: "phone under 7 digits", name: "ORDER BY 1-- -",
                     phone: "-5244", message: "CONCAT(0x7e,(SELECT (ELT(6606=6606" });
  check("content:short-phone is never urgent", rowOf(calls).urgent === "");
});

// A URL or Cyrillic block CAN be a real customer, so it stays urgent.
for (const layer of ["content:url", "content:non-latin"]) {
  await withHarness({ env: FULL_ENV }, async (calls) => {
    await logBlocked({ ...lead, layer });
    check(`"${layer}" from a real-looking entry is urgent`, rowOf(calls).urgent === "yes");
  });
}

// A honeypot hit is NOT proof of a bot — a password manager filling the hidden
// field caught a real customer on Indiana Flow. Judge it on the rest of the entry.
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ ...lead, layer: "honeypot", matched: "filled: https://indianaflow.com" });
  check("honeypot + full name/phone/message IS urgent (autofill victim)",
    rowOf(calls).urgent === "yes");
});
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ site: "x", layer: "honeypot", name: "", phone: "", message: "",
                     matched: "filled: buy-cheap-pills" });
  check("honeypot with an empty submission is not urgent (bot)", rowOf(calls).urgent === "");
});
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ site: "x", layer: "honeypot", name: "Bot", phone: "123", message: "hi" });
  check("honeypot with an undialable phone is not urgent (bot)", rowOf(calls).urgent === "");
});
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ ...lead, layer: "honeypot", message: "" });
  check("honeypot with no message is not urgent (bot)", rowOf(calls).urgent === "");
});

console.log(results.splice(0).join("\n"));
console.log("\n── Must never break a contact route ─────────────────────\n");

// No webhook configured — degrade to console, don't throw.
await withHarness({ env: {} }, async (calls, logs) => {
  let threw = false;
  try {
    await logBlocked({ ...lead, layer: "keyword:offTopic", matched: "casino" });
  } catch { threw = true; }
  check("unconfigured webhook does not throw", !threw);
  check("unconfigured webhook still logs to console", logs.some((l) => l.includes("[blocked-log]")));
  check("unconfigured webhook makes no sheet call", !calls.some((c) => c.url.includes("script.google")));
});

// Webhook down.
await withHarness({
  env: FULL_ENV,
  fetchImpl: async () => new Response("boom", { status: 500 }),
}, async () => {
  let threw = false;
  try {
    await logBlocked({ ...lead, layer: "honeypot" });
  } catch { threw = true; }
  check("a 500 from the webhook does not throw", !threw);
});

// Webhook throws outright (DNS failure, abort, TLS error).
await withHarness({
  env: FULL_ENV,
  fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
}, async () => {
  let threw = false;
  try {
    await logBlocked({ ...lead, layer: "keyword:seoMarketing", matched: "backlinks" });
  } catch { threw = true; }
  check("a thrown fetch does not propagate", !threw);
});

// Garbage in — no request, no fields, nothing.
await withHarness({ env: FULL_ENV }, async (calls) => {
  let threw = false;
  try {
    await logBlocked({});
    await logBlocked();
  } catch { threw = true; }
  check("an empty entry does not throw", !threw);
  const row = JSON.parse(calls[0].options.body);
  check("an empty entry still records a row", row.layer === "unknown");
});

// A request object that blows up when read must not take the log down with it.
await withHarness({ env: FULL_ENV }, async (calls) => {
  let threw = false;
  try {
    await logBlocked({
      ...lead,
      layer: "gibberish",
      req: { headers: { get() { throw new Error("bad headers"); } } },
    });
  } catch { threw = true; }
  check("a hostile request object does not throw", !threw);
  check("the row is still written", calls.some((c) => c.url.includes("script.google")));
});

// Oversized message must be clipped, not sent whole into a Sheets cell.
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ ...lead, layer: "keyword:offTopic", message: "x".repeat(60000) });
  const row = JSON.parse(calls[0].options.body);
  check("an oversized message is truncated", row.message.length < 5000, `got ${row.message.length}`);
  check("truncation is marked", row.message.endsWith("[truncated]"));
});

// A webhook that is slow must not hold the serverless response open indefinitely.
await withHarness({
  env: FULL_ENV,
  fetchImpl: () => new Promise((_, reject) => setTimeout(() => reject(new Error("aborted")), 20)),
}, async () => {
  let threw = false;
  try {
    await logBlocked({ ...lead, layer: "keyword:coldOutreach", matched: "x" });
  } catch { threw = true; }
  check("an aborted webhook does not throw", !threw);
});

// 2.6.0 urgency: delivered rows never alert, except when only the sheet caught the lead.
for (const [layer, expected] of [
  ["delivered-flagged", ""],
  ["delivered-sheet-failed", ""],
  ["delivered-email-failed", "yes"],
  ["rate-limit-flood", ""],
  ["automation", "yes"],
  ["delivery-failed", "yes"],
]) {
  await withHarness({ env: FULL_ENV }, async (calls) => {
    await logBlocked({ ...lead, layer });
    check(`${layer}: urgent="${expected}"`, rowOf(calls).urgent === expected, `got "${rowOf(calls).urgent}"`);
  });
}

// 2.6.0: the whole row reaches the console, and only {ok:true} counts as recorded.
for (const [label, body] of [
  ["{ok:false} from the Apps Script", JSON.stringify({ ok: false, error: "boom" })],
  ["a Google sign-in page", "<html><title>Sign in</title></html>"],
]) {
  await withHarness({ env: FULL_ENV, fetchImpl: () => new Response(body, { status: 200 }) }, async (_calls, logs) => {
    await logBlocked({ ...lead, layer: "keyword:offTopic" });
    check(`${label}: the console holds the full lead`, logs.some((l) => l.includes(lead.name) && l.includes(lead.phone)));
    check(`${label}: flagged ROW NOT RECORDED`, logs.some((l) => l.includes("ROW NOT RECORDED")));
  });
}
await withHarness({ env: FULL_ENV, fetchImpl: () => new Response(JSON.stringify({ ok: true }), { status: 200 }) }, async (_calls, logs) => {
  await logBlocked({ ...lead, layer: "keyword:offTopic" });
  check("{ok:true} is recorded — no ROW NOT RECORDED", !logs.some((l) => l.includes("ROW NOT RECORDED")));
});

// 2.8.0: Apps Script redirects. A 302 then {ok:true} is recorded; a 302 whose answer
// can't be read is "ran, unread" — a warning, not ROW NOT RECORDED.
await withHarness({
  env: FULL_ENV,
  fetchImpl: (url, o) =>
    String(url).includes("script.google.com")
      ? new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com/echo" } })
      : new Response(JSON.stringify({ ok: true }), { status: 200 }),
}, async (calls, logs) => {
  await logBlocked({ ...lead, layer: "keyword:offTopic" });
  check("302 → {ok:true} is recorded", !logs.some((l) => l.includes("ROW NOT RECORDED")));
  check("the script is called with redirect: manual", calls[0].options.redirect === "manual");
});
await withHarness({
  env: FULL_ENV,
  fetchImpl: (url, o) =>
    String(url).includes("script.google.com")
      ? new Response(null, { status: 302, headers: { location: "https://script.googleusercontent.com/echo" } })
      : new Promise((_, reject) => o.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" })))),
}, async (_calls, logs) => {
  await logBlocked({ ...lead, layer: "keyword:offTopic" });
  check("302 with an unreadable answer is not reported as lost", !logs.some((l) => l.includes("ROW NOT RECORDED")));
  check("…but is noted", logs.some((l) => l.includes("couldn't be read")));
});

console.log(results.join("\n"));
console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — blocked-log: ${failures} failure${failures === 1 ? "" : "s"}\n`
);
process.exit(failures === 0 ? 0 : 1);
