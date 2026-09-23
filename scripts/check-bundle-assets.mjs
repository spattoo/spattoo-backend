// ── Every picture a promotion bundle's rows point at TRAVELS WITH THEM ───────────────────────────
//
// Elements are authored on dev and promoted to prod as a JSON bundle (routes/elements.js →
// lib/promotionBundle.js). Rows go out verbatim; the R2 objects they name are listed separately in
// `assets` and copied by the importer. So a row whose picture is not in that list imports CLEANLY
// and renders BROKEN — there is no error anywhere, because nothing on the target knows a key was
// supposed to have bytes behind it.
//
// That is not hypothetical, and it has now happened twice:
//
//   migration 068  a category's own menu picture (`element_categories.thumb_key`) — the category
//                  travelled, its picture did not, and the decorations menu showed a broken square.
//   migration 031  the craft guide's four-panel sheet (`element_craft_guide.stages_key`) — reported
//                  2026-09-22 on the fondant heart: *"it imported only the text part of the guide,
//                  not images."*
//
// Both are the same mistake: a column holding an R2 key was added to a table the bundle carries, and
// the closure that collects keys was not told. Nothing connects the two, so nothing complained.
//
// ── What this checks ────────────────────────────────────────────────────────────────────────────
// Every column on a BUNDLED TABLE whose name looks like an asset (`*_key`, `*_url`, `*_image_url`)
// is either named in promotionBundle.js's key walk, or listed below with the reason it is not one.
// A new asset column fails this check until somebody decides which it is — and that decision is the
// point. This cannot verify the key is COLLECTED correctly, only that nobody added one silently.
//
// ⚠️ IT READS `migrations/`, SO IT SEES WHAT MIGRATIONS ADDED — NOT THE ORIGINAL SCHEMA. The oldest
// tables (cake_elements among them) were created before this folder existed, so `image_url` and
// `thumbnail_url` are invisible to it and always will be. That is not a hole worth closing: those
// three have been collected since the bundle was written, and every asset column since has arrived
// as a migration. This guards the direction the mistake actually comes from — a NEW column — and
// says so rather than implying it has seen everything.
//
// Run: `npm run check:bundle-assets`.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = readFileSync(join(ROOT, 'src/lib/promotionBundle.js'), 'utf8');

// The tables a bundle carries rows for — see elementClosure and templateClosure.
const BUNDLED = [
  'cake_elements', 'element_types', 'element_categories', 'tags', 'element_tags',
  'element_craft_guide', 'cake_templates', 'cake_shapes',
];

// Columns that MATCH the name pattern but hold no R2 key. Each needs a reason, because "it is not
// an asset" is a claim about the data, not about the name.
const NOT_AN_ASSET = new Map([
  ['stages_error',   'the reason a sheet failed to render — text, not a key (migration 094)'],
  ['public_url',     'a fully-qualified URL to somewhere else, never an object in our bucket'],
  ['r2_public_url',  'the bundle SOURCE marker, recorded so an import can notice one aimed at itself'],
  ['storefront_url', 'a baker\'s own website address'],
]);

const sql = readdirSync(join(ROOT, 'migrations'))
  .filter(f => f.endsWith('.sql'))
  .map(f => [f, readFileSync(join(ROOT, 'migrations', f), 'utf8')]);

// `alter table X add column [if not exists] name` and columns inside `create table X (...)`.
const found = new Map();          // column → the file that introduced it
for (const [file, text] of sql) {
  for (const t of BUNDLED) {
    const alter = new RegExp(`alter\\s+table\\s+(?:public\\.)?${t}\\s+add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?([a-z0-9_]+)`, 'gi');
    for (const m of text.matchAll(alter)) if (!found.has(m[1])) found.set(m[1], `${file} (${t})`);

    const create = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${t}\\s*\\(([\\s\\S]*?)\\n\\s*\\);`, 'gi');
    for (const m of text.matchAll(create)) {
      for (const line of m[1].split('\n')) {
        const col = line.trim().match(/^([a-z0-9_]+)\s+[a-z]/i);
        if (col && !found.has(col[1])) found.set(col[1], `${file} (${t})`);
      }
    }
  }
}

const assetish = [...found].filter(([col]) => /_(key|url)$/.test(col));
const missing = assetish.filter(([col]) => !NOT_AN_ASSET.has(col) && !bundle.includes(col));

if (missing.length) {
  console.error('✗ check:bundle-assets — a column holding an R2 key is not collected by the bundle:\n');
  for (const [col, where] of missing) console.error(`    ${col}  —  ${where}`);
  console.error(`
  A bundle that does not carry this object imports without error and renders broken.
  Either collect it in src/lib/promotionBundle.js (elementClosure / templateClosure),
  or add it to NOT_AN_ASSET in this script with the reason it holds no key.`);
  process.exit(1);
}

const named = assetish.filter(([col]) => bundle.includes(col)).length;
console.log(`✓ check:bundle-assets — every asset column a migration added to a bundled table travels `
  + `(${named} collected, ${NOT_AN_ASSET.size} named as not assets; the pre-migrations schema is not visible here)`);
