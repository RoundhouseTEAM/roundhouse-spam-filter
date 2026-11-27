#!/usr/bin/env node
/**
 * Roll the spam filter out to EVERY site (Philip, 2026-11-27: "any update we make
 * should always go across all of the sites").
 *
 * Sites pin this package by commit in package-lock.json, so a merge here reaches no
 * site until each lockfile is bumped. A fix once sat live on 2 of 9 sites for 8 days.
 * The rollout workflow runs this on every merge to main, after `npm test` passes:
 *
 *   1. Repos: scripts/rollout-repos.json, plus any repo code search finds depending on
 *      the package in the same owners (so a new site isn't missed).
 *   2. Each repo: rewrite ONLY the @roundhouse/spam-filter entry in package-lock.json to
 *      the new commit, and commit it to the default branch. Vercel deploys on push.
 *      `npm update` is not used: it also rewrites unrelated lines (npm-version metadata).
 *      That is exact because the package has no runtime dependencies — its lockfile entry
 *      comes from its own package.json. If it ever gains some, this refuses to run.
 *   3. A summary per repo; the job fails if any repo could not be bumped.
 *
 * Env: SHA (commit to roll out), ROLLOUT_TOKEN (contents:write on the site repos),
 *      ROLLOUT_TOKEN_<OWNER> to use a different token for one owner (fine-grained
 *      tokens cover one owner: ROLLOUT_TOKEN_ROUNDHOUSEDM), DRY_RUN=1 to change nothing.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PKG = "@roundhouse/spam-filter";
const LOCK_KEY = `node_modules/${PKG}`;
const SOURCE = "RoundhouseTEAM/roundhouse-spam-filter";

/** The lockfile entry npm writes for this package at `sha`, built from its package.json. */
export function lockEntry(pkg, sha) {
  if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
    throw new Error(
      "the package now has runtime dependencies; a lockfile rewrite can't add them — switch the rollout to `npm install`"
    );
  }
  const entry = {
    version: pkg.version,
    resolved: `git+ssh://git@github.com/${SOURCE}.git#${sha}`,
  };
  for (const field of ["license", "bin", "engines", "peerDependencies", "peerDependenciesMeta"]) {
    if (pkg[field] !== undefined) entry[field] = pkg[field];
  }
  return entry;
}

/**
 * Bump the package in a package-lock.json text.
 * @returns {{status: "bumped"|"current", text: string, from?: string}}
 */
export function bumpLock(text, pkg, sha) {
  const lock = JSON.parse(text);
  // Refuse a lockfile this rewrite would reformat: the diff must be only our entry.
  const newline = text.endsWith("\n") ? "\n" : "";
  if (JSON.stringify(lock, null, 2) + newline !== text) {
    throw new Error("package-lock.json is not npm's standard 2-space format; bump it by hand");
  }
  const old = lock.packages?.[LOCK_KEY];
  if (!old) throw new Error(`no "${LOCK_KEY}" entry in package-lock.json`);
  if (String(old.resolved ?? "").endsWith(`#${sha}`)) return { status: "current", text };

  const from = `${old.version} (${String(old.resolved ?? "").split("#")[1]?.slice(0, 7) ?? "?"})`;
  lock.packages[LOCK_KEY] = lockEntry(pkg, sha);
  // lockfileVersion 1/2 also keep a legacy "dependencies" tree.
  const legacy = lock.dependencies?.[PKG];
  if (legacy) {
    lock.dependencies[PKG] = {
      ...legacy,
      version: `git+ssh://git@github.com/${SOURCE}.git#${sha}`,
    };
  }
  return { status: "bumped", text: JSON.stringify(lock, null, 2) + newline, from };
}

/** The dependency spec, or why this repo should not be bumped automatically. */
export function checkSpec(packageJson) {
  const pkg = JSON.parse(packageJson);
  const spec = pkg.dependencies?.[PKG] ?? pkg.devDependencies?.[PKG];
  if (!spec) return { ok: false, reason: `does not depend on ${PKG}` };
  if (!/roundhouse-spam-filter/i.test(spec)) return { ok: false, reason: `unexpected spec "${spec}"` };
  // "#v2.40.0" or "#<sha>" in package.json is a deliberate pin; respect it.
  if (spec.includes("#")) return { ok: false, reason: `pinned in package.json ("${spec}")` };
  return { ok: true };
}

// ── GitHub ───────────────────────────────────────────────────────

