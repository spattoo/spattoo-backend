// ── Every R2 key is written ONCE ────────────────────────────────────────────────────────────────
// putObject stamps `public, max-age=31536000, immutable` on everything it stores, and browsers and
// CDNs are entitled to take that literally. Overwriting a fixed key is therefore not a small sin: the
// bytes change and nothing ever fetches them again. decorationStages.js says it best — a URL that
// never changes never lies.
//
// Two things now DEPEND on that being true, which is why it needs a guard rather than a comment:
//
//   1. The immutable cache header itself.
//   2. Bundle import (routes/elements.js) SKIPS any asset whose key already exists here, on the
//      grounds that an existing key already holds the right bytes. If some path starts rewriting
//      keys, that skip silently serves stale pictures — no error, just a subtly wrong cake.
//
// ── What this checks ────────────────────────────────────────────────────────────────────────────
// Not "does every key contain randomUUID()" — that would be false. Three sites DERIVE a key from
// another key (`-nobg.webp`, `-512.webp`, `.webp`), and they are fine: the key they derive from is
// minted once, so the derived one is written once too.
//
// A rule subtle enough to have three legitimate-looking exceptions cannot be pattern-matched. So this
// checks the thing a machine can actually verify: that the set of places writing objects is the set
// somebody has REVIEWED. A new write site fails this check, and the fix is to look at how it builds
// its key and add it below with the reason. That review is the guard; this script only makes sure it
// happens.
//
// Run: `npm run check:object-keys`.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

// The reviewed write sites, each with HOW its key is made unique. Adding a line here is a claim that
// the key is written once — check it before you make it.
const REVIEWED = new Map([
  ['lib/signUpload.js',              'randomUUID() per signed upload'],
  ['routes/uploads.js',              'randomUUID() per cutout'],
  ['routes/meshy.js',                'randomUUID() per generated GLB'],
  ['routes/elementExtract.js',       'randomUUID() per crop'],
  ['routes/ediblePrints.js',         'randomUUID() per generated print — one press, one new key'],
  ['routes/bakers.js',               'randomUUID() per gallery copy'],
  ['jobs/processors/extractImage.js','randomUUID() per output'],
  // Derived keys. Safe because the key they are built FROM is minted once, so the derivation is too.
  // Each is written when its source object is first processed and not again.
  ['jobs/processors/removeLogoBg.js','derived: <logoKey>-nobg.webp'],
  ['services/thumbnails.js',         'derived: <thumbnailKey>-<maxDim>.webp'],
  ['services/imageOptimize.js',      'derived: <key>.webp'],
  // Timestamped rather than random: a guide is REBUILT, so the key must differ per generation or the
  // immutable cache pins the old picture forever. The caller deletes the previous object.
  ['services/decorationStages.js',   'stamp() — Date.now() base36, new key per generation'],
  // The importer writes keys it did not mint: they come from the bundle, made by one of the sites
  // above in the environment that exported it. This is also the site that RELIES on the invariant.
  ['routes/elements.js',             "the bundle's own keys, minted by another environment"],
]);

const WRITERS = /\b(?:putObject|copyObject|getSignedUploadUrl)\s*\(/;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const found = new Set();
for (const file of walk(SRC)) {
  const rel = relative(SRC, file);
  if (rel === join('services', 'r2.js')) continue;          // where the writers are DEFINED
  // Strip line comments so a writer merely NAMED in prose does not read as a call site.
  const text = readFileSync(file, 'utf8').split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  if (WRITERS.test(text)) found.add(rel.split(/[/\\]/).join('/'));
}

const unreviewed = [...found].filter(f => !REVIEWED.has(f));
const stale = [...REVIEWED.keys()].filter(f => !found.has(f));

if (unreviewed.length) {
  console.error('✗ check:object-keys — object-write site(s) nobody has reviewed:\n');
  for (const f of unreviewed) console.error(`    src/${f}`);
  console.error(
    '\n  Every R2 key must be written ONCE: putObject marks objects immutable, and bundle import\n' +
    '  skips keys that already exist. A rewritten key serves stale bytes with no error.\n' +
    '  Check how this site builds its key, then add it to REVIEWED in scripts/check-object-keys.mjs\n' +
    '  with the reason it is unique.\n');
  process.exit(1);
}

if (stale.length) {
  console.error('✗ check:object-keys — REVIEWED names site(s) that no longer write objects:\n');
  for (const f of stale) console.error(`    src/${f}`);
  console.error('\n  Remove them, so the list stays a description of the code rather than of its history.\n');
  process.exit(1);
}

console.log(`✓ check:object-keys — all ${found.size} object-write sites reviewed; every key written once`);
