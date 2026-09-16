/**
 * Daily contact-form monitor for every live Roundhouse site.
 *
 * WHY: the IrriGators Brandon form could not submit at all for 16 days (8/31–9/16/2026)
 * and nobody noticed — the page looked fine, the JavaScript crashed on submit, and no
 * request ever reached a server log. This catches that class of failure the same day.
 *
 * WHAT it checks, per form page, in a real browser (Chromium):
 *   1. The page loads (HTTP 200).
 *   2. The shared lead form rendered: honeypot + message counter present.
 *   3. The form's JavaScript works: it fills the form with an INVALID 3-digit phone,
 *      clicks submit, and expects the visible "Please enter a 10-digit phone number."
 *      message — proving the form hydrated and its submit handler runs.
 *   4. Nothing was sent: no request to /api/contact. Client-side validation stops the
 *      submit, so no lead, email, sheet row or blocked-log row is ever created.
 * And per site: the thank-you page loads with a click-to-call link.
 *
 * END-TO-END (sites with "e2e": true, package 2.7.0+): it also submits ONE valid lead through
 * the first form page, in the real browser, with the `x-roundhouse-monitor` secret header.
 * The server runs every real check — the live domain against allowedOrigins, validation,
 * spam classification, the Resend key/quota/sending domain, the env vars — then sends the
 * email to Resend's sink (delivered@resend.dev) instead of the client, skips the client's
 * sheet and the central log, and returns delivered:false so no conversion fires. Analytics
 * and ad tags are blocked in the browser as well. Anything other than a clean, unflagged,
 * emailed lead is a failure.
 *
 * Exit code 1 on any failure. With RESEND_API_KEY set, it also emails ALERT_TO a
 * summary of what failed (never sends anything when everything passes).
 *
 *   node monitor/check.mjs            # run all sites
 *   SITE="Power" node monitor/check.mjs  # only sites whose name contains "Power"
 */

import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const PHONE_MESSAGE = "Please enter a 10-digit phone number.";
const MONITOR_SECRET = process.env.LEAD_MONITOR_SECRET || "";
const SUBMIT_TIMEOUT = 60_000;
/** Never let a monitor visit count in anyone's analytics or ad account. */
const TRACKING_HOSTS = /googletagmanager\.com|google-analytics\.com|googleadservices\.com|doubleclick\.net|facebook\.(com|net)|clarity\.ms|analytics\.google\.com/;
const NAV_TIMEOUT = 45_000;
const HYDRATE_TIMEOUT = 20_000;
const MESSAGE_TIMEOUT = 10_000;

// SITES_FILE lets a test point the monitor at a different list.
const sitesPath = process.env.SITES_FILE ? new URL(process.env.SITES_FILE, `file://${process.cwd()}/`) : new URL("./sites.json", import.meta.url);
const { sites } = JSON.parse(await readFile(sitesPath, "utf8"));
const only = process.env.SITE?.toLowerCase();
const selected = only ? sites.filter((s) => s.name.toLowerCase().includes(only)) : sites;

const failures = [];
const passes = [];

async function checkFormPage(browser, siteName, url) {
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 RoundhouseFormMonitor/1.0",
  });
  const page = await context.newPage();
  const leadRequests = [];
  const pageErrors = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname.replace(/\/$/, "") === "/api/contact") {
      leadRequests.push(req.url());
    }
  });
  page.on("pageerror", (err) => pageErrors.push(String(err.message || err).slice(0, 200)));

  try {
    const res = await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT });
    if (!res || res.status() !== 200) throw new Error(`page returned HTTP ${res ? res.status() : "no response"}`);

    // The shared form: find the first VISIBLE form that has the honeypot.
    const forms = page.locator('form:has(input[name="referral_code"])');
    const count = await forms.count();
    if (count === 0) throw new Error("the shared lead form is not on the page (no referral_code honeypot)");
    let form = null;
    for (let i = 0; i < count; i++) {
      if (await forms.nth(i).isVisible()) {
        form = forms.nth(i);
        break;
      }
    }
    if (!form) form = forms.first();
    await form.scrollIntoViewIfNeeded().catch(() => {});

    // Hydrated = React ran and switched the form to its own validation (noValidate).
    await page.waitForFunction(
      (el) => el && el.noValidate === true,
      await form.elementHandle(),
      { timeout: HYDRATE_TIMEOUT }
    ).catch(() => {
      throw new Error("the form's JavaScript never started (form did not hydrate)");
    });

    const fill = async (name, value) => {
      const field = form.locator(`[name="${name}"]`).first();
      if ((await field.count()) && (await field.isVisible())) await field.fill(value);
    };
    await fill("name", "Roundhouse Form Monitor");
    await fill("email", "monitor@example.com");
    await fill("message", "Automated daily form check - nothing is submitted.");
    const phone = form.locator('[name="phone"]').first();
    if (!(await phone.count())) throw new Error("no phone field in the form");
    await phone.fill("555");

    await form.locator('button[type="submit"]').first().click();

    const message = page.getByText(PHONE_MESSAGE, { exact: false }).first();
    await message.waitFor({ state: "visible", timeout: MESSAGE_TIMEOUT }).catch(() => {
      throw new Error(
        `clicking submit did not show "${PHONE_MESSAGE}" — the form's submit handler may be broken` +
          (pageErrors.length ? ` (page errors: ${pageErrors.join(" | ")})` : "")
      );
    });

    // Give any (wrong) request a moment to go out before asserting none did.
    await page.waitForTimeout(1500);
    if (leadRequests.length) throw new Error(`an invalid submission was sent to the server (${leadRequests[0]})`);

    passes.push(`${siteName}: ${url}`);
  } catch (err) {
    failures.push({ site: siteName, url, problem: err.message });
  } finally {
    await context.close();
  }
}

