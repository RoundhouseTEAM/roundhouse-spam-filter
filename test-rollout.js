// Tests for scripts/rollout.mjs — the lockfile rewrite that ships every update to every site.
import assert from "node:assert/strict";
import { bumpLock, checkSpec, lockEntry } from "./scripts/rollout.mjs";

const OLD = "e386d0cb783b6c44de6c0027a8fb9ec19cfa97e3";
const NEW = "7be3f5f0000000000000000000000000000000aa";
const pkg = {
  name: "@roundhouse/spam-filter",
  version: "2.63.0",
  license: "UNLICENSED",
  peerDependencies: { react: ">=18" },
  peerDependenciesMeta: { react: { optional: true } },
};

// Real shape of a site's lockfile (power-construction-website, 2026-11-27).
const lock = {
  name: "site",
  version: "0.1.0",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "site", dependencies: { "@roundhouse/spam-filter": "github:RoundhouseTEAM/roundhouse-spam-filter", next: "16.0.0" } },
    "node_modules/@roundhouse/spam-filter": {
      version: "2.60.0",
      resolved: `git+ssh://git@github.com/RoundhouseTEAM/roundhouse-spam-filter.git#${OLD}`,
      license: "UNLICENSED",
      peerDependencies: { react: ">=18" },
      peerDependenciesMeta: { react: { optional: true } },
    },
    "node_modules/next": { version: "16.0.0", libc: ["glibc"] },
  },
};
const text = JSON.stringify(lock, null, 2) + "\n";

let passed = 0;
function test(label, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${label}`);
}

test("bumps only the spam-filter entry, to the new commit and version", () => {
  const r = bumpLock(text, pkg, NEW);
  assert.equal(r.status, "bumped");
  assert.equal(r.from, "2.60.0 (e386d0c)");
  const out = JSON.parse(r.text);
  assert.deepEqual(out.packages["node_modules/@roundhouse/spam-filter"], {
    version: "2.63.0",
    resolved: `git+ssh://git@github.com/RoundhouseTEAM/roundhouse-spam-filter.git#${NEW}`,
    license: "UNLICENSED",
    peerDependencies: { react: ">=18" },
    peerDependenciesMeta: { react: { optional: true } },
  });
  // Every other line is untouched: the diff is exactly one entry.
  const changed = r.text.split("\n").filter((l, i) => l !== text.split("\n")[i]);
  assert.equal(changed.length, 2, changed.join("\n"));
});

test("a lockfile already on the commit is left alone", () => {
  const r = bumpLock(bumpLock(text, pkg, NEW).text, pkg, NEW);
  assert.equal(r.status, "current");
});

test("lockfileVersion 2's legacy dependencies tree is bumped too", () => {
  const v2 = structuredClone(lock);
  v2.lockfileVersion = 2;
  v2.dependencies = { "@roundhouse/spam-filter": { version: `git+ssh://git@github.com/RoundhouseTEAM/roundhouse-spam-filter.git#${OLD}`, from: "@roundhouse/spam-filter@github:RoundhouseTEAM/roundhouse-spam-filter" } };
  const out = JSON.parse(bumpLock(JSON.stringify(v2, null, 2) + "\n", pkg, NEW).text);
  assert.ok(out.dependencies["@roundhouse/spam-filter"].version.endsWith(`#${NEW}`));
  assert.equal(out.dependencies["@roundhouse/spam-filter"].from, "@roundhouse/spam-filter@github:RoundhouseTEAM/roundhouse-spam-filter");
});

test("a lockfile not in npm's 2-space format is refused, never reformatted", () => {
  assert.throws(() => bumpLock(JSON.stringify(lock, null, 4) + "\n", pkg, NEW), /2-space/);
});

test("a lockfile with no spam-filter entry is refused", () => {
  const none = structuredClone(lock);
  delete none.packages["node_modules/@roundhouse/spam-filter"];
  assert.throws(() => bumpLock(JSON.stringify(none, null, 2) + "\n", pkg, NEW), /no "node_modules/);
});

test("runtime dependencies stop the rollout (a rewrite can't install them)", () => {
  assert.throws(() => lockEntry({ ...pkg, dependencies: { zod: "^3" } }, NEW), /runtime dependencies/);
});

test("package.json spec: the normal github spec is rolled out", () => {
  assert.deepEqual(checkSpec(JSON.stringify({ dependencies: { "@roundhouse/spam-filter": "github:RoundhouseTEAM/roundhouse-spam-filter" } })), { ok: true });
});

test("package.json spec: a deliberate #pin is respected", () => {
  const r = checkSpec(JSON.stringify({ dependencies: { "@roundhouse/spam-filter": "github:RoundhouseTEAM/roundhouse-spam-filter#v2.40.0" } }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /pinned/);
});

test("package.json spec: a repo without the package is skipped", () => {
  assert.equal(checkSpec(JSON.stringify({ dependencies: { next: "16" } })).ok, false);
});

console.log(`rollout: ${passed} passed`);
