/**
 * Roundhouse shared contact-form spam filter.
 *
 * This is the CONTENT layer. It runs in addition to the four standard layers
 * (honeypot, origin check, time token, basic content patterns) that live in
 * each client's /api/contact route — it does not replace them.
 *
 * Since 2.6.0 handleLead() WITHHOLDS a lead only on the email-domain and phone
 * blocklists. Every other match here (keywords, TLDs, gibberish, non-Latin) is
 * delivered to the client and flagged in the central log — see lead.js.
 *
 * Every rule here was derived from real spam submissions across Alpha Omega,
 * Newmans, and Indiana Flow. Before adding a term, check it against real leads:
 * words like "video", "website", "business" and "scope of work" all appear in
 * legitimate paying inquiries and must never be blocked.
 */

// The blocked-submission recorder lives alongside the filter so every consumer
// gets it from the same import. It never affects verdicts — it only writes them down.
export { logBlocked } from "./log-blocked.js";

// ── Email domains ────────────────────────────────────────────────
// Confirmed spam senders. Several have hit more than one client.
export const BLOCKED_EMAIL_DOMAINS = [
  "bizbuydave.com",
  "getdandynow.com",
  "dandyaisoftware.com",
  "vettedvas.com",
  "toptalentvas.com",
  "vasdirect.com",
  "virtualhelpdesk.pro",
  "virtualteamexpert.com",
  "threadproxy.com",
  "integribridge.com",
  "fringmail.com",
  "mailturk.xyz",
  "tidyhome.info", // guest-post pitch, IrriGators 2026-08-20
  "svarklar.com", // "AI employee" pitch, Newmans 2026-08-28 (covers mail.svarklar.com)
  "zacharyjackson.rocks", // Philip, 2026-09-17
];

// Websites confirmed spammers promote. A lead that MENTIONS one of these (or any
// BLOCKED_EMAIL_DOMAINS entry) in its name or message is withheld, whatever address
// it was sent from. Bare domain, lowercase — subdomains and "www." are covered.
export const BLOCKED_SITES = [
  "adsmogul.com", // ad-agency pitch, Philip 2026-09-17
];

// TLDs no real customer sends from.
export const BLOCKED_TLDS = [".bid", ".xyz", ".top", ".click", ".loan"];

// Repeat offenders that rotate names and wording but reuse a number.
// Digits only — the checker strips formatting before comparing.
export const BLOCKED_PHONES = [
  "3072076448", // SEO spam: "Brown Miller" (Alpha Omega), "Anette Smith" (Newmans)
  "8058008141", // AdsMogul pitch, Philip 2026-09-17
];