async function checkEndToEnd(browser, siteName, url) {
  const label = `${siteName}: end-to-end lead via ${url}`;
  if (!MONITOR_SECRET) {
    failures.push({ site: siteName, url, problem: "LEAD_MONITOR_SECRET is not set for the monitor — end-to-end check skipped" });
    return;
  }
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 RoundhouseFormMonitor/1.0",
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(String(err.message || err).slice(0, 200)));
  try {
    await page.route("**/*", (route) => {
      const req = route.request();
      if (TRACKING_HOSTS.test(new URL(req.url()).hostname)) return route.abort();
      if (req.method() === "POST" && new URL(req.url()).pathname.replace(/\/$/, "") === "/api/contact") {
        return route.continue({ headers: { ...req.headers(), "x-roundhouse-monitor": MONITOR_SECRET } });
      }
      return route.continue();
    });

    const res = await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT });
    if (!res || res.status() !== 200) throw new Error(`page returned HTTP ${res ? res.status() : "no response"}`);
    const forms = page.locator('form:has(input[name="referral_code"])');
    let form = null;
    for (let i = 0; i < (await forms.count()); i++) {
      if (await forms.nth(i).isVisible()) {
        form = forms.nth(i);
        break;
      }
    }
    if (!form) throw new Error("no visible shared lead form on the page");
    await form.scrollIntoViewIfNeeded().catch(() => {});
    await page
      .waitForFunction((el) => el && el.noValidate === true, await form.elementHandle(), { timeout: HYDRATE_TIMEOUT })
      .catch(() => {
        throw new Error("the form's JavaScript never started (form did not hydrate)");
      });

    const today = new Date().toISOString().slice(0, 10);
    const standard = {
      name: "Roundhouse Monitor",
      phone: "(512) 555-0142",
      email: "monitor@getroundhouse.com",
      message: `Daily end-to-end form check ${today}. Sent to a test inbox only, never to the client.`,
    };
    const controls = form.locator("input, textarea, select");
    const checkedRadios = new Set();
    for (let i = 0; i < (await controls.count()); i++) {
      const el = controls.nth(i);
      const name = (await el.getAttribute("name")) || "";
      const type = ((await el.getAttribute("type")) || "").toLowerCase();
      const tag = await el.evaluate((n) => n.tagName.toLowerCase());
      if (!name || name === "referral_code" || type === "hidden" || type === "submit" || !(await el.isVisible())) continue;
      if (tag === "select") {
        const value = await el.evaluate((sel) => [...sel.options].find((o) => o.value && !o.disabled)?.value ?? "");
        if (value) await el.selectOption(value);
      } else if (type === "checkbox") {
        await el.check();
      } else if (type === "radio") {
        if (!checkedRadios.has(name)) {
          await el.check();
          checkedRadios.add(name);
        }
      } else {
        await el.fill(standard[name] ?? "Monitor check");
      }
    }

    // A person takes more than a couple of seconds; so does the monitor.
    await page.waitForTimeout(3000);
    const responsePromise = page.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname.replace(/\/$/, "") === "/api/contact",
      { timeout: SUBMIT_TIMEOUT }
    );
    await form.locator('button[type="submit"]').first().click();
    const response = await responsePromise.catch(() => {
      throw new Error(
        "submitting a valid lead never reached /api/contact" + (pageErrors.length ? ` (page errors: ${pageErrors.join(" | ")})` : "")
      );
    });
    const data = await response.json().catch(() => null);
    if (!data) throw new Error(`/api/contact answered HTTP ${response.status()} with no JSON — a real visitor would see an error`);
    const m = data.monitor;
    if (!m) {
      throw new Error(
        `the site did not recognise the monitor (HTTP ${response.status()}) — it may not be on package 2.7.0 or LEAD_MONITOR_SECRET is missing on Vercel. CHECK THE CLIENT'S INBOX: a real test lead may have been delivered.`
      );
    }
    const problems = [];
    if (m.withheld) problems.push(`a valid lead was WITHHELD by "${m.withheld}" (${m.matched})`);
    if (m.validation) problems.push(`the server rejected a valid lead: ${JSON.stringify(m.validation)}`);
    if (m.flags?.length) problems.push(`a clean lead was flagged: ${m.flags.join(" | ")}`);
    if (m.email && m.email !== "sent") problems.push(`the lead email would NOT have sent: ${m.email}`);
    if (m.sheetConfigured === false) problems.push("GOOGLE_SHEET_WEBHOOK is not set — leads are not reaching the client's sheet");
    if (m.blockedLogConfigured === false) problems.push("BLOCKED_LOG_WEBHOOK is not set — withheld leads leave no central record");
    if (m.clientRecipients === 0) problems.push("no client email recipients are configured");
    if (problems.length) throw new Error(problems.join("; "));

    passes.push(label);
  } catch (err) {
    failures.push({ site: siteName, url, problem: `end-to-end: ${err.message}` });
  } finally {
    await context.close();
  }
}

