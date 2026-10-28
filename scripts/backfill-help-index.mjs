#!/usr/bin/env node
/* ── Put the help articles where a question can reach them ───────────────────────────────────────
 *
 * ⚠️ THE WORK IS IN services/helpIndexBuild.js, NOT HERE. Admin's **Help Index** screen does the
 * same job from a browser — Sandeep: *"i dont prefer running such mjs manually … build it in
 * admin"* — and two copies of "what is a section" would make the index depend on which door
 * rebuilt it, with nothing saying so. This file is only: read the folder, pick the target, and say
 * what happened.
 *
 * ⚠️ IT REBUILDS ONLY WHAT CHANGED. Each row carries its article's `content_hash` (migration 145),
 * so a typical edit is one article — about six sections, two seconds — rather than all 364 and two
 * minutes. `--all` forces everything, which is what an embedding-model change needs.
 *
 *   node scripts/backfill-help-index.mjs --dry     # show the diff, embed nothing, write nothing
 *   node scripts/backfill-help-index.mjs           # apply to SUPABASE_URL (dev)
 *   node scripts/backfill-help-index.mjs --prod    # apply to PROD_SUPABASE_URL
 *   node scripts/backfill-help-index.mjs --all     # re-embed every article, not just the changed
 */

import 'dotenv/config';
for (const [k, v] of Object.entries({
  REDIS_URL: 'redis://unused.backfill.invalid:6379',
  R2_ACCESS_KEY_ID: 'unused-by-backfill', R2_SECRET_ACCESS_KEY: 'unused-by-backfill',
})) if (!process.env[k]) process.env[k] = v;

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ⚠️ AN UNKNOWN FLAG STOPS THE RUN, before anything is read or any target is named. Typing
   `--dry-run` instead of `--dry` once silently meant LIVE: it embedded all 352 sections and went
   on to rewrite the table. A script whose safe mode is spelled slightly differently from the
   obvious guess must not treat the guess as consent. */
const KNOWN = new Set(['--dry', '--prod', '--all']);
const unknown = process.argv.slice(2).filter(a => a.startsWith('-') && !KNOWN.has(a));
if (unknown.length) {
  console.error(`unknown option(s): ${unknown.join(', ')} — known: ${[...KNOWN].join(' ')}. Nothing was run.`);
  process.exit(2);
}
const DRY = process.argv.includes('--dry');
const TO_PROD = process.argv.includes('--prod');
const ALL = process.argv.includes('--all');

/* Default is whatever SUPABASE_URL names. `--prod` REFUSES rather than falling back: silently
   writing to dev when somebody asked for prod looks exactly like success. */
let supabase;
if (TO_PROD) {
  const url = process.env.PROD_SUPABASE_URL;
  const key = process.env.PROD_SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('✗ --prod needs PROD_SUPABASE_URL and PROD_SUPABASE_SERVICE_KEY. Nothing was run.');
    process.exit(2);
  }
  const { createClient } = await import('@supabase/supabase-js');
  supabase = createClient(url, key);
} else {
  ({ supabase } = await import('../src/services/supabase.js'));
}
const { planHelpIndex, applyHelpIndex } = await import('../src/services/helpIndexBuild.js');

/* Named out loud before anything is written. The project ref is in every browser bundle we serve,
   so printing it leaks nothing — and it is the only way to be sure which database is about to be
   changed. */
const TARGET = (TO_PROD ? process.env.PROD_SUPABASE_URL : process.env.SUPABASE_URL ?? '')
  .replace(/^https?:\/\//, '').split('.')[0];
console.log(`→ ${TO_PROD ? 'PRODUCTION' : 'dev'}: ${TARGET}\n`);

const HELP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'spattoo-docs', 'help');
const files = readdirSync(HELP_DIR).filter(f => f.endsWith('.md'))
  .map(filename => ({ filename, text: readFileSync(join(HELP_DIR, filename), 'utf8') }));

const show = (label, list, f = a => a.filename) => {
  if (!list.length) return;
  console.log(`${label} (${list.length})`);
  for (const a of list.slice(0, 12)) console.log(`   ${f(a)}`);
  if (list.length > 12) console.log(`   …and ${list.length - 12} more`);
};

const plan = await planHelpIndex(files, supabase);
console.log(`${files.length} file(s) on disk → ${plan.articles} indexable article(s), ${plan.rows} section(s)`);
if (plan.firstRun) console.log('⚠ the index is EMPTY here — this is a first run, not a diff\n');
show('changed', plan.changed);
show('new', plan.added);
show('no longer live / removed', plan.removed, a => `${a.doc_slug} (${a.sections} sections)`);
show('skipped — not a live baker or faq article', plan.skipped, a => `${a.filename}: ${a.why}`);
console.log(`unchanged: ${plan.unchanged.length}`);
console.log(`embeddings needed: ${ALL ? plan.rows + ' (--all)' : plan.embeddingsNeeded}\n`);

if (DRY) {
  console.log('(--dry: nothing embedded, nothing written)');
  process.exit(0);
}

if (!ALL && !plan.changed.length && !plan.added.length && !plan.removed.length) {
  console.log('✓ nothing to do — the index already matches the articles');
  process.exit(0);
}

/* `--all` is expressed as "pretend nothing matches", so there is one code path rather than two. */
const toApply = ALL ? files.map(f => ({ ...f, text: f.text })) : files;
if (ALL) {
  const { error } = await supabase.from('help_sections').delete().neq('doc_slug', '');
  if (error) { console.error('clear failed:', error.message); process.exit(1); }
  console.log('--all: cleared the index first');
}

const res = await applyHelpIndex(toApply, supabase, {
  /* The CLI always uploads the WHOLE folder, so an article missing from it really has gone. */
  pruneMissing: true,
  onProgress: (d, t) => { if (d % 25 === 0 || d === t) process.stdout.write(`   embedded ${d}/${t}\r`); },
});

if (!res.ok) { console.error(`\n✗ ${res.reason}`); process.exit(1); }
console.log(`\n✓ ${res.embedded} section(s) embedded across ${res.articlesWritten} article(s)`);
if (res.pruned.length) console.log(`  removed: ${res.pruned.join(', ')}`);
console.log(`  untouched: ${res.untouched} article(s)`);
