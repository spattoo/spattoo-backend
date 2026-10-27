#!/usr/bin/env node
/* ── Does asking a question actually find the right help section? ────────────────────────────────
 *
 * Reads the articles straight off disk and embeds them in memory, so retrieval quality can be
 * judged BEFORE migration 141 is applied anywhere. Same chunking and same ranker the real service
 * uses — only the storage differs.
 *
 *   node scripts/eval-help-search.mjs
 *   node scripts/eval-help-search.mjs --ask "how do I put a photo on a cake"
 */
import 'dotenv/config';
for (const [k, v] of Object.entries({
  REDIS_URL: 'redis://unused.eval.invalid:6379',
  R2_ACCESS_KEY_ID: 'unused-by-eval', R2_SECRET_ACCESS_KEY: 'unused-by-eval',
})) if (!process.env[k]) process.env[k] = v;

import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { embedText } = await import('../src/services/openai.js');
const { cosine, rankSections } = await import('../src/services/helpRank.js');

const HERE = dirname(fileURLToPath(import.meta.url));
const HELP_DIR = join(HERE, '..', '..', 'spattoo-docs', 'help');
/* Cached, because re-embedding 352 sections for every run is money and minutes spent re-learning
   the same vectors. Delete the file to rebuild. */
const CACHE = join(HERE, '.help-eval-cache.json');

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
/* Mirrors scripts/backfill-help-index.mjs — the trailing *"Checked against the app on …"* note is
   addressed to us, not to a baker, and 54 of the 58 articles carry one. If these two chunkers
   disagree, the eval measures a corpus the index does not contain. */