// ── Keyword phrases ──────────────────────────────────────────────
// Matched case-insensitively against name + message, with word boundaries.
export const SPAM_PHRASES = {
  virtualAssistant: [
    "virtual assistant",
    "virtual assistants",
    "my advanced virtual intelligent system",
    "20 man team",
    "20-person team",
    "20 person team",
    "delegate to a human",
    "are you looking for help?",
    "offshore staff",
    "outsourcing team",
  ],
  businessAcquisition: [
    "interested in selling your",
    "buyers interested in purchasing",
    "selling your business",
    "sell your business",
    "purchasing businesses in your industry",
    // "open to selling" removed 2026-09-16: "we're open to selling the house after the repair".
  ],
  seoMarketing: [
    "rank better",
    "rank higher",
    "search engine optimization",
    "seo audit",
    "seo services",
    "backlinks",
    "link building",
    "guest post",
    "helped hundreds of businesses",
    "boost your rankings",
    // "first page of google" removed 2026-09-16: "found you on the first page of Google".
    "digital marketing agency",
    "more leads guaranteed",
    "lead generation service",
  ],
  // Guest-post / "let me write for you" pitches. These arrive from real people
  // with real phone numbers, so only the wording gives them away, and they
  // rotate domains constantly — the phrases matter more than the blocklist.
  //
  // Deliberately "write an article", never bare "article": a real customer
  // saying "I read your article about winterizing sprinklers" is a warm lead
  // and must get through. See the MUST_PASS case guarding exactly that.
  guestPosting: [
    "write an article",
    "write articles",
    "craft articles",
    "contribute an article",
    "contribute a post",
    "publish an article",
    "share an outline",
    "your readers would",
    "alternative topic",
    "write on a subject of your choice",
  ],
  videoBranding: [
    "explainer video",
    // "30/60 second video" removed 2026-09-16: "I can send a 30 second video of the leak".
    "voice-over",
    "visual identity",
    "brand identity",
    "logo design",
    "web design services",
    "redesign your website",
  ],
  // Vendor-side wording ONLY. Everything here must be something a homeowner would
  // never write.
  //
  // Seven phrases were REMOVED on 2026-08-31 after an audit found them blocking 6
  // of 12 natural customer opening lines: "i came across your website", "i just
  // visited your website", "came across your site", "noticed your website", "i
  // found you through your website", "found you through your google listing" and
  // "no obligation". Every one of those is exactly how a real customer opens a
  // contact form, and because rejection returns a fake success they vanished
  // without trace. Do not put them back — see the MUST_PASS cases guarding them.
  coldOutreach: [
    "quick zoom demo",
    // "reply yes and i" removed 2026-09-16: "please reply yes and I will send pictures".
    "didn't want to interrupt your workday",
    "what i do with your details",
  ],
  // AI / automation sales pitches. A newer genre than the rest of this list —
  // the SvarKlar pitch that reached Newmans on 2026-08-28 passed all five
  // layers because nothing here described it. These are all vendor-side
  // wording: a homeowner reporting a leak never uses any of them.
  //
  // Note what is NOT here: "would that be helpful?" was in the original pitch
  // but a real customer offering photos of a leak writes exactly that, so it
  // stays out. See the MUST_PASS case.
  aiAutomation: [
    "ai employee",
    "ai employees",
    "ai receptionist",
    "ai voice agent",
    "ai chatbot",
    "ai agent for your business",
    "automating the office work",
    "automate the office work",
    "automate your office work",
    "without you needing to learn anything",
    "never miss another call",
    // "on autopilot" removed 2026-09-16: "our sprinklers run on autopilot but zone 3 is broken".
  ],
  offTopic: [
    "deneme bonusu",
    "bonus veren",
    "bahis",
    // "casino" removed 2026-09-16: a commercial kitchen AT a casino is a real job.
    "crypto",
    "bitcoin",
    "forex",
    "nato allies",
    "business loan",
    "merchant cash advance",
    "payday loan",
  ],
};

/**
 * Normalizes text so curly quotes and odd whitespace can't defeat a match.
 * Real spam in the data used ’ and “ ” — without this, phrases silently miss.
 */
function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary match so "crypto" can't fire inside an unrelated word and
 * "seo audit" only matches as a phrase.
 */
function containsPhrase(haystack, phrase) {
  const escaped = escapeRegex(phrase);
  const prefix = /^\w/.test(phrase) ? "\\b" : "";
  const suffix = /\w$/.test(phrase) ? "\\b" : "";
  return new RegExp(`${prefix}${escaped}${suffix}`, "i").test(haystack);
}

/**
 * A blocklisted domain or phone number mentioned in free text. Domains match on a
 * label boundary ("www.adsmogul.com", "https://AdsMogul.com/x") but not inside a
 * longer name ("notadsmogul.com"). Phone numbers match in any common US format.
 */
function findBlockedMention(text) {
  const value = String(text ?? "").toLowerCase();
  for (const domain of [...BLOCKED_SITES, ...BLOCKED_EMAIL_DOMAINS]) {
    const re = new RegExp(`(^|[^a-z0-9-])${escapeRegex(domain)}(?![a-z0-9-]|\\.[a-z0-9])`);
    if (re.test(value)) return domain;
  }
  const phones = value.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) ?? [];
  for (const raw of phones) {
    const digits = raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (BLOCKED_PHONES.includes(digits)) return digits;
  }
  return null;
}

