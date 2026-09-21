# @roundhouse/spam-filter

Shared contact-form spam filter for Roundhouse client sites. One list, every client.

## v2: the whole contact form (use this for every site)

Since 2.0.0 the package also holds the **entire** lead pipeline, so no site carries its
own copy of form or route logic. Per-site copies drifted, and real leads were lost in
the gaps between them.

| Import | What it is |
|---|---|
| `@roundhouse/spam-filter/form` | `<LeadForm>` — the client form. Visible per-field messages, time token in a ref, off-screen honeypot, conversions only on `delivered`. |
| `@roundhouse/spam-filter/lead` | `handleLead(req, config)` — the whole API route. |
| `@roundhouse/spam-filter/validate` | The field rules and messages, shared by both. |
| `@roundhouse/spam-filter/env` | `checkLeadEnv()` — fails a production build with no delivery settings. |
| `@roundhouse/spam-filter/conversion` | `<LeadConversion onLead>` — on the thank-you page: fires conversions once per delivered lead (`?lead=` id → Ads `transaction_id`), never on a bare visit. |

**Thank-you page (standard, 2026-09-16):** pass `thankYouPath="/thank-you"` to `<LeadForm>`.
Only a delivered lead is sent there, as `/thank-you?lead=<id>`; blocked spam keeps the
in-place `success`. The thank-you page renders `<LeadConversion onLead={…}>` with the site's
GA events and Google Ads conversion (`transaction_id: leadId`), leads with a prominent call
button, is `noindex`, and is not in the sitemap. Never fire a conversion on a bare page load.

**Rules (Philip, 2026-09-16):** name, phone, email and message are all required. Phone
must be exactly 10 US digits (a leading 1 is dropped). Message max 600 characters; one
link allowed in the message (2.10.0 — two or more get a visible message), none in the name. Every mistake a person can make gets a specific
visible message. No "Unverified" subject line.

**When in doubt, deliver it (2.6.0, Philip 2026-09-16).** A real lead silently withheld
costs a client a job; a spam email costs them a delete. So `handleLead` **withholds**
(silent success, full row in the central log) only what a customer can't produce:

- an oversized body, or `Sec-Fetch-Site: cross-site`
- a blocklisted email domain or phone number (confirmed repeat spammers), or a blocklisted site (`BLOCKED_SITES`) or number written into the name or message
- a known bot template phrase (`BLOCKED_MESSAGES`, 2.12.0) **anywhere** in the name, message or an extra field, whatever else is written — e.g. "I would like more information. Please contact me by email". A deliberate exception to deliver-when-in-doubt (Philip, 2026-09-21)
- HTML/BBCode link markup (`<a href=`, `[url=`, `[link=`) in any field (2.10.0) — link-spam bots paste it, people don't
- a flood: over 30 deliverable submissions from one IP in 10 minutes
- **two automation signals together**, at least one strong — strong: honeypot filled
  without autofill, submitted under 1.5s, no Origin/Referer at all, Referer is an
  `/api/` path; supporting: no JavaScript, foreign origin, autofilled honeypot

Everything else that used to block is **delivered to the client and flagged**
(`delivered-flagged` row, never shown to the client, never an urgent alert): keyword
phrases, odd TLDs, gibberish, Cyrillic/Greek, a foreign origin (a domain missing from
`allowedOrigins`), a single timing or honeypot signal, no JavaScript, more than 5 leads
from one IP. Review the flagged rows to tune the rules.

Timing is measured on the visitor's own device (`_elapsed`). Until 2.6.0 the server
compared the device's clock to its own, so a phone or PC running a few minutes fast
looked like an instant bot and the lead was dropped with no alert.

**Site setup** — see power-construction-website for the reference implementation:

```ts
// next.config.ts
import { checkLeadEnv } from "@roundhouse/spam-filter/env";
checkLeadEnv();
const nextConfig = { transpilePackages: ["@roundhouse/spam-filter"], /* … */ };

// app/api/contact/route.ts
import { handleLead, type LeadConfig } from "@roundhouse/spam-filter/lead";
const LEAD_CONFIG: LeadConfig = { site, businessName, phone, allowedOrigins, recipients,
  leadsSheetUrl, brandColor, extraFields, successPath };
export const maxDuration = 60; // Apps Script can take 10s+ to answer
export function POST(req: Request) { return handleLead(req, LEAD_CONFIG); }

// app/components/LeadForm.tsx — a thin wrapper: labels, classNames, success notice,
// and onDelivered(leadId) firing the site's GA / Google Ads conversion.
```