function stripProvenance(body) {
  const lines = body.split('\n');
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let start = end;
  while (start > 0 && lines[start - 1].trim()) start--;
  const last = lines.slice(start, end).join(' ').trim();
  if (!(last.startsWith('*') && /hecked against the app/.test(last))) return body;
  let cut = start;
  while (cut > 0 && !lines[cut - 1].trim()) cut--;
  if (cut > 0 && lines[cut - 1].trim() === '---') cut--;
  return lines.slice(0, cut).join('\n');
}
function sectionsOf(raw) {
  const body = stripProvenance(raw);
  const out = []; let heading = null, buf = [];
  const flush = () => { const t = buf.join('\n').trim(); if (t) out.push({ heading, body: t }); buf = []; };
  for (const line of body.split('\n')) {
    if (/^#\s+/.test(line)) continue;
    if (/^##\s+/.test(line)) { flush(); heading = line.replace(/^##\s+/, '').trim(); continue; }
    buf.push(line);
  }
  flush(); return out;
}

/* ── --cases: grade the corpus against spattoo-docs/help/questions.json ──────────────────────────
 *
 * ⚠️ THE ASSERTION IS THE PHRASE, NOT THE ARTICLE. Checking only that the right article came back
 * would have passed several questions that were not answered at all — the measured failure is
 * retrieval finding the right article and that article not containing the fact. So a case passes
 * only when the returned TEXT contains what a correct answer must say.
 *
 * ⚠️ AND IT READS THE LIVE INDEX, not the files on disk, because that is what a baker gets. If the
 * backfill has not been run since an article changed, this says so by failing — which is the same
 * thing spattoo-docs' push gate says, from the other end.
 */
if (process.argv.includes('--cases')) {
  const { searchHelp } = await import('../src/services/helpSearch.js');
  const CASES = join(HELP_DIR, 'questions.json');
  const { cases } = JSON.parse(readFileSync(CASES, 'utf8'));

  const out = { pass: [], wrongDoc: [], missingFact: [], nothing: [], toWrite: [], unexpected: [] };
  for (const c of cases) {
    const r = await searchHelp(c.q);
    const hit = r.sections?.length ? r.sections : null;
    const text = (hit ?? []).map(s => `${s.doc_title}\n${s.heading ?? ''}\n${s.body}`).join('\n');
    const docOk = !c.doc || (hit ?? []).some(s => s.doc_slug === c.doc);
    const factOk = (c.contains ?? []).every(p => text.toLowerCase().includes(String(p).toLowerCase()));
    const row = { ...c, top: hit?.[0] ? `${hit[0].doc_slug}§${hit[0].heading ?? '(opening)'}` : '—',
                  score: hit?.[0] ? hit[0].score : 0 };

    if (c.status === 'to-write') {
      /* ⚠️ A 'to-write' CASE THAT NOW PASSES IS NEWS, NOT NOISE. Somebody wrote the article and
         this file was not updated — which would leave it on the to-do list forever. */
      if (docOk && factOk && (c.contains ?? []).length) out.unexpected.push(row);
      else out.toWrite.push(row);
      continue;
    }
    if (!hit) out.nothing.push(row);
    else if (!docOk) out.wrongDoc.push(row);
    else if (!factOk) out.missingFact.push(row);
    else out.pass.push(row);
  }

  const n = cases.filter(c => c.status !== 'to-write').length;
  console.log(`${out.pass.length}/${n} answerable cases pass\n`);
  const show = (label, rows, why) => {
    if (!rows.length) return;
    console.log(`${label} (${rows.length})${why ? ' — ' + why : ''}`);
    for (const r of rows) {
      console.log(`   "${r.q}"`);
      console.log(`      got ${r.top} ${r.score ? `(${r.score.toFixed(3)})` : ''}`);
      if (r.contains?.length) console.log(`      wanted text containing: ${r.contains.map(x => `"${x}"`).join(', ')}`);
      if (r.note) console.log(`      ${r.note}`);
    }
    console.log('');
  };
  show('✗ NOTHING FOUND', out.nothing, 'nothing cleared the answer floor');
  show('✗ WRONG ARTICLE', out.wrongDoc, 'retrieval missed');
  show('✗ FACT MISSING', out.missingFact, 'right article, the answer is not in it');
  show('! NOW ANSWERED', out.unexpected, 'mark these answerable in questions.json');
  console.log(`○ still to write (${out.toWrite.length}):`);
  for (const r of out.toWrite) console.log(`   ${r.q}${r.note ? `\n      ${r.note}` : ''}`);
  process.exit(out.nothing.length + out.wrongDoc.length + out.missingFact.length ? 1 : 0);
}


let rows;
if (existsSync(CACHE)) {
  rows = JSON.parse(readFileSync(CACHE, 'utf8'));
  console.log(`${rows.length} sections from cache\n`);
} else {
  rows = [];
  for (const file of readdirSync(HELP_DIR).filter(f => f.endsWith('.md'))) {
    const { meta, body } = parseFrontmatter(readFileSync(join(HELP_DIR, file), 'utf8'));
    if (meta.audience !== 'baker') continue;
    if (meta.status && meta.status !== 'live') continue;
    sectionsOf(body).forEach((sec, i) => rows.push({
      doc_slug: meta.id || file.replace(/\.md$/, ''), doc_title: meta.title || file,
      heading: sec.heading, body: sec.body, position: i,
      checked_against_app: meta.checked_against_app ?? null,
    }));
  }
  console.log(`embedding ${rows.length} sections…`);
  for (const [i, r] of rows.entries()) {
    const { embedding } = await embedText([r.doc_title, r.heading, r.body].filter(Boolean).join('\n').slice(0, 6000));
    r.v = embedding;
    if ((i + 1) % 50 === 0) process.stdout.write(`   ${i + 1}/${rows.length}\r`);
  }
  writeFileSync(CACHE, JSON.stringify(rows));
  console.log(`   cached to ${CACHE}\n`);
}

const i = process.argv.indexOf('--ask');
const QUESTIONS = i > -1 ? [process.argv[i + 1]] : [
  'how do I change the colour of the cake',
  'can I put a photo on a cake',
  'how do I give a customer a price',
  'where do I see what is due tomorrow',
  'how do I make the cake two tiers',
  'what do I do when someone asks for a quote',
  'how do I add my own picture as a decoration',
  'how do I set up my shop page',
  'what is the weather in chennai',           // nothing in the corpus answers this
];

for (const q of QUESTIONS) {
  const { embedding } = await embedText(q);
  const scored = rows.map(r => ({ ...r, score: cosine(embedding, r.v) }));
  const hits = rankSections(scored, { limit: 3, perDoc: 1 });
  console.log(`"${q}"`);
  if (!hits.length) { console.log('   — nothing above the floor; the honest answer is "I don\'t know" —\n'); continue; }
  for (const h of hits) {
    console.log(`   ${h.score.toFixed(3)}  ${h.doc_title}`);
    console.log(`          §${h.heading ?? '(opening)'}  · checked ${h.checked_against_app ?? 'never'}`);
  }
  console.log('');
}
