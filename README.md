# @roundhouse/spam-filter

Shared contact-form spam filter for Roundhouse client sites. One list, every client.

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

1. **Email domain** — confirmed spam senders (`bizbuydave.com`, `vettedvas.com`, …)
2. **Email TLD** — `.bid`, `.xyz`, `.top`, `.click`, `.loan`
3. **Phone** — repeat offenders who rotate names but reuse a number
4. **Keywords** — phrase match on name + message, word-boundary aware
5. **Gibberish** — long unbroken letter+digit tokens like `NAEWTRER365118NEYHRTGE`

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