Order inside `handleLead`: size / cross-site → automation signals → validation (visible)
→ content (blocklist withheld, the rest flagged) → double-click guard → rate limit →
**full lead written to the Vercel logs** → client sheet and Resend email **in parallel**
→ central log rows for flags and partial failures.

Delivery only counts on a verified answer: the sheet must not answer `{ok:false}`, a
Google sign-in/error page, or the `listening` health check (Apps Script returns all of
those with HTTP 200); the email must return a Resend `id`. Central log rows:

| Layer | Meaning | Urgent |
|---|---|---|
| `delivered-flagged` | Delivered; carries the flags | never |
| `delivered-sheet-failed` | Delivered by email; the sheet didn't record it | no |
| `delivered-email-failed` | In the client's sheet only; the email failed | **yes** |
| `delivery-failed` | Neither — visitor told to call; this row is the lead | **yes** |

`logBlocked` writes the full row to the console first and logs `ROW NOT RECORDED` when the
central script doesn't answer `{ok:true}`, so a withheld lead is recoverable from the
Vercel runtime logs even while the central sheet is broken. `npm test` covers every path
with the network stubbed.

**After pushing a change here, no site gets it until its `package-lock.json` is bumped**
(`npm install @roundhouse/spam-filter@github:RoundhouseTEAM/roundhouse-spam-filter`).

Every rule was derived from real spam across Alpha Omega, Newmans, and Indiana Flow —
not guessed. `test.js` holds those real submissions plus real paying customers, so
changes can be validated against both.

## Install

```bash
npm install github:RoundhouseTEAM/roundhouse-spam-filter
```

## Use

The package covers **layers 3, 4 and 5** of the standard five. The route still owns
the honeypot (1) and the time token (2).

```ts
import { checkOrigin, checkContent, checkSpam, logBlocked } from "@roundhouse/spam-filter";

const SITE = "newmans-plumbing";

// Declare this ABOVE the first check that uses it — a `const` arrow is in the
// temporal dead zone before its declaration, which would throw on every block.
const reject = async (layer: string, matched = "") => {
  await logBlocked({ site: SITE, layer, matched, name, email, phone, message, source, req });
  return NextResponse.json({ ok: true });   // or the site's 303 redirect
};

// Layer 3 — ALWAYS keep ".vercel.app" in the allowlist.
const origin = checkOrigin({
  origin: req.headers.get("origin") ?? "",
  referer: req.headers.get("referer") ?? "",
  allowed: ["newmansplumbingservice.com", "localhost", ".vercel.app"],
});
if (!origin.ok) return reject("origin", origin.reason);

// Layer 4
const content = checkContent({ name, phone, message });
if (content.blocked) return reject(content.layer, content.reason);

// Layer 5
const verdict = checkSpam({ name, email, phone, message });
if (verdict.blocked) return reject(verdict.rule, verdict.reason);
```

`await` the reject — on serverless a fire-and-forget fetch is killed the moment the
response is sent, so the row is never written.

Because **every rejection path returns a fake success**, a form can never be verified
by submitting it and seeing "thanks". Confirm a real email arrived, or read the
Vercel runtime logs.

## Daily monitor, spike alerts and bounce alerts (2.7.0)

- **End-to-end test lead.** `monitor/check.mjs` (GitHub Action, 12:00 UTC) submits one valid
  lead per `"e2e": true` site through the real form in a real browser, with header
  `x-roundhouse-monitor: $LEAD_MONITOR_SECRET`. `handleLead` runs every check, then emails
  `delivered@resend.dev` instead of the client, skips the client sheet and central log, and
  returns `delivered:false` + a `monitor` report. The run fails on a withheld, flagged or
  unemailed lead, or missing delivery env vars. **Set `LEAD_MONITOR_SECRET` on a site's Vercel
  project before giving it `"e2e": true`** — without it the monitor's lead is a REAL lead.
  It does not write the client's sheet, so a broken client sheet script is caught by the
  spike alert on `delivered-sheet-failed` instead.
- **Spike alerts** (Apps Script v7): one email when `delivered-flagged` reaches 10 rows on a
  site in a day, or `delivered-sheet-failed` / `delivered-email-failed` / `delivery-failed`
  reach 10 (sheet failures: 3). Bot floods never trigger it.
- **Bounce alerts:** Resend webhook (`email.bounced`, `email.complained`) →
  `https://roundhouse-cms.vercel.app/api/resend-webhook` (verifies the signature with
  `RESEND_WEBHOOK_SECRET`) → the central log script → an urgent row + immediate email.

