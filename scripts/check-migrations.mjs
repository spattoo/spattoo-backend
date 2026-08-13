#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Migration numbering gate.
//
// A migration's number is its place in a TOTAL ORDER. Two files sharing one have
// none — whichever a human happens to run first is the order that took effect,
// and two environments can silently differ.
//
// It has already happened three times:
//
//   024_bakers_first_paid_at.sql   024_rename_xray_spec.sql
//   052_delivery_digest.sql        052_premium_storefront_themes.sql
//   053_device_tokens.sql          053_plan_copy_premium_themes.sql
//
// 052 and 053 were both taken on 2026-08-05 by two sessions working the same
// afternoon, each of which read "the highest is 051" and each of which took the
// next number. Neither noticed, because nothing checked. (They are now 054/055;
// 024 predates that and cannot be renamed — see below.)
//
// ── THIS IS THE SAME BUG THE RELEASE SCRIPT ALREADY FIXED ────────────────────
// scripts/release.mjs says it out loud: "`npm version patch` increments the LOCAL
// package.json and asks nobody. Two sessions working the same afternoon both read
// 0.1.192, both cut 0.1.193 … That happened twice in one day." Its fix was to
// derive the next number from what exists ON THE REMOTE, not from local state.
//
// So this checks BOTH:
//   1. duplicates on disk, and
//   2. a newly ADDED migration whose number already exists on origin/dev —
//      the actual failure mode, which a purely local check cannot see, because
//      the colliding file is in somebody else's working tree until they push.
//
// Zero dependencies (matches check:schema / check:print-sheets house style).
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR  = join(ROOT, 'migrations');

// ── Grandfathered ────────────────────────────────────────────────────────────
// 024 is duplicated and STAYS duplicated. Both halves were applied to every
// environment long ago, and renumbering an applied migration makes the file
// disagree with the database it already ran against — with no record of what has
// run, there is nothing to reconcile against afterwards. Renaming would trade a
// documented wart for an undocumented lie.
//
// Nothing may be added here. A new duplicate is a mistake caught before it is
// applied, which is exactly when it is still free to fix.
const GRANDFATHERED = new Set(['024']);

const numberOf = (f) => (f.match(/^(\d+)_/) ?? [])[1] ?? null;

// ── 1. Duplicates on disk ────────────────────────────────────────────────────
const local = readdirSync(DIR).filter(f => f.endsWith('.sql'));
const byNumber = new Map();
for (const f of local) {
  const n = numberOf(f);
  if (!n) continue;                      // unnumbered helpers are not part of the order
  if (!byNumber.has(n)) byNumber.set(n, []);
  byNumber.get(n).push(f);
}

const duplicates = [...byNumber.entries()]
  .filter(([n, fs]) => fs.length > 1 && !GRANDFATHERED.has(n))
  .sort(([a], [b]) => a.localeCompare(b));

// ── 2. A new migration taking a number the remote already used ───────────────
// Only ADDED files, and only against origin/dev. A modified or renamed file is
// not a new claim on a number.
const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n').filter(Boolean);

// ⚠️ The try wraps ONLY the ls-tree, and that is deliberate. It used to wrap this whole
// block, and it hid a real bug for the entire life of the check: the line below read
// `.map(basename)`, and Array.map passes the INDEX as the second argument — which
// basename() takes as a string `suffix`. Every run threw TypeError, the catch swallowed
// it, and the gate reported "none collides with origin/dev" while never having looked.
//
// A catch that cannot tell "the ref is missing" from "the code is broken" reports success
// for both. So the only thing allowed to fail quietly is the one call that legitimately
// fails on a fresh clone or offline.
let remote = null;
try {
  remote = new Map();
  for (const p of git('ls-tree', '--name-only', 'origin/dev', 'migrations/')) {
    const f = basename(p);
    const n = numberOf(f);
    if (n) remote.set(n, f);
  }
} catch {
  remote = null;   // origin/dev not fetched. The on-disk check above still ran.
}

const remoteClash = [];
if (remote) {
  // AR, not A. Git reports a staged delete-plus-add as a RENAME when the contents are
  // similar, so `--diff-filter=A` skipped exactly the case this exists for: your new file
  // landing on a number whose owner you have not pulled yet. Renaming ONTO a taken number
  // is the same mistake as adding onto one.
  const added = git('diff', '--cached', '--name-only', '--diff-filter=AR', '--', 'migrations/')
    .map(p => basename(p));

  for (const f of added) {
    const n = numberOf(f);
    if (!n) continue;
    const theirs = remote.get(n);
    // Same name = the same file already pushed (a re-add). Only a DIFFERENT file
    // on the same number is somebody else's claim.
    if (theirs && theirs !== f) remoteClash.push({ n, mine: f, theirs });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
if (duplicates.length || remoteClash.length) {
  console.error('\n✗ check:migrations — a migration number is claimed twice:\n');

  for (const [n, fs] of duplicates) {
    console.error(`  ${n} is used by ${fs.length} files:`);
    for (const f of fs) console.error(`     migrations/${f}`);
    console.error('');
  }

  for (const { n, mine, theirs } of remoteClash) {
    console.error(`  ${n} is already on origin/dev:`);
    console.error(`     yours:  migrations/${mine}`);
    console.error(`     theirs: migrations/${theirs}`);
    console.error('');
  }

  const next = String(Math.max(...[...byNumber.keys()].map(Number)) + 1).padStart(3, '0');
  console.error(`  Renumber yours — the next free number is ${next}.`);
  console.error('  Rename with `git mv` so the history follows, and fix the header line and any');
  console.error('  "See migration NNN" references. Do it BEFORE applying it anywhere: renumbering');
  console.error('  a migration that has already run makes the file disagree with the database, and');
  console.error('  nothing records what has run to reconcile against.\n');
  process.exit(1);
}

const counted = [...byNumber.keys()].length;
const scope = remote ? 'and none collides with origin/dev' : '(origin/dev not fetched — local only)';
console.log(`✓ check:migrations — ${counted} numbers, each used once ${scope}`);
