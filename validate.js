/**
 * Roundhouse lead-form validation — the ONE definition of what a valid lead looks like.
 *
 * Imported by the browser form (so the visitor is told before anything is sent) and by
 * the server handler (so a submission that skipped the browser gets the same answer).
 * Because both read this file, the message a visitor sees can never drift from the rule
 * the server enforces — which is exactly how leads were being lost before: the browser
 * allowed a 6-digit phone, the server silently discarded it as bot content, and the
 * visitor got a thank-you over a lead that no longer existed.
 *
 * The rule for what belongs here (Philip, 2026-09-16): every mistake a REAL PERSON can
 * make gets a specific, visible message telling them how to fix it. Signals that only a
 * bot produces (honeypot, timing, origin, non-Latin script, keyword/domain list) are NOT
 * validation — they stay silent and are logged centrally, so spammers can't learn to
 * rephrase around them.
 */

/** Hard ceiling on the message box. Philip, 2026-09-16. */
export const MESSAGE_MAX = 600;
export const NAME_MAX = 100;
export const EMAIL_MAX = 254;
export const EXTRA_FIELD_MAX = 200;

/** The four fields every Roundhouse lead form has, all required. */
export const STANDARD_FIELDS = ["name", "phone", "email", "message"];

export const MESSAGES = {
  nameMissing: "Please enter your name.",
  nameNoLetters: "Please enter your name using letters.",
  nameHasLink: "Please enter just your name — no links.",
  nameTooLong: `Please keep your name under ${NAME_MAX} characters.`,
  phoneMissing: "Please enter your phone number.",
  phoneLength: "Please enter a 10-digit phone number.",
  phoneAreaCode: "That phone number doesn't look right — please check the area code.",
  emailMissing: "Please enter your email address.",
  emailInvalid: "Please enter a valid email address, like name@example.com.",
  messageMissing: "Please tell us a little about what you need.",
  messageTooLong: `Please keep your message under ${MESSAGE_MAX} characters.`,
  consentMissing: "Please check the box to agree to be contacted.",
};

/** How a checked checkbox arrives: "yes" from the shared form, "on" from a native post. */
export function isChecked(value) {
  return /^(yes|on|true|1)$/i.test(String(value ?? "").trim());
}

/** Shown when the request never reached the server (visitor offline, network drop). */
export function offlineMessage(phone) {
  return `We couldn't reach our server. Check your connection and try again, or call us at ${phone}.`;
}

/** Shown when the lead reached the server but could not be recorded anywhere. */
export function deliveryFailedMessage(phone) {
  return `We couldn't send your request. Please call us at ${phone} and we'll take care of it.`;
}

/**
 * US numbers only — every Roundhouse client serves US customers. Formatting is ignored,
 * and a leading country code 1 is dropped so "1-512-555-0100" and "+1 (512) 555-0100"
 * both count as the 10 digits people mean.
 *
 * @returns {string} the 10 digits, or "" if the input can't be one.
 */
export function normalizePhone(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits;
}

const LINK = /https?:\/\/|www\.|\.(com|net|org|io|co|info|biz|xyz)\b/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateName(value) {
  const v = String(value ?? "").trim();
  if (!v) return MESSAGES.nameMissing;
  if (LINK.test(v)) return MESSAGES.nameHasLink;
  if (!/\p{L}/u.test(v)) return MESSAGES.nameNoLetters;
  if (v.length > NAME_MAX) return MESSAGES.nameTooLong;
  return "";
}

function validatePhone(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return MESSAGES.phoneMissing;
  const digits = normalizePhone(raw);
  if (digits.length !== 10) return MESSAGES.phoneLength;
  // A US area code never starts with 0 or 1.
  if (/^[01]/.test(digits)) return MESSAGES.phoneAreaCode;
  return "";
}

function validateEmail(value) {
  const v = String(value ?? "").trim();
  if (!v) return MESSAGES.emailMissing;
  if (v.length > EMAIL_MAX || !EMAIL.test(v)) return MESSAGES.emailInvalid;
  return "";
}

