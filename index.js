/**
 * Roundhouse shared contact-form spam filter.
 *
 * This is the CONTENT layer. It runs in addition to the four standard layers
 * (honeypot, origin check, time token, basic content patterns) that live in
 * each client's /api/contact route — it does not replace them.
 *
 * Every rule here was derived from real spam submissions across Alpha Omega,
 * Newmans, and Indiana Flow. Before adding a term, check it against real leads:
 * words like "video", "website", "business" and "scope of work" all appear in
 * legitimate paying inquiries and must never be blocked.
 */

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
];

// TLDs no real customer sends from.
export const BLOCKED_TLDS = [".bid", ".xyz", ".top", ".click", ".loan"];

// Repeat offenders that rotate names and wording but reuse a number.
// Digits only — the checker strips formatting before comparing.
export const BLOCKED_PHONES = [
  "3072076448", // SEO spam: "Brown Miller" (Alpha Omega), "Anette Smith" (Newmans)
];

// ── Keyword phrases ──────────────────────────────────────────────
// Matched case-insensitively against name + message, with word boundaries.
export const SPAM_PHRASES = {
  virtualAssistant: [
    "virtual assistant",
    "virtual assistants",
    "mavis",
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
    "open to selling",
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
    "first page of google",
    "digital marketing agency",
    "more leads guaranteed",
    "lead generation service",
  ],
  videoBranding: [
    "explainer video",
    "30 second video",
    "60 second video",
    "voice-over",
    "visual identity",
    "brand identity",
    "logo design",
    "web design services",
    "redesign your website",
  ],
  coldOutreach: [
    "i came across your website",
    "i just visited your website",
    "came across your site",
    "noticed your website",
    "quick zoom demo",
    "no obligation",
    "reply yes and i",
    "didn't want to interrupt your workday",
  ],
  offTopic: [
    "deneme bonusu",
    "bonus veren",
    "bahis",
    "casino",
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

export default checkSpam;