/**
 * HTML or BBCode link markup — `<a href=…>`, `[url=…]`, `[link=…]`. Link-spam bots paste
 * it hoping the text gets published somewhere it renders; a person typing into a
 * contact form never writes it. Philip, 2026-09-18, after a Power Construction lead
 * carried ten `<a href=https://dog-house.sbs/>` casino links.
 *
 * @returns {string} the markup that matched, or "" when there is none.
 */
export function findLinkMarkup(text) {
  const m = String(text ?? "").match(/<a\s[^>]*href|\[(?:url|link)[=\]]/i);
  return m ? m[0] : "";
}

/**
 * Catches keyboard-mash submissions like "NAEWTRER365118NEYHRTGE" —
 * one long unbroken token mixing letters and digits, mostly uppercase.
 */
function looksLikeGibberish(raw) {
  const value = String(raw ?? "").trim();
  if (value.length < 12 || /\s/.test(value)) return false;
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;

  const letters = value.replace(/[^A-Za-z]/g, "");
  if (letters.length < 6) return false;

  const upperRatio = (letters.match(/[A-Z]/g) || []).length / letters.length;
  return upperRatio > 0.7;
}

/**
 * @param {{name?: string, email?: string, phone?: string, message?: string}} input
 * @returns {{blocked: boolean, reason?: string, rule?: string}}
 */
export function checkSpam(input = {}) {
  const { name = "", email = "", phone = "", message = "" } = input;

  const emailNorm = normalize(email);
  if (emailNorm.includes("@")) {
    const domain = emailNorm.split("@").pop() ?? "";

    const hitDomain = BLOCKED_EMAIL_DOMAINS.find(
      (d) => domain === d || domain.endsWith(`.${d}`)
    );
    if (hitDomain) {
      return { blocked: true, rule: "email-domain", reason: hitDomain };
    }

    const hitTld = BLOCKED_TLDS.find((tld) => domain.endsWith(tld));
    if (hitTld) {
      return { blocked: true, rule: "email-tld", reason: hitTld };
    }
  }

  const phoneDigits = String(phone ?? "").replace(/\D/g, "");
  if (phoneDigits && BLOCKED_PHONES.includes(phoneDigits)) {
    return { blocked: true, rule: "phone", reason: phoneDigits };
  }

  // A blocklisted site or number written INTO the name or message. Spammers put
  // their own number in the text and a real one in the phone field.
  const mention = findBlockedMention(`${name} ${message}`);
  if (mention) return { blocked: true, rule: "mention", reason: mention };

  const markup = findLinkMarkup(`${name} ${message}`);
  if (markup) return { blocked: true, rule: "link-markup", reason: markup };

  // Name and message only. Never scan the phone or email for keywords —
  // an address or company name in an email would cause false positives.
  const haystack = normalize(`${name} ${message}`);
  for (const [category, phrases] of Object.entries(SPAM_PHRASES)) {
    const hit = phrases.find((phrase) => containsPhrase(haystack, normalize(phrase)));
    if (hit) {
      return { blocked: true, rule: `keyword:${category}`, reason: hit };
    }
  }

  if (looksLikeGibberish(name) || looksLikeGibberish(message)) {
    return { blocked: true, rule: "gibberish", reason: "unreadable name or message" };
  }

  return { blocked: false };
}

// ── Layer 3: origin / referer ────────────────────────────────────
// Lived inline and identical in all 17 contact routes until 2026-09-08. It is here
// so the referer rule below only had to be written once.

