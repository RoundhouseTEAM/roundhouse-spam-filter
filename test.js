/**
 * Regression tests built from REAL submission PATTERNS in the client lead sheets.
 *
 * MUST_BLOCK holds real spam wording. MUST_PASS holds real customer wording —
 * several deliberately contain words a naive filter would catch ("video",
 * "website", "business", "scope of work").
 *
 * PRIVACY: customer names, emails, phone numbers and street addresses are
 * anonymized. Only the message wording is real, because that is what the filter
 * actually matches on. Spammer domains are kept verbatim — they are the published
 * blocklist in index.js and are spam infrastructure, not private individuals.
 *
 * Run with: npm test
 */

import { checkSpam } from "./index.js";

const MUST_BLOCK = [
  {
    label: "VA/MAVIS pitch (blocked domain)",
    name: "Redacted Sender",
    email: "sender@vettedvas.com",
    message:
      "Hi, I’m reaching out because we offer Virtual Assistants that utilize our custom built AI tool, MAVIS (My Advanced Virtual Intelligent System), that easily replaces a 20 man team.",
  },
  {
    label: "VA/MAVIS pitch (different domain, same campaign)",
    name: "Redacted Sender",
    email: "sender@toptalentvas.com",
    message:
      "MAVIS is designed to handle the workload of a 20‑person team—covering marketing, admin, prospecting, design, video, and accounting.",
  },
  {
    label: "VA/MAVIS pitch (third domain)",
    name: "Redacted Sender",
    email: "sender@virtualteamexpert.com",
    message: "We built MAVIS (My Advanced Virtual Intelligent System). Are you looking for more leads?",
  },
  {
    label: "VA/MAVIS from a clean gmail — keyword must catch it alone",
    name: "Redacted Sender",
    email: "sender@gmail.com",
    phone: "5551234567",
    message:
      "We offer Virtual Assistants that utilize our custom built AI tool, MAVIS, that easily replaces a 20 man team. Are you looking for help?",
  },
  {
    label: "Guest-post pitch (blocked domain) — IrriGators, 2026-08-20",
    name: "Redacted Sender",
    email: "sender@tidyhome.info",
    phone: "5555034088",
    message:
      "Hello, Can I write an article for your website that speaks directly to freelancers, contractors, and gig workers who own a home?",
  },
  {
    label: "Guest-post pitch from a clean gmail — keyword must catch it alone",
    name: "Redacted Sender",
    email: "sender@gmail.com",
    phone: "5551234567",
    message:
      "I believe your readers would find this a timely and genuinely useful resource, and I'd be glad to share an outline or a draft whenever it's convenient for you.",
  },
  {
    label: "Guest-post pitch — the P.S. variant, no other tell",
    name: "Redacted Sender",
    email: "sender@outlook.com",
    phone: "5559876543",
    message:
      "If you'd like to propose an alternative topic, please feel free. I am more than willing to write on a subject of your choice.",
  },
  {
    label: "Business acquisition (blocked domain)",
    name: "Redacted Sender",
    email: "sender@bizbuydave.com",
    message: "Hello, are you interested in selling your Cesspool Business?",
  },
  {
    label: "Business acquisition from clean gmail — keyword alone",
    name: "Redacted Sender",
    email: "sender@gmail.com",
    phone: "5551234567",
    message: "Hello, are you interested in selling your Plumbing Business?",
  },
  {
    label: "Buyers-interested pitch",
    name: "Redacted Sender",
    email: "sender@integribridge.com",
    message:
      "I have several buyers interested in purchasing businesses in your industry. Are you interested in selling? Let's set up a call.",
  },
  {
    label: "SEO cold pitch — keyword alone",
    name: "Redacted Sender",
    email: "sender@gmail.com",
    phone: "5551234567",
    message:
      "Great looking website! But a quick check shows it’s missing from key Google results. I’ve helped hundreds of businesses rank better",
  },
  {
    label: "Repeat offender — known phone, different name each time",
    name: "Redacted Sender",
    email: "sender@gmail.com",
    phone: "3072076448",
    message: "Gould St",
  },
  {
    label: "Video production pitch",
    name: "Redacted Sender",
    email: "sender@gmail.com",
    phone: "5551234567",
    message:
      "Our videos cost just $195 (USD) for a 30 second video ($239 for 60 seconds) and include a full script, voice-over and video.",
  },
  {
    label: "Branding pitch",
    name: "Redacted Sender",
    email: "sender@gmail.com",
    phone: "5551234567",
    message:
      "The business feels solid, but the visual identity doesn't feel fully aligned yet. Things like the logo, colors, and overall style could work together more consistently.",
  },
  {
    label: "Lead-gen pitch (blocked domain)",
    name: "Redacted Sender",
    email: "sender@threadproxy.com",
    message: "We help HVAC companies fix the gap where website and form leads come in but never turn into booked jobs.",
  },
  {
    label: "Cold outreach with curly apostrophe — normalization must handle it",
    name: "Redacted Sender",
    email: "sender@gmail.com",
    phone: "5551234567",
    message: "Hi there, didn’t want to interrupt your workday with a call, so I'm leaving this here.",
  },
  {
    label: "AI-tool spam (blocked domain)",
    name: "Redacted Sender",
    email: "sender@getdandynow.com",
    message: "9891 Irvine Center Drive, Suite #200",
  },
  {
    label: "Turkish gambling spam",
    name: "Redacted Sender",
    email: "sender@mailturk.xyz",
    message: "Şu sıralar deneme bonusu veren siteler hakkında inanılmaz bir bilgi kirliliği var.",
  },
  {
    label: "Turkish gambling from clean domain — keyword alone",
    name: "Redacted Sender",
    email: "sender@gmail.com",
    phone: "5551234567",
    message: "deneme bonusu veren siteler hakkinda bilgi, bahis",
  },
  {
    label: "Gibberish keyboard mash",
    name: "NAEWTRER365118NEYHRTGE",
    email: "sender@gmail.com",
    phone: "5551234567",
    message: "MERYTRH365118MAMYJRTH",
  },
  {
    label: "Off-topic news spam",
    name: "Redacted Sender",
    email: "sender@gmail.com",
    phone: "5551234567",
    message:
      "The US president raged at NATO allies over defense spending in meeting with the German chancellor",
  },
  {
    label: "AI-employee pitch (blocked domain) — Newmans, 2026-08-28",
    name: "Frederik Redacted",
    email: "sender@mail.svarklar.com",
    phone: "+45 91 60 04 23",
    message:
      "If I could get you more time, by automating the office work, without you needing to learn anything, would that be helpful? SvarKlar - An AI employee for your business.",
  },
  {
    label: "AI-employee pitch from a clean gmail — keyword must catch it alone",
    name: "Redacted Sender",
    email: "sender@gmail.com",
    phone: "5551234567",
    message:
      "If I could get you more time, by automating the office work, would that be helpful? An AI employee for your business. I found you through your website and your Google listing.",
  },
  {
    label: "AI-employee pitch — the privacy-line variant, no other tell",
    name: "Redacted Sender",
    email: "sender@outlook.com",
    phone: "5559876543",
    message: "I found you through your website and your Google listing. What I do with your details: example.com/privacy",
  },
  {
    label: "Suspicious TLD (.bid)",
    name: "Redacted Sender",
    email: "sender@example.bid",
    message: "CONSTRUCTION MANAGEMENT, INC.",
  },
];

