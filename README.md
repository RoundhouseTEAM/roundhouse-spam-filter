# @roundhouse/spam-filter

Shared contact-form spam filter for Roundhouse client sites. One list, every client.

Every rule was derived from real spam across Alpha Omega, Newmans, and Indiana Flow —
not guessed. `test.js` holds those real submissions plus real paying customers, so
changes can be validated against both.

## Install

```bash
npm install github:RoundhouseDM/roundhouse-spam-filter
```

## Use

This is the **content layer**. It runs *in addition to* the four standard layers
(honeypot, origin check, time token, basic content patterns) — it does not replace them.

```ts
import { checkSpam } from "@roundhouse/spam-filter";

// ...after the four standard layers pass...
const verdict = checkSpam({ name, email, phone, message });

if (verdict.blocked) {
  // Log to the Blocked tab for auditing, then return success so bots learn nothing.
  await fetch(process.env.GOOGLE_SHEET_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tab: "Blocked", name, phone, email, message,
                           reason: `${verdict.rule}: ${verdict.reason}` }),
  });
  return NextResponse.json({ ok: true });
}
```

`verdict` is `{ blocked, rule, reason }` — e.g.
`{ blocked: true, rule: "keyword:seoMarketing", reason: "rank better" }`.
Always log `rule` and `reason` so false positives can be traced to the exact term.

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

Client sites pin this by commit, so updating the list is two steps:

```bash
# in each client project
npm update @roundhouse/spam-filter
npx vercel deploy --prod --token <TOKEN> --yes --scope support-2355s-projects
```
