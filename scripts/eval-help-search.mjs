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
function sectionsOf(body) {
  const out = []; let heading = null, buf = [];
  const flush = () => { const t = buf.join('\n').trim(); if (t) out.push({ heading, body: t }); buf = []; };
  for (const line of body.split('\n')) {
    if (/^#\s+/.test(line)) continue;
    if (/^##\s+/.test(line)) { flush(); heading = line.replace(/^##\s+/, '').trim(); continue; }
    buf.push(line);
  }
  flush(); return out;
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
