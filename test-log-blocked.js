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

const FULL_ENV = {
  BLOCKED_LOG_WEBHOOK: "https://script.google.com/exec",
  RESEND_API_KEY: "re_test",
  BLOCKED_ALERT_FROM: "leads@example.com",
};

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

// A keyword block is where false positives live — sheet AND alert email.
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ ...lead, layer: "keyword:coldOutreach", matched: "i came across your website" });
  const sheet = calls.find((c) => c.url.includes("script.google.com"));
  const email = calls.find((c) => c.url.includes("api.resend.com"));
  check("keyword block writes to the sheet", !!sheet);
  check("keyword block sends an alert email", !!email);

  const row = JSON.parse(sheet.options.body);
  check("row carries the site", row.site === "newmans-plumbing");
  check("row carries the rule", row.layer === "keyword:coldOutreach");
  check("row carries the matched term", row.matched === "i came across your website");
  check("row carries the full message", row.message.includes("Water heater leaking"));
  check("row captures the origin header", row.origin.includes("newmansplumbingservice.com"));
  check("row captures the client IP, not the proxy chain", row.ip === "203.0.113.9");
  check("row is timestamped", !Number.isNaN(Date.parse(row.timestamp)));
});

// Bot-certain layers are logged but must not reach the inbox.
for (const layer of ["origin", "timing", "missing-fields"]) {
  await withHarness({ env: FULL_ENV }, async (calls) => {
    await logBlocked({ ...lead, layer });
    check(`"${layer}" logs to the sheet`, calls.some((c) => c.url.includes("script.google.com")));
    check(`"${layer}" sends NO alert email`, !calls.some((c) => c.url.includes("api.resend.com")));
  });
}

// A honeypot hit is NOT proof of a bot — a password manager filling the hidden
// field caught a real customer on Indiana Flow. Judge it on the rest of the entry.
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ ...lead, layer: "honeypot", matched: "filled: https://indianaflow.com" });
  check("honeypot + full name/phone/message DOES alert (autofill victim)",
    calls.some((c) => c.url.includes("api.resend.com")));
});
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ site: "x", layer: "honeypot", name: "", phone: "", message: "",
                     matched: "filled: buy-cheap-pills" });
  check("honeypot with an empty submission does NOT alert (bot)",
    !calls.some((c) => c.url.includes("api.resend.com")));
});
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ site: "x", layer: "honeypot", name: "Bot", phone: "123", message: "hi" });
  check("honeypot with an undialable phone does NOT alert (bot)",
    !calls.some((c) => c.url.includes("api.resend.com")));
});
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ ...lead, layer: "honeypot", message: "" });
  check("honeypot with no message does NOT alert (bot)",
    !calls.some((c) => c.url.includes("api.resend.com")));
});

// The content layer catches real people quoting a URL, so it must alert.
await withHarness({ env: FULL_ENV }, async (calls) => {
  await logBlocked({ ...lead, layer: "content", matched: "url-in-text" });
  check('"content" sends an alert email', calls.some((c) => c.url.includes("api.resend.com")));
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

// With no BLOCKED_ALERT_FROM set, the shared verified sender must be used, so
// alerts work across every project with no per-project configuration.
await withHarness({
  env: { BLOCKED_LOG_WEBHOOK: FULL_ENV.BLOCKED_LOG_WEBHOOK, RESEND_API_KEY: "re_test" },
}, async (calls) => {
  await logBlocked({ ...lead, layer: "keyword:coldOutreach", matched: "x" });
  const email = calls.find((c) => c.url.includes("api.resend.com"));
  check("no BLOCKED_ALERT_FROM still sends the alert", !!email);
  check("it falls back to the shared verified sender",
    JSON.parse(email.options.body).from.includes("leads@resend.getroundhouse.com"));
});

// Without a Resend key there is nothing to send with — degrade, don't throw.
await withHarness({
  env: { BLOCKED_LOG_WEBHOOK: FULL_ENV.BLOCKED_LOG_WEBHOOK },
}, async (calls, logs) => {
  await logBlocked({ ...lead, layer: "keyword:coldOutreach", matched: "x" });
  check("missing RESEND_API_KEY skips the email", !calls.some((c) => c.url.includes("resend")));
  check("missing RESEND_API_KEY is reported", logs.some((l) => l.includes("alert skipped")));
  check("the sheet row is written regardless", calls.some((c) => c.url.includes("script.google")));
});

console.log(results.join("\n"));
console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — blocked-log: ${failures} failure${failures === 1 ? "" : "s"}\n`
);
process.exit(failures === 0 ? 0 : 1);