/** A referer pointing at an API endpoint is never a real form submission. */
function isApiReferer(referer) {
  try {
    return new URL(referer).pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

/**
 * Layer 3. A header must be PRESENT and allowlisted — "validate only if present"
 * lets a script that omits the header skip the check entirely (the 2026-08-14
 * bypass). Browsers send Origin on fetch() POSTs and Referer on native form posts,
 * so a genuine submission always carries at least one.
 *
 * The referer must also not point at an API path. A browser posting a form sends
 * the PAGE as the referer; sqlmap and friends send the endpoint they are hammering.
 * On 2026-09-08 that was the only thing separating 66 injection probes from a real
 * submission: blank Origin, and `Referer: https://www.indianaflow.com/api/contact`.
 * They passed this layer on the domain match and were only stopped further down, at
 * a layer that emailed on every hit.
 *
 * @param {object} input
 * @param {string} input.origin   The Origin header, "" when absent.
 * @param {string} input.referer  The Referer header, "" when absent.
 * @param {string[]} input.allowed Domain fragments, e.g. ["example.com", "localhost", ".vercel.app"].
 *        ALWAYS keep ".vercel.app" — client sites live on their preview URL for the
 *        whole build-and-review period, and every rejection returns a fake success,
 *        so an over-tight allowlist silently discards real leads and looks fine.
 * @returns {{ok: boolean, reason: string}}
 */
export function checkOrigin(input = {}) {
  const origin = String(input.origin ?? "");
  const referer = String(input.referer ?? "");
  const allowed = input.allowed ?? [];

  const originOk = origin !== "" && allowed.some((a) => origin.includes(a));
  const refererOk =
    referer !== "" && allowed.some((a) => referer.includes(a)) && !isApiReferer(referer);

  if (originOk || refererOk) return { ok: true, reason: "" };
  return {
    ok: false,
    reason: `origin="${origin}" referer="${referer}"${
      referer !== "" && isApiReferer(referer) ? " (referer is an API path)" : ""
    }`,
  };
}

// ── Layer 4: content patterns ────────────────────────────────────

/**
 * Layer 4. Bot-typical content: an undialable phone, a URL in a text field, or
 * non-Latin script.
 *
 * Each returns its OWN layer name rather than a shared "content". They behave
 * nothing alike: "phone under 7 digits" is the highest-volume and lowest-value rule
 * in the whole filter (66 of 66 sqlmap probes on 2026-09-08, and a submission with
 * no dialable number is not a rescuable lead either way), while a URL or Cyrillic
 * false positive is a real customer worth chasing the same day. Merged under one
 * label there was no way to treat them differently.
 *
 * @param {object} input
 * @param {boolean} [input.nonLatin=true] Whether Cyrillic/Greek is a spam signal.
 *        True for every current Roundhouse client — they are English-language US
 *        service businesses. Set false for a client with a multilingual customer
 *        base, where this would block real people.
 * @returns {{blocked: boolean, layer?: string, reason?: string}}
 */
export function checkContent(input = {}) {
  const name = input.name ?? "";
  const message = input.message ?? "";
  const haystack = `${name} ${message}`;
  const phoneDigits = String(input.phone ?? "").replace(/\D/g, "");
  const nonLatin = input.nonLatin !== false;
  // handleLead() passes true: links are allowed in the message (Philip, 2026-09-16), and
  // a link in the name is a visible validation error there, not a silent block. Routes
  // not yet migrated keep the old behaviour.
  const allowMessageUrls = input.allowMessageUrls === true;

  if (phoneDigits.length < 7) {
    return { blocked: true, layer: "content:short-phone", reason: "phone under 7 digits" };
  }
  const urlHaystack = allowMessageUrls ? name : haystack;
  if (/https?:\/\/|www\./i.test(urlHaystack)) {
    return { blocked: true, layer: "content:url", reason: allowMessageUrls ? "url in name" : "url in name or message" };
  }
  if (nonLatin && /[\u0400-\u04FF\u0370-\u03FF]/.test(haystack)) {
    return { blocked: true, layer: "content:non-latin", reason: "non-Latin script" };
  }
  return { blocked: false };
}

export default checkSpam;