## Calling Apps Script (2.8.0)

Apps Script runs the script first, then answers with a 302 to its output. From Vercel the
run takes 20–30s and following the redirect was seen to hang, so `apps-script.js` times
the run and the read separately (`redirect: "manual"`). A 302 proves the script ran; only
`{ok:true}` in the output proves it succeeded. Ran-but-unreadable is **unconfirmed**
(`delivered-sheet-unconfirmed`), never "failed". Central-log rows are written after the
response via Vercel's `waitUntil`, so a visitor never waits on the log.

## Where blocked submissions go, and who hears about it

`logBlocked()` writes one row to the central Roundhouse **Blocked Submissions** sheet
— never a tab in the client's own leads sheet. Clients should not see spam noise, and
one shared log is the only way a portfolio-wide false-positive pattern is visible.

**`logBlocked()` never sends email.** On 2026-09-08 a sqlmap scanner hit Indiana
Flow's `/api/contact` 66 times in 19 minutes; all 66 were blocked correctly and all 66
sent a Resend alert, which put the account over its limit. Blocked-alerts and real
customer lead emails shared one Resend account, so anyone with a shell script could
take out lead delivery for every client at once.

Alerting now lives in the Apps Script behind the sheet
(`docs/blocked-log-apps-script.gs`). It sends on Google Workspace's own quota, and
because it can see the whole log it can rate-limit itself — which a serverless route
never could:

| | |
|---|---|
| **Immediate** | Only rows flagged `urgent`: a block that still has a real name, a dialable phone and an actual message — a lead worth rescuing today. Capped at 3 per site per day. |
| **Daily digest** | One email each morning covering everything else, grouped by site and rule. Nothing to report means no email. |

Set `BLOCKED_LOG_WEBHOOK` to the script's `/exec` URL — ideally as a Vercel
team-level shared variable so it covers every project at once. With no webhook set it
degrades to `console.warn` only, so it is safe to deploy before the sheet exists.

## Rules, in order

1. **Email domain** — confirmed spam senders (`bizbuydave.com`, `vettedvas.com`, …) — withheld
2. **Email TLD** — `.bid`, `.xyz`, `.top`, `.click`, `.loan` — flagged
3. **Phone** — repeat offenders who rotate names but reuse a number — withheld
4. **Keywords** — phrase match on name + message, word-boundary aware — flagged
5. **Gibberish** — long unbroken letter+digit tokens like `NAEWTRER365118NEYHRTGE` — flagged

Keywords are matched against **name and message only** — never phone or email, since
a company name inside an email address would cause false positives.

Text is normalized before matching (curly quotes → straight, dashes, whitespace).
Real spam in the data used `’` and `“ ”`; without this, phrases silently miss.

## Adding a term — read this first

The expensive failure is a **false positive**: a real customer silently dropped.
That costs a job. A spam message getting through costs an email.

These all appear in **real paying leads** and must never be added:

| Never block | Because |
|---|---|
| `video` | "sewer snake video", "camera inspection with video report" |
| `website` | "I saw your website" |
| `business` | "my business has a clogged drain" |
| `scope of work` | Used in a real federal contract inquiry (Hickam AFB) |
| `google` | Customers mention finding you on Google |
| `marketing`, `seo` alone | Too broad — use the longer phrases instead |

Prefer **multi-word phrases** over single words, and prefer the **domain list** over
keywords when a sender is clearly a known spammer — it is exact and has no false-positive risk.

After any edit:

```bash
npm test
```

25 real cases must stay green. If a change breaks a MUST_PASS case, the term is too broad.

## Rolling out an update

Client sites pin this **by resolved git commit in `package-lock.json`**, so pushing
here reaches no site until each repo's lockfile is bumped. A fix once sat live on only
2 of 9 sites for 8 days because of this.

```bash
# in each client project
npm update @roundhouse/spam-filter     # rewrites the pinned commit in package-lock.json
git commit -am "Bump spam filter"      # the lockfile change is the part that ships
git push                               # Vercel deploys on push
```

Confirm with `grep roundhouse-spam-filter package-lock.json` — the commit hash there
is what actually deploys.

## Testing

```bash
npm test
```

Three suites: the keyword rules against 46 real submissions (spam *and* real paying
customers), the blocked-submission recorder, and the Apps Script — which is loaded
into a stubbed Google runtime and driven through the 2026-09-08 flood, the per-site
cap and the digest. That last suite matters because the script's failure mode is
silence: if it breaks, nobody is told about a wrongly blocked lead.