function tokenFor(owner) {
  return process.env[`ROLLOUT_TOKEN_${owner.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] || process.env.ROLLOUT_TOKEN;
}

async function gh(token, path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "roundhouse-spam-filter-rollout",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return raw ? res.text() : res.json();
}

async function readFile(token, repo, path, ref) {
  const q = `?ref=${encodeURIComponent(ref)}`;
  const meta = await gh(token, `/repos/${repo}/contents/${path}${q}`);
  const text = await gh(token, `/repos/${repo}/contents/${path}${q}`, { raw: true });
  return { sha: meta.sha, text };
}

/** Repos code search finds depending on the package, in each owner. Best effort. */
async function discover(owners) {
  const found = [];
  for (const owner of owners) {
    const token = tokenFor(owner);
    if (!token) continue;
    try {
      const q = encodeURIComponent(`roundhouse-spam-filter filename:package.json org:${owner}`);
      const res = await gh(token, `/search/code?q=${q}&per_page=100`);
      for (const item of res.items ?? []) {
        if (item.path === "package.json") found.push(item.repository.full_name);
      }
    } catch (e) {
      console.warn(`code search in ${owner} failed (using the list only): ${e.message}`);
    }
  }
  return found;
}

async function rollOne(repo, { pkg, sha, subject, dryRun }) {
  const owner = repo.split("/")[0];
  const token = tokenFor(owner);
  if (!token) return { repo, status: "failed", note: `no ROLLOUT_TOKEN for ${owner}` };

  const info = await gh(token, `/repos/${repo}`);
  if (info.archived) return { repo, status: "skipped", note: "archived" };
  const branch = info.default_branch;

  const spec = checkSpec((await readFile(token, repo, "package.json", branch)).text);
  if (!spec.ok) return { repo, status: "skipped", note: spec.reason };

  for (let attempt = 1; ; attempt++) {
    const lock = await readFile(token, repo, "package-lock.json", branch);
    const result = bumpLock(lock.text, pkg, sha);
    if (result.status === "current") return { repo, status: "current", note: `already ${pkg.version}` };
    if (dryRun) return { repo, status: "would bump", note: `${result.from} → ${pkg.version}` };
    try {
      const put = await gh(token, `/repos/${repo}/contents/package-lock.json`, {
        method: "PUT",
        body: {
          message: `Bump ${PKG} to ${pkg.version} (${subject})\n\nRolled out automatically from ${SOURCE}@${sha.slice(0, 7)}.`,
          content: Buffer.from(result.text).toString("base64"),
          sha: lock.sha,
          branch,
          committer: { name: "Roundhouse", email: "support@getroundhouse.com" },
        },
      });
      return { repo, status: "bumped", note: `${result.from} → ${pkg.version}`, commit: put.commit?.html_url };
    } catch (e) {
      // Someone pushed the lockfile between our read and write: read it again, once.
      if ((e.status === 409 || e.status === 422) && attempt < 2) continue;
      throw e;
    }
  }
}

async function main() {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
  const sha = process.env.SHA;
  if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("SHA must be the full commit to roll out");
  if (!process.env.ROLLOUT_TOKEN) {
    throw new Error(
      "ROLLOUT_TOKEN is not set. Add a token with contents:write on every site repo as a repository secret."
    );
  }
  lockEntry(pkg, sha); // fails fast if the package grew runtime dependencies
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  // A merge commit reads "Merge pull request #2 from …", then a blank line, then the PR title.
  const lines = (process.env.SUBJECT || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const title = /^Merge (pull request|branch)/.test(lines[0] ?? "") ? lines[1] : lines[0];
  const subject = (title || "").replace(/^\d+\.\d+\.\d+(–\d+\.\d+\.\d+)?:\s*/, "") || "spam filter update";

  const listed = JSON.parse(readFileSync(`${root}scripts/rollout-repos.json`, "utf8")).repos;
  const owners = [...new Set(listed.map((r) => r.split("/")[0]))];
  const discovered = await discover(owners);
  const lower = new Set(listed.map((r) => r.toLowerCase()));
  const extra = [...new Set(discovered)].filter((r) => !lower.has(r.toLowerCase()) && r.toLowerCase() !== SOURCE.toLowerCase());
  const repos = [...listed, ...extra];

  console.log(`${dryRun ? "DRY RUN — " : ""}rolling ${pkg.version} (${sha.slice(0, 7)}) out to ${repos.length} repos`);
  const results = [];
  for (const repo of repos) {
    let r;
    try {
      r = await rollOne(repo, { pkg, sha, subject, dryRun });
    } catch (e) {
      r = { repo, status: "failed", note: e.message };
    }
    if (extra.includes(repo)) r.note = `${r.note} — found by search, add it to scripts/rollout-repos.json`;
    results.push(r);
    console.log(`${r.status.padEnd(10)} ${repo}  ${r.note ?? ""}`);
  }

  const failed = results.filter((r) => r.status === "failed");
  const summary = [
    `## Spam filter ${pkg.version} rollout${dryRun ? " (dry run)" : ""}`,
    "",
    `${results.filter((r) => r.status === "bumped").length} bumped · ${results.filter((r) => r.status === "current").length} already current · ${results.filter((r) => r.status === "skipped").length} skipped · **${failed.length} failed**`,
    "",
    "| Repo | Result | Detail |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.repo} | ${r.status} | ${(r.commit ? `[commit](${r.commit}) ` : "") + (r.note ?? "").replace(/\|/g, "\\|")} |`),
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  if (failed.length) {
    console.error(`\n${failed.length} repo(s) were NOT bumped — those sites are still on the old filter.`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
