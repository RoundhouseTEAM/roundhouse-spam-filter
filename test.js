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

import { checkSpam, checkOrigin, checkContent } from "./index.js";

const MUST_BLOCK = [
  {
    label: "bot template message — Indiana Flow, Sept 2026",
    name: "Redacted Sender", email: "sender@gmail.com", phone: "5551234567",
    message: "I would like more information. Please contact me by email",
  },
  {
    label: "bot template + business name — Indiana Flow, 2026-09-21",
    name: "Joseph Miller", email: "sender@mac.com", phone: "(202) 555-0120",
    message: "I would like more information. Please contact me by email — contact indiana flow.",
  },
  {
    label: "bot template + business name — Alpha Omega, 2026-09-21",
    name: "Daniel Wilson", email: "sender@gmail.com", phone: "(202) 555-0166",
    message: "I would like more information. Please contact me by email — contact alpha omega plumbing.",
  },
  {
    label: "bot template in the middle of a long message",
    name: "Redacted Sender", email: "sender@gmail.com", phone: "5551234567",
    message: "Hello! I would like more information, please contact me by email. We have a slab leak under the kitchen and the water bill doubled last month.",
  },
  {
    label: "SEO alone in a message (Philip, 2026-09-22)",
    name: "Redacted Sender", email: "sender@gmail.com", phone: "5551234567",
    message: "Hi, I can get you more calls with local SEO. Can we talk this week?",
  },
  {
    label: "digital marketing in a message (Philip, 2026-09-22)",
    name: "Redacted Sender", email: "sender@gmail.com", phone: "5551234567",
    message: "We are a Digital-Marketing firm helping plumbers grow.",
  },
  {
    label: "VAs 4 Hire pitch in the message (Philip, 2026-09-23)",
    name: "Redacted Sender", email: "sender@gmail.com", phone: "5551234567",
    message: "VAs 4 Hire can staff your front desk for $6/hour.",
  },
  {
    label: "VAs4Hire run together, in the name field",
    name: "VAs4Hire Team", email: "sender@gmail.com", phone: "5551234567",
    message: "Can we send over some candidate profiles?",
  },
  {
    label: "virtual assistant pitch (Philip, 2026-09-23)",
    name: "Redacted Sender", email: "sender@gmail.com", phone: "5551234567",
    message: "Our Virtual Assistants handle scheduling and dispatch for contractors.",
  },
  {
    label: "bot template in the name field",
    name: "I would like more information please contact me by email", email: "sender@gmail.com", phone: "5551234567",
    message: "Need a quote",
  },
  {
    label: "bot template message — different case/punctuation/spacing",
    name: "Redacted Sender", email: "sender@gmail.com", phone: "5551234567",
    message: "  i would like more information,  please contact me by email. ",
  },
  {
    label: "casino link spam with <a href> markup — Power Construction, 2026-09-18",
    name: "Nouicap",
    email: "nfwmcukf@bientotmail.com",
    phone: "12167870000",
    message: "<a href=https://dog-house.sbs/>dog house megaways</a> https://dog-house.sbs",
  },
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
    label: "AdsMogul — site mentioned in the message, clean gmail (2026-09-17)",
    name: "Redacted Sender", email: "sender@gmail.com", phone: "5551234567",
    message: "Want more calls this month? See what we did for other contractors at www.AdsMogul.com",
  },
  {
    label: "AdsMogul — link with https and a path",
    name: "Redacted Sender", email: "sender@gmail.com", phone: "5551234567",
    message: "Details here: https://adsmogul.com/plumbers",
  },
  {
    label: "AdsMogul — their number in the message, a clean one in the field",
    name: "Redacted Sender", email: "sender@gmail.com", phone: "5551234567",
    message: "Call or text me at (805) 800-8141 to talk.",
  },
  {
    label: "AdsMogul — their number in the phone field",
    name: "Redacted Sender", email: "sender@gmail.com", phone: "805-800-8141",
    message: "Quick question about your ads.",
  },
  {
    label: "zacharyjackson.rocks email domain (2026-09-17)",
    name: "Zachary Jackson", email: "zach@zacharyjackson.rocks", phone: "5551234567",
    message: "Hi there",
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
    label: "customer surnamed Seo, and Seoul in the message",
    name: "Jin Seo", email: "customer@gmail.com", phone: "5551234567",
    message: "Just moved here from Seoul, the kitchen faucet drips nonstop. Can someone come Friday?",
  },
  {
    label: "similar request with job details is not the bot template",
    name: "Redacted Customer", email: "customer@gmail.com", phone: "5551234567",
    message: "I would like more information on a tankless water heater. Please contact me by email, I work nights.",
  },
  {
    label: "customer writing 'a href' in plain words is not markup",
    name: "Redacted Customer",
    email: "customer@gmail.com",
    phone: "5551234567",
    message: "Is there a href or link I can use to pay? Also need a quote on the gutters <soon>.",
  },
  // A look-alike domain or a number sharing digits must not trip the mention check.
  {
    label: "Real lead — look-alike domain and a different 805 number",
    name: "Dana Ruiz", email: "dana@notadsmogul.com", phone: "8058008142",
    message: "Our site is notadsmogul.com, call me back at 805-800-8142 about a slab leak.",
  },
  // ── The 2026-08-31 regression guards ──────────────────────────────
  // Seven coldOutreach phrases were blocking these exact openings. Each is how a
  // real customer actually starts a contact form, and a fake success meant they
  // vanished silently. If any of these ever fails, a phrase has been put back.
  {
    label: "Real lead — opens with I CAME ACROSS YOUR WEBSITE",
    name: "Sarah Mitchell", email: "sarah.mitchell@gmail.com", phone: "5125550134",
    message: "I came across your website while looking for a plumber in Round Rock. Our water heater is leaking, can someone come out today?",
  },
  {
    label: "Real lead — opens with I JUST VISITED YOUR WEBSITE",
    name: "Tom Bradley", email: "tbradley@outlook.com", phone: "5125550142",
    message: "I just visited your website and saw you do sewer camera work. Can you do that for our line?",
  },
  {
    label: "Real lead — opens with CAME ACROSS YOUR SITE",
    name: "Kevin Park", email: "kpark@gmail.com", phone: "5125550155",
    message: "Came across your site on Google. Suspected slab leak, our water bill doubled this month.",
  },
  {
    label: "Real lead — opens with NOTICED YOUR WEBSITE",
    name: "Dave Nguyen", email: "dnguyen@yahoo.com", phone: "7375559921",
    message: "Noticed your website says you do tankless installs. Looking for a quote to replace our 50 gallon unit.",
  },
  {
    label: "Real lead — opens with I FOUND YOU THROUGH YOUR WEBSITE",
    name: "Maria Alvarez", email: "malvarez@gmail.com", phone: "5125550163",
    message: "I found you through your website. The toilet upstairs runs constantly, can someone take a look?",
  },
  {
    label: "Real lead — opens with FOUND YOU THROUGH YOUR GOOGLE LISTING",
    name: "Angela Ruiz", email: "aruiz@hotmail.com", phone: "5125550177",
    message: "Found you through your Google listing. Do you service Georgetown? Need a water softener installed.",
  },
  {
    label: "Real lead — asks for a NO OBLIGATION quote",
    name: "Robert Diaz", email: "rdiaz@gmail.com", phone: "5125550166",
    message: "Outdoor spigot drips and the upstairs toilet runs. Could I get a no obligation quote please?",
  },
  {
    label: "Real lead — customer's first name is MAVIS",
    name: "Mavis Johnson", email: "mavisj@gmail.com", phone: "5125550188",
    message: "Kitchen sink is backing up into the dishwasher. Need someone out this week.",
  },
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

