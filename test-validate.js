/**
 * Tests for validate.js — the shared field rules. Run with: npm test
 */
import assert from "node:assert/strict";
import {
  selectPlaceholder,
  isQuestionLabel,
  validateLead,
  validateField,
  normalizePhone,
  suggestEmail,
  MESSAGES,
  MESSAGE_MAX,
  offlineMessage,
  deliveryFailedMessage,
} from "./validate.js";

let passed = 0;
function test(label, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL: ${label}`);
    throw err;
  }
}

const good = {
  name: "Jane Rivera",
  phone: "(512) 555-2100",
  email: "jane@example.com",
  message: "Water heater is leaking from the bottom.",
};

test("a complete, normal lead is valid", () => {
  assert.deepEqual(validateLead(good), {});
});

// ── Phone ────────────────────────────────────────────────────────
test("phone: formatting is ignored", () => {
  for (const p of ["512-555-2100", "512.555.2100", "5125552100", "(512)555-2100", " 512 555 2100 "]) {
    assert.equal(validateField("phone", p), "", p);
  }
});
test("phone: a leading country code 1 is accepted", () => {
  assert.equal(normalizePhone("1-512-555-2100"), "5125552100");
  assert.equal(normalizePhone("+1 (512) 555-2100"), "5125552100");
  assert.equal(validateField("phone", "+1 (512) 555-2100"), "");
});
test("phone: under 10 digits gets the 10-digit message", () => {
  for (const p of ["5551", "317555", "512555010"]) {
    assert.equal(validateField("phone", p), MESSAGES.phoneLength, p);
  }
});
test("phone: over 10 digits (not a leading 1) gets the 10-digit message", () => {
  assert.equal(validateField("phone", "51255521001"), MESSAGES.phoneLength);
  assert.equal(validateField("phone", "25125552100"), MESSAGES.phoneLength);
});
test("phone: an area code starting 0 or 1 is flagged", () => {
  assert.equal(validateField("phone", "0125552100"), MESSAGES.phoneAreaCode);
  assert.equal(validateField("phone", "1125552100"), MESSAGES.phoneAreaCode);
});
test("phone: numbers that can never be a person's are rejected visibly (2.45.0)", () => {
  // N11 service codes, 555 and 900 as the area code.
  for (const p of ["(711) 976-2125", "911-555-2100", "+1 (555) 123-4567", "+1 (900) 431-5448"]) {
    assert.equal(validateField("phone", p), MESSAGES.phoneAreaCode, p);
  }
  // 555-0100–0199 is reserved for films (the Sept 2026 bot sent (202) 555-01xx); an
  // exchange never starts with 0 or 1.
  for (const p of ["(202) 555-0154", "202-555-0100", "2025550199", "(512) 012-3456", "(512) 199-3456"]) {
    assert.equal(validateField("phone", p), MESSAGES.phoneNotReal, p);
  }
});
test("phone: real numbers next to the never-real ones still pass", () => {
  // 555-0200 and 555-1212 are outside the reserved block; 711 as an EXCHANGE is fine;
  // toll-free and Canadian numbers are dialable; an unassigned area code is NOT a
  // visible error (a new overlay opens every year) — lead.js treats it as a signal.
  for (const p of ["(202) 555-0200", "(512) 555-1212", "(512) 711-2125", "(888) 587-2383", "(825) 555-2100", "(783) 632-9565"]) {
    assert.equal(validateField("phone", p), "", p);
  }
});
test("phone: blank", () => {
  assert.equal(validateField("phone", ""), MESSAGES.phoneMissing);
});

// ── Name ─────────────────────────────────────────────────────────
test("name: blank / numbers only / link", () => {
  assert.equal(validateField("name", "  "), MESSAGES.nameMissing);
  assert.equal(validateField("name", "12345"), MESSAGES.nameNoLetters);
  assert.equal(validateField("name", "www.cheapseo.com"), MESSAGES.nameHasLink);
  assert.equal(validateField("name", "https://x.io"), MESSAGES.nameHasLink);
});
test("name: real names pass, including accents and apostrophes", () => {
  for (const n of ["joseph simpliciano", "Sharee Lee", "José O'Neill-Smith", "RATNA AGHARKAR"]) {
    assert.equal(validateField("name", n), "", n);
  }
});

// ── Email ────────────────────────────────────────────────────────
test("email: blank / malformed / valid", () => {
  assert.equal(validateField("email", ""), MESSAGES.emailMissing);
  assert.equal(validateField("email", "notanemail"), MESSAGES.emailInvalid);
  assert.equal(validateField("email", "a@b"), MESSAGES.emailInvalid);
  assert.equal(validateField("email", "joseph.k.simpliciano@hawaii.gov"), "");
});
test("email: typo suggestions, never for real domains", () => {
  assert.equal(suggestEmail("jane@gmial.com"), "jane@gmail.com");
  assert.equal(suggestEmail("jane@yaho.com"), "jane@yahoo.com");
  assert.equal(suggestEmail("jane@gmail.com"), "");
  assert.equal(suggestEmail("shareej@ilc-inter.com"), "");
});

// ── Message ──────────────────────────────────────────────────────
test("message: blank / too long", () => {
  assert.equal(validateField("message", ""), MESSAGES.messageMissing);
  assert.equal(validateField("message", "x".repeat(MESSAGE_MAX + 1)), MESSAGES.messageTooLong);
  assert.equal(validateField("message", "x".repeat(MESSAGE_MAX)), "");
});
test("message: links are allowed", () => {
  assert.equal(
    validateField("message", "Here's the house: https://maps.google.com/?q=123+Main+St"),
    ""
  );
});

test("message: one link is fine, two or more get a visible message", () => {
  assert.equal(validateField("message", "Listing: https://www.zillow.com/homedetails/123"), "");
  assert.equal(
    validateField("message", "Pics at https://imgur.com/a/1 and https://imgur.com/a/2"),
    MESSAGES.messageTooManyLinks
  );
  assert.equal(validateField("message", "www.a.com and www.b.com"), MESSAGES.messageTooManyLinks);
  // An email address in the message is not a link.
  assert.equal(validateField("message", "Email me at sam@gmail.com, see https://maps.app.goo.gl/x"), "");
});

// ── Extra fields ─────────────────────────────────────────────────
test("extra fields: visible ones are required by default; hidden never; explicit false honoured", () => {
  assert.deepEqual(validateLead(good, [{ name: "address", label: "Address" }]), {
    address: "Please enter your address.",
  });
  assert.deepEqual(validateLead(good, [{ name: "service", label: "Service", hidden: true }]), {});
  assert.deepEqual(validateLead(good, [{ name: "address", label: "Address", required: false }]), {});
  assert.deepEqual(
    validateLead(good, [{ name: "service", label: "Service", hidden: true, required: true }]),
    {},
    "hidden wins: a value the page supplies can never block a visitor"
  );
});

test("extra fields: required, max length, options", () => {
  const extras = [
    { name: "address", label: "Address", required: false },
    { name: "area", label: "Area", required: true, options: ["Brandon", "Ocala"] },
  ];
  assert.deepEqual(validateLead({ ...good, area: "Ocala" }, extras), {});
  assert.deepEqual(validateLead(good, extras), { area: "Please enter your area." });
  assert.deepEqual(validateLead({ ...good, area: "Mars" }, extras), {
    area: "Please choose your area from the list.",
  });
  assert.deepEqual(validateLead({ ...good, area: "Ocala", address: "x".repeat(201) }, extras), {
    address: "Please keep your address under 200 characters.",
  });
});

test("checkbox (consent): required means checked; custom message allowed", () => {
  const extras = [{ name: "consent", label: "I agree", checkbox: true, required: true }];
  assert.deepEqual(validateLead(good, extras), { consent: MESSAGES.consentMissing });
  assert.deepEqual(validateLead({ ...good, consent: "yes" }, extras), {});
  assert.deepEqual(validateLead({ ...good, consent: "on" }, extras), {}, "native post sends 'on'");
  assert.deepEqual(
    validateLead(good, [{ ...extras[0], requiredMessage: "Please agree first." }]),
    { consent: "Please agree first." }
  );
  assert.deepEqual(validateLead(good, [{ ...extras[0], required: false }]), {});
});

test("question labels read naturally in the select placeholder and messages", () => {
  assert.equal(selectPlaceholder("Area"), "Choose your area");
  assert.equal(selectPlaceholder("Property type:"), "Choose your property type");
  assert.equal(selectPlaceholder("Are you a new customer?"), "Choose one");
  assert.equal(selectPlaceholder("How did you hear about us"), "Choose one");
  assert.equal(selectPlaceholder(""), "Choose one");
  assert.equal(isQuestionLabel("Issue"), false, "'Issue' is not 'Is …'");
  assert.equal(isQuestionLabel("Whom to contact"), false);

  const extras = [{ name: "customer", label: "Are you a new customer?", options: ["Yes", "No"] }];
  assert.deepEqual(validateLead(good, extras), { customer: "Please choose an answer." });
  assert.deepEqual(validateLead({ ...good, customer: "Maybe" }, extras), {
    customer: "Please choose an answer from the list.",
  });
  assert.deepEqual(validateLead({ ...good, customer: "Yes" }, extras), {});
  assert.deepEqual(
    validateLead(good, [{ name: "source", label: "How did you hear about us?" }]),
    { source: "Please answer this question." }
  );
});

test("every error is reported at once, keyed by field", () => {
  assert.deepEqual(Object.keys(validateLead({})).sort(), ["email", "message", "name", "phone"]);
});

test("fallback messages: a phone says call, an email says email", () => {
  assert.match(deliveryFailedMessage("(512) 555-2100"), /Please call us at \(512\) 555-2100 and/);
  assert.match(offlineMessage("(512) 555-2100"), /or call us at \(512\) 555-2100\.$/);
  assert.match(deliveryFailedMessage("sue@example.org"), /Please email us at sue@example\.org and/);
  assert.match(offlineMessage("sue@example.org"), /or email us at sue@example\.org\.$/);
});

console.log(`validate: ${passed} passed`);
