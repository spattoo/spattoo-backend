#!/usr/bin/env node
/* ── Put the help articles where a question can reach them ───────────────────────────────────────
 *
 * Reads spattoo-docs/help/*.md, cuts each article at its `##` headings, and stores one embedded row
 * per section in `help_sections` (migration 141).
 *
 * ⚠️ A ROW IS A SECTION, NOT A DOCUMENT. 60 articles carry 312 second-level headings between them,
 * and the headings are task-shaped — "Opening the tier", "Blending two creams into each other".
 * Somebody asking how to change a colour wants that section, not a 76-line article. One vector per
 * article would also average six tasks together and match all six weakly.
 *
 * ⚠️ REBUILT WHOLESALE, LIKE THE TEMPLATE DERIVED DATA. A heading renamed or a section deleted must
 * stop being an answer — and an upsert-only pass would leave the old one behind to be retrieved
 * forever. The articles are the source of truth; this table is a copy with vectors on it.
 *
 * ⚠️ AND IT SKIPS WHAT IS NOT FOR A BAKER. Two of the sixty carry a different `audience`; a help
 * assistant answering a baker with an internal note is worse than answering nothing.
 *
 *   node scripts/backfill-help-index.mjs --dry     # parse and report, embed nothing, write nothing
 *   node scripts/backfill-help-index.mjs
 */

import 'dotenv/config';
for (const [k, v] of Object.entries({
  REDIS_URL: 'redis://unused.backfill.invalid:6379',
  R2_ACCESS_KEY_ID: 'unused-by-backfill', R2_SECRET_ACCESS_KEY: 'unused-by-backfill',
})) if (!process.env[k]) process.env[k] = v;

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { supabase } = await import('../src/services/supabase.js');
const { embedText } = await import('../src/services/openai.js');

const DRY = process.argv.includes('--dry');
const HELP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spattoo-docs', 'help');

/** Frontmatter is a flat `key: value` block between the first two `---` lines. */
function parseFrontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

/**
 * Cut an article into sections.
 *
 * ⚠️ `###` STAYS WITH ITS PARENT. "Results are grouped" under "Searching" is a detail OF searching,
 * not a separate answer, and splitting there produces fragments that make no sense alone.
 * ⚠️ THE `#` TITLE LINE IS DROPPED — it repeats `doc_title`, which every row already carries.
 */
function sectionsOf(body) {
  const lines = body.split('\n');
  const out = [];
  let heading = null, buf = [];
  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) out.push({ heading, body: text });
    buf = [];
  };
  for (const line of lines) {
    if (/^#\s+/.test(line)) continue;                    // the article title, already stored
    if (/^##\s+/.test(line)) { flush(); heading = line.replace(/^##\s+/, '').trim(); continue; }
    buf.push(line);
  }
  flush();
  return out;
}

/* What gets embedded. The article title and the heading go in with the body because a question is
   usually phrased in their words — "how do I change the cake colour" is almost the title itself —
   and a body that says "tap the tier" names neither. */
const embedTextFor = (docTitle, heading, body) =>
  [docTitle, heading, body].filter(Boolean).join('\n').slice(0, 6000);

const files = readdirSync(HELP_DIR).filter(f => f.endsWith('.md'));
const rows = [];
let skipped = 0;

for (const file of files) {
  const { meta, body } = parseFrontmatter(readFileSync(join(HELP_DIR, file), 'utf8'));
  /* ⚠️ `audience: baker` MUST BE STATED, not merely not-contradicted. The first cut skipped only
     articles that declared a DIFFERENT audience, which let the two files carrying no frontmatter
     at all straight in — INDEX.md and README.md, which are documents ABOUT the help set rather
     than help. INDEX alone contributed 14 "sections" of markdown tables that answer no question a
     baker would ask, and would have been retrievable forever. */
  if (meta.audience !== 'baker') { skipped++; continue; }
  if (meta.status && meta.status !== 'live') { skipped++; continue; }
  const slug = meta.id || file.replace(/\.md$/, '');
  const title = meta.title || slug;
  sectionsOf(body).forEach((sec, i) => {
    rows.push({
      doc_slug: slug,
      doc_title: title,
      heading: sec.heading,
      body: sec.body,
      position: i,
      audience: meta.audience ?? null,
      checked_against_app: meta.checked_against_app || null,
    });
  });
}

console.log(`${files.length} files → ${rows.length} sections (${skipped} file(s) skipped: not a live baker article)`);
const byDoc = rows.reduce((m, r) => ((m[r.doc_slug] = (m[r.doc_slug] ?? 0) + 1), m), {});
const busiest = Object.entries(byDoc).sort((a, b) => b[1] - a[1]).slice(0, 3);
console.log(`   most sections: ${busiest.map(([d, n]) => `${d} (${n})`).join(', ')}`);
const noHeading = rows.filter(r => !r.heading).length;
console.log(`   opening passages with no heading: ${noHeading}`);

if (DRY) {
  console.log('\nfirst three sections:');
  for (const r of rows.slice(0, 3)) {
    console.log(`   [${r.doc_title}] ${r.heading ?? '(opening)'} — ${r.body.slice(0, 90).replace(/\n/g, ' ')}…`);
  }
  console.log('\n(--dry: nothing embedded, nothing written)');
  process.exit(0);
}

let done = 0;
for (const r of rows) {
  const { embedding } = await embedText(embedTextFor(r.doc_title, r.heading, r.body));
  r.embedding = JSON.stringify(embedding);
  if (++done % 25 === 0) process.stdout.write(`   embedded ${done}/${rows.length}\r`);
}
console.log(`   embedded ${done}/${rows.length}      `);

/* ⚠️ DELETE THEN INSERT, for the reason syncTemplateDerived gives: a heading renamed or a section
   removed must stop being an answer, and an upsert leaves the old row behind to be retrieved
   forever. */
const { error: delErr } = await supabase.from('help_sections').delete().neq('doc_slug', '');
if (delErr) { console.error('clear failed:', delErr.message); process.exit(1); }

for (let i = 0; i < rows.length; i += 100) {
  const { error } = await supabase.from('help_sections').insert(rows.slice(i, i + 100));
  if (error) { console.error('insert failed:', error.message); process.exit(1); }
}
console.log(`✓ ${rows.length} sections indexed`);
