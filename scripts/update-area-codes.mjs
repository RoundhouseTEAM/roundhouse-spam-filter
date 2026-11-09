/**
 * Regenerates area-codes.js from NANPA's public NPA report.
 *   node scripts/update-area-codes.mjs            (downloads the CSV)
 *   node scripts/update-area-codes.mjs file.csv   (uses a saved copy)
 * Then run `npm test`, bump the version and commit.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://reports.nanpa.com/public/npa_report.csv";
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "area-codes.js");

const text = process.argv[2]
  ? fs.readFileSync(process.argv[2], "utf8")
  : await (await fetch(SOURCE)).text();
const lines = text.split(/\r?\n/).filter(Boolean);
const [m, d, y] = lines[0].split(",")[1].trim().split("/");
const header = lines[1].split(",");
const idCol = header.indexOf("NPA_ID");
const assignedCol = header.indexOf("ASSIGNED");
if (idCol < 0 || assignedCol < 0) throw new Error("NANPA CSV format changed — NPA_ID/ASSIGNED columns not found");
// The first columns hold no commas, so a plain split is safe for the two we read.
const codes = lines
  .slice(2)
  .map((l) => l.split(","))
  .filter((c) => c[assignedCol] === "Yes" && /^\d{3}$/.test(c[idCol]))
  .map((c) => c[idCol])
  .sort();
if (codes.length < 400) throw new Error(`only ${codes.length} assigned codes — refusing to write a short list`);

const current = fs.readFileSync(out, "utf8");
const rows = [];
for (let i = 0; i < codes.length; i += 16) rows.push("  " + codes.slice(i, i + 16).map((c) => `"${c}"`).join(", ") + ",");
const next = current
  .replace(/\(file date [\d-]+\), every row with ASSIGNED = Yes\. \d+ codes\./, `(file date ${y}-${m}-${d}), every row with ASSIGNED = Yes. ${codes.length} codes.`)
  .replace(/AREA_CODES_DATE = "[\d-]+"/, `AREA_CODES_DATE = "${y}-${m}-${d}"`)
  .replace(/new Set\(\[\n[\s\S]*?\n\]\);/, `new Set([\n${rows.join("\n")}\n]);`);
fs.writeFileSync(out, next);
console.log(`area-codes.js: ${codes.length} assigned codes (NANPA file date ${y}-${m}-${d})`);