const MUST_PASS = [
  {
    label: "Real job — sewer snake VIDEO for a retail project",
    name: "Customer A",
    email: "customer.a@example.com",
    phone: "5550101010",
    message:
      "Hi, We are looking for pricing for a sewer snake video for our retail project at the shopping center. We will need a copy of the video to send to the client. Thank you",
  },
  {
    label: "Real federal contract — uses SCOPE OF WORK",
    name: "Customer B",
    email: "customer.b@example.com",
    phone: "5550202020",
    message:
      "Hello, please let me know if you are capable to complete this scope of work and what will be the cost. Weekly Pumping: The Contractor shall pump and completely evacuate all wastewater from both 1,000-gallon holding tanks.",
  },
  {
    label: "Real commercial quote — hydro jetting, nonprofit",
    name: "Customer C",
    email: "customer.c@example.org",
    phone: "5550303030",
    message:
      "Reaching out on behalf of our organization, looking to receive a written quote for your plumbing services. Recommendation: Clean the sewer line with hydro jetting service, remove debris.",
  },
  {
    label: "Real lead — camera inspection with VIDEO report",
    name: "Customer D",
    email: "customer.d@example.com",
    phone: "5550404040",
    message:
      "We would like to schedule a camera inspection to check if the pipe is clogged, damaged, collapsed, or needs replacement. Provide a written report with photos or video, if possible.",
  },
  {
    label: "Real lead — warranty work, mentions BUSINESS and customer",
    name: "Customer E",
    email: "customer.e@example.com",
    phone: "5550505050",
    message:
      "This is the warranty department with our main office. We have a customer in your area that needs service work done on a water softener.",
  },
  {
    label: "Real lead — simple drain clog",
    name: "Customer F",
    email: "customer.f@example.com",
    phone: "5550606060",
    message: "Kitchen slow drain and got slower then stopped. How much cost to unclog",
  },
  {
    label: "Real lead — water heater",
    name: "Customer G",
    email: "customer.g@example.com",
    phone: "5550707070",
    message: "Hot water heater isn’t working.",
  },
  {
    label: "Real lead — commercial kitchen grease line",
    name: "Customer H",
    email: "customer.h@example.org",
    phone: "5550808080",
    message:
      "I'm reaching out from our facility requesting to attain an estimate to get the main grease lines for our commercial kitchen jetted and camera inspection.",
  },
  {
    label: "Real lead — realtor scheduling a septic pump",
    name: "Customer I",
    email: "customer.i@example.com",
    phone: "5550909090",
    message:
      "I'm helping out my client schedule a cesspool pump at her new home. She would like to schedule septic pumping for the 23rd, 24th, or 25th of this month.",
  },
  {
    label: "Real lead — water filtration quote",
    name: "Customer J",
    email: "customer.j@example.com",
    phone: "5551010101",
    message:
      "We are interested in getting a quote for a whole house carbon filter and under sink reverse osmosis system.",
  },
  {
    label: "Real lead — customer refers to an ARTICLE they read on the site",
    name: "Customer L",
    email: "customer.l@example.com",
    phone: "5552223333",
    message:
      "I read your article about when to turn the irrigation system off for winter and would like a quote to have mine serviced.",
  },
  {
    label: "Real lead — customer offers photos, uses WOULD THAT BE HELPFUL",
    name: "Customer M",
    email: "customer.m@example.com",
    phone: "5554445555",
    message:
      "There is water pooling under the kitchen sink. I can send photos of the leak before you come out, would that be helpful?",
  },
  {
    label: "Real lead — customer mentions finding the WEBSITE",
    name: "Customer K",
    email: "customer.k@example.com",
    phone: "5551111111",
    message: "I found your website on Google and need someone to look at a leaking water heater.",
  },
];

let failures = 0;

console.log("── MUST BLOCK (real spam wording) ──────────────────────");
for (const c of MUST_BLOCK) {
  const v = checkSpam(c);
  const ok = v.blocked;
  if (!ok) failures++;
  console.log(
    `${ok ? "  ✓ blocked" : "  ✗ LEAKED "}  ${c.label}${ok ? `  [${v.rule} → ${v.reason}]` : ""}`
  );
}

console.log("\n── MUST PASS (real customer wording) ───────────────────");
for (const c of MUST_PASS) {
  const v = checkSpam(c);
  const ok = !v.blocked;
  if (!ok) failures++;
  console.log(
    `${ok ? "  ✓ passed " : "  ✗ FALSE POSITIVE"}  ${c.label}${ok ? "" : `  [${v.rule} → ${v.reason}]`}`
  );
}

const total = MUST_BLOCK.length + MUST_PASS.length;
console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${total - failures}/${total} correct` +
    (failures ? ` (${failures} wrong)` : "")
);
process.exit(failures === 0 ? 0 : 1);