// ── Layer 3: origin / referer ───────────────────────────────────
// The allowlist ALWAYS keeps ".vercel.app": client sites live on their preview URL
// for the whole build-and-review period, and a rejection returns a fake success, so
// an over-tight allowlist silently discards real leads while looking like it works.
const ALLOWED = ["indianaflow.com", "localhost", ".vercel.app"];
const ORIGIN_CASES = [
  ["native form post from the contact page", { referer: "https://www.indianaflow.com/contact" }, true],
  ["fetch() POST sending Origin only", { origin: "https://www.indianaflow.com" }, true],
  ["submission from the Vercel preview URL", { origin: "https://indiana-flow.vercel.app" }, true],
  ["local development", { origin: "http://localhost:3000" }, true],
  // 2026-09-08: 66 sqlmap probes in 19 minutes, blank Origin, Referer set to the
  // endpoint itself. A browser posting a form sends the PAGE as the referer.
  ["sqlmap posting the endpoint directly", { referer: "https://www.indianaflow.com/api/contact" }, false],
  // 2026-08-14: "validate only if present" let a script skip the check entirely.
  ["script sending no headers at all", {}, false],
  ["referer from another domain", { referer: "https://evil.example/x" }, false],
  ["origin from another domain", { origin: "https://evil.example" }, false],
  // A real Origin is trustworthy on its own — a browser cannot forge it.
  ["good Origin despite an odd referer", { origin: "https://www.indianaflow.com", referer: "https://www.indianaflow.com/api/contact" }, true],
];

console.log("\n── Layer 3: origin / referer ───────────────────────────");
for (const [label, headers, shouldPass] of ORIGIN_CASES) {
  const v = checkOrigin({ origin: "", referer: "", ...headers, allowed: ALLOWED });
  const ok = v.ok === shouldPass;
  if (!ok) failures++;
  console.log(`${ok ? "  ✓ " : "  ✗ WRONG "} ${shouldPass ? "allow" : "block"}  ${label}`);
}

// ── Layer 4: content patterns ───────────────────────────────────
const CONTENT_CASES = [
  ["real customer, clean", { name: "Sarah Mitchell", phone: "(317) 555-0134", message: "Water heater is leaking, can someone come out today?" }, null],
  ["real customer quoting their own site", { name: "Dan", phone: "3175550134", message: "we run www.example.com and need a backflow test" }, "content:url"],
  ["sqlmap probe", { name: "ORDER BY 1-- -", phone: "-5244", message: "CONCAT(0x7e" }, "content:short-phone"],
  ["Cyrillic SEO spam", { name: "Мария", phone: "3175550134", message: "аудит сайта" }, "content:non-latin"],
  ["no phone at all", { name: "Bob", phone: "", message: "hello" }, "content:short-phone"],
];

console.log("\n── Layer 4: content patterns ───────────────────────────");
for (const [label, input, expected] of CONTENT_CASES) {
  const v = checkContent(input);
  const got = v.blocked ? v.layer : null;
  const ok = got === expected;
  if (!ok) failures++;
  console.log(`${ok ? "  ✓ " : "  ✗ WRONG "} ${String(got)}  ${label}`);
}

// A multilingual client must be able to turn the script rule off without losing
// the other two — the reason these are separate layers rather than one "content".
{
  const v = checkContent({ name: "Мария", phone: "3175550134", message: "аудит", nonLatin: false });
  const ok = !v.blocked;
  if (!ok) failures++;
  console.log(`${ok ? "  ✓ " : "  ✗ WRONG "} nonLatin:false lets non-Latin script through`);
}

const total = MUST_BLOCK.length + MUST_PASS.length;
console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"} — ${total} keyword cases + layer 3/4 checks` +
    (failures ? ` (${failures} wrong)` : "")
);
process.exit(failures === 0 ? 0 : 1);