async function checkThankYou(siteName, url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "RoundhouseFormMonitor/1.0" }, redirect: "follow" });
    if (res.status !== 200) throw new Error(`thank-you page returned HTTP ${res.status}`);
    const html = await res.text();
    if (!html.includes("tel:")) throw new Error("thank-you page has no click-to-call link");
    passes.push(`${siteName}: ${url}`);
  } catch (err) {
    failures.push({ site: siteName, url, problem: err.message });
  }
}

const browser = await chromium.launch();
try {
  for (const site of selected) {
    for (const url of site.formPages) await checkFormPage(browser, site.name, url);
    if (site.e2e) await checkEndToEnd(browser, site.name, site.formPages[0]);
    if (site.thankYou) await checkThankYou(site.name, site.thankYou);
  }
} finally {
  await browser.close();
}

console.log(`\nPASSED (${passes.length})`);
for (const p of passes) console.log(`  ✓ ${p}`);
if (failures.length) {
  console.log(`\nFAILED (${failures.length})`);
  for (const f of failures) console.log(`  ✗ ${f.site}: ${f.url}\n      ${f.problem}`);
}

if (failures.length && process.env.RESEND_API_KEY) {
  const to = (process.env.ALERT_TO || "support@getroundhouse.com").split(",").map((s) => s.trim());
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
  const rows = failures
    .map(
      (f) =>
        `<tr><td style="padding:8px;border:1px solid #e5e7eb;font-weight:bold;">${esc(f.site)}</td>` +
        `<td style="padding:8px;border:1px solid #e5e7eb;"><a href="${esc(f.url)}">${esc(f.url)}</a><br>${esc(f.problem)}</td></tr>`
    )
    .join("");
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : "";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Roundhouse Form Monitor <leads@resend.getroundhouse.com>",
      to,
      subject: `⚠️ Contact form problem on ${[...new Set(failures.map((f) => f.site))].join(", ")}`,
      html: `<div style="font-family:Arial,sans-serif;max-width:640px">
        <h2 style="margin:0 0 12px">A contact form check failed</h2>
        <p>The daily monitor found ${failures.length} problem${failures.length === 1 ? "" : "s"}. A broken form means real leads may be getting lost right now.</p>
        <table style="border-collapse:collapse;width:100%">${rows}</table>
        ${runUrl ? `<p style="margin-top:16px"><a href="${runUrl}">Full run log</a></p>` : ""}
        <p style="color:#6b7280;font-size:13px">The monitor checks that each form loads, runs and shows its validation message, and sends one test lead per site through the real server to a test inbox — never to the client.</p>
      </div>`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  console.log(data?.id ? `\nAlert email sent (${data.id})` : `\nAlert email FAILED: ${res.status} ${JSON.stringify(data)}`);
}

process.exit(failures.length ? 1 : 0);