function validateMessage(value) {
  const v = String(value ?? "").trim();
  if (!v) return MESSAGES.messageMissing;
  // Links ARE allowed in the message (Philip, 2026-09-16) — customers paste Maps and
  // listing links. Only the name rejects them.
  if (v.length > MESSAGE_MAX) return MESSAGES.messageTooLong;
  return "";
}

/**
 * Every field a PERSON can see is required (Philip, 2026-09-16): if we show a field we
 * want it filled in. So an extra field is required unless it is `hidden` — a value the
 * page supplies itself (e.g. the service a page is about), never shown to the visitor.
 * `required: false` is still honoured as an explicit, deliberate exception.
 */
export function isRequiredExtra(field) {
  if (field.hidden) return false;
  return field.required !== false;
}

function validateExtra(field, value) {
  const v = String(value ?? "").trim();
  const label = field.label || field.name;
  const required = isRequiredExtra(field);
  if (field.checkbox) {
    // e.g. an express-consent checkbox (Proverbs, carried over from Duda).
    return required && !isChecked(v) ? field.requiredMessage || MESSAGES.consentMissing : "";
  }
  if (!v) {
    return required ? field.requiredMessage || `Please enter your ${label.toLowerCase()}.` : "";
  }
  const max = field.maxLength ?? EXTRA_FIELD_MAX;
  if (v.length > max) return `Please keep your ${label.toLowerCase()} under ${max} characters.`;
  if (Array.isArray(field.options) && field.options.length && !field.options.includes(v)) {
    return `Please choose your ${label.toLowerCase()} from the list.`;
  }
  return "";
}

const STANDARD_VALIDATORS = {
  name: validateName,
  phone: validatePhone,
  email: validateEmail,
  message: validateMessage,
};

/**
 * Validates one field. Used by the form on blur so a mistake is flagged as soon as the
 * visitor leaves the field, not only on submit.
 */
export function validateField(name, value, extraFields = []) {
  if (STANDARD_VALIDATORS[name]) return STANDARD_VALIDATORS[name](value);
  const extra = extraFields.find((f) => f.name === name);
  return extra ? validateExtra(extra, value) : "";
}

/**
 * Validates a whole submission.
 *
 * @param {Record<string, unknown>} values
 * @param {Array<{name: string, label?: string, required?: boolean, maxLength?: number, options?: string[]}>} [extraFields]
 * @returns {Record<string, string>} field name -> message. Empty object means valid.
 */
export function validateLead(values = {}, extraFields = []) {
  const errors = {};
  for (const name of STANDARD_FIELDS) {
    const msg = STANDARD_VALIDATORS[name](values[name]);
    if (msg) errors[name] = msg;
  }
  for (const field of extraFields) {
    const msg = validateExtra(field, values[field.name]);
    if (msg) errors[field.name] = msg;
  }
  return errors;
}

/**
 * Common email-domain typos. A suggestion only — it never blocks, because an unusual
 * domain can be perfectly real.
 */
const DOMAIN_TYPOS = {
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gamil.com": "gmail.com",
  "gnail.com": "gmail.com",
  "gmail.co": "gmail.com",
  "gmail.con": "gmail.com",
  "gmaill.com": "gmail.com",
  "yaho.com": "yahoo.com",
  "yahooo.com": "yahoo.com",
  "yahoo.co": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "hotmial.com": "hotmail.com",
  "hotmai.com": "hotmail.com",
  "hotmail.co": "hotmail.com",
  "outlok.com": "outlook.com",
  "outlook.co": "outlook.com",
  "iclod.com": "icloud.com",
  "icloud.co": "icloud.com",
  "aol.co": "aol.com",
  "comcast.ent": "comcast.net",
};

/** @returns {string} the corrected address, or "" when there's nothing to suggest. */
export function suggestEmail(value) {
  const v = String(value ?? "").trim();
  const at = v.lastIndexOf("@");
  if (at < 1) return "";
  const domain = v.slice(at + 1).toLowerCase();
  const fixed = DOMAIN_TYPOS[domain];
  return fixed ? `${v.slice(0, at)}@${fixed}` : "";
}
