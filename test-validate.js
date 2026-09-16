/**
 * Tests for validate.js — the shared field rules. Run with: npm test
 */
import assert from "node:assert/strict";
import {
  validateLead,
  validateField,
  normalizePhone,
  suggestEmail,
  MESSAGES,
  MESSAGE_MAX,
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
  phone: "(512) 555-0100",
  email: "jane@example.com",
  message: "Water heater is leaking from the bottom.",
};

test("a complete, normal lead is valid", () => {
  assert.deepEqual(validateLead(good), {});
});

// ── Phone ────────────────────────────────────────────────────────
test("phone: formatting is ignored", () => {
  for (const p of ["512-555-0100", "512.555.0100", "5125550100", "(512)555-0100", " 512 555 0100 "]) {
    assert.equal(validateField("phone", p), "", p);
  }
});
test("phone: a leading country code 1 is accepted", () => {
  assert.equal(normalizePhone("1-512-555-0100"), "5125550100");
  assert.equal(normalizePhone("+1 (512) 555-0100"), "5125550100");
  assert.equal(validateField("phone", "+1 (512) 555-0100"), "");
});
test("phone: under 10 digits gets the 10-digit message", () => {
  for (const p of ["5551", "317555", "512555010"]) {
    assert.equal(validateField("phone", p), MESSAGES.phoneLength, p);
  }
});
test("phone: over 10 digits (not a leading 1) gets the 10-digit message", () => {
  assert.equal(validateField("phone", "51255501001"), MESSAGES.phoneLength);
  assert.equal(validateField("phone", "25125550100"), MESSAGES.phoneLength);
});
test("phone: an area code starting 0 or 1 is flagged", () => {
  assert.equal(validateField("phone", "0125550100"), MESSAGES.phoneAreaCode);
  assert.equal(validateField("phone", "1125550100"), MESSAGES.phoneAreaCode);
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

test("every error is reported at once, keyed by field", () => {
  assert.deepEqual(Object.keys(validateLead({})).sort(), ["email", "message", "name", "phone"]);
});

console.log(`validate: ${passed} passed`);
