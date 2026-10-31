#!/usr/bin/env node
/* ── Twenty briefs, twenty cakes, and the honest scoreboard ──────────────────────────────────────
 *
 * ⚠️ THIS IS THE GO/NO-GO, AND IT IS A SCRIPT ON PURPOSE. The question that decides whether the
 * daily-cake-idea feature is worth building is "are the ideas any good on OUR catalogue" — and
 * that is answered by looking at twenty of them, not by wiring a route, metering, entitlements and
 * a screen and discovering the answer afterwards. The same shape `eval-help-search.mjs` already
 * has for the assistant.
 *
 * ⚠️ AND THE SCOREBOARD IS NOT "DID IT WORK". Every run will "work" — the guardrails guarantee a
 * buildable spec. The numbers that matter are how much of each cake came from the catalogue versus
 * how much it WANTED, because that is the real state of the library and it is the thing a demo
 * would hide. A brief that places two parts and wants five is not a success with a caveat; it is
 * the commissioning queue telling you what to model next.
 *
 *   node scripts/eval-ideas.mjs                       # all of scripts/idea-briefs.json
 *   node scripts/eval-ideas.mjs --out ../spattoo-core/public/ideas   # bundles for the renderer
 *   node scripts/eval-ideas.mjs --limit 3 --pool 80
 *
 * ⚠️ IT SPENDS REAL MONEY — one embedding and one gpt-4o call per brief, about 6.5k input tokens
 * each. Twenty briefs is pennies, not free, and nothing here is metered because no path is
 * baker-facing yet.
 */
import 'dotenv/config';
for (const [k, v] of Object.entries({
  REDIS_URL: 'redis://unused.eval.invalid:6379',
  R2_ACCESS_KEY_ID: 'unused-by-eval', R2_SECRET_ACCESS_KEY: 'unused-by-eval',
})) if (!process.env[k]) process.env[k] = v;

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const KNOWN = new Set(['--out', '--pool', '--limit', '--briefs']);
const unknown = args.filter(a => a.startsWith('-') && !KNOWN.has(a));
if (unknown.length) { console.error(`unknown option(s): ${unknown.join(', ')}`); process.exit(2); }
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };

const briefs = JSON.parse(readFileSync(flag('--briefs') ?? join(HERE, 'idea-briefs.json'), 'utf8'))
  .slice(0, Number(flag('--limit')) || Infinity);
const outDir = flag('--out');
if (outDir) mkdirSync(outDir, { recursive: true });

const { composeIdea, COMPOSE_POOL } = await import('../src/services/ideaCompose.js');
const pool = Number(flag('--pool')) || COMPOSE_POOL;

/* A filename a human can match back to its brief at a glance in a folder of twenty. */
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

const rows = [];
const wantedTally = new Map();
let tokens = 0;

for (const [i, brief] of briefs.entries()) {
  process.stdout.write(`[${String(i + 1).padStart(2)}/${briefs.length}] ${brief}\n`);
  let out;
  try { out = await composeIdea(brief, { k: pool }); }
  catch (e) { console.error(`        ✗ ${e.message}`); rows.push({ brief, error: e.message }); continue; }

  if (!out.spec) { console.error(`        ✗ ${out.reason}`); rows.push({ brief, error: out.reason }); continue; }

  const s = out.spec;
  const byId = new Map(out.shortlist.map(r => [r.id, r]));
  const names = s.elements.map(e => `${e.count > 1 ? e.count + '× ' : ''}${byId.get(e.elementId)?.name ?? '?'}`);
  tokens += out.usage?.prompt_tokens ?? 0;
  for (const w of s.wanted) wantedTally.set(w, (wantedTally.get(w) ?? 0) + 1);

  console.log(`        placed  ${names.join(', ') || '(nothing)'}`);
  console.log(`        wanted  ${s.wanted.join(', ') || '—'}`);
  if (out.rejected.length) console.log(`        refused ${out.rejected.map(r => `${r.name ?? r.i}: ${r.why}`).join('; ')}`);

  rows.push({
    brief, placed: s.elements.length, pieces: s.elements.reduce((n, e) => n + e.count, 0),
    wanted: s.wanted.length, refused: out.rejected.length, names, why: s.why,
  });

  if (outDir) {
    const used = new Set(s.elements.map(e => e.elementId));
    writeFileSync(join(outDir, `${slug(brief)}.json`),
      JSON.stringify({ spec: s, elements: out.shortlist.filter(r => used.has(r.id)) }, null, 2));
  }
}

// ── The scoreboard ──────────────────────────────────────────────────────────
const ok = rows.filter(r => !r.error);
const line = '─'.repeat(92);
console.log(`\n${line}\n${'brief'.padEnd(52)}${'placed'.padStart(7)}${'pieces'.padStart(8)}${'wanted'.padStart(8)}${'refused'.padStart(9)}\n${line}`);
for (const r of rows) {
  if (r.error) { console.log(`${r.brief.slice(0, 50).padEnd(52)}${'ERROR'.padStart(7)}  ${r.error.slice(0, 28)}`); continue; }
  console.log(`${r.brief.slice(0, 50).padEnd(52)}${String(r.placed).padStart(7)}${String(r.pieces).padStart(8)}${String(r.wanted).padStart(8)}${String(r.refused).padStart(9)}`);
}
console.log(line);

const sum = (f) => ok.reduce((n, r) => n + f(r), 0);
console.log(`${ok.length}/${rows.length} composed · ${sum(r => r.placed)} parts placed · ${sum(r => r.wanted)} wanted · ${sum(r => r.refused)} refused`);
console.log(`~${Math.round(tokens / Math.max(1, ok.length))} input tokens a brief`);

/* ⚠️ THE MOST USEFUL OUTPUT IN THE FILE. Ranked by how many DIFFERENT briefs asked for it, not by
   raw count: a part five briefs want is a part to model next; a part one brief wants five times is
   one baker's cake. This is the commissioning queue, and it is worth more in year one than any
   single idea the thing produces. */
const queue = [...wantedTally.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\nwanted and not in the catalogue, by how many briefs asked (${queue.length})`);
for (const [what, n] of queue.slice(0, 25)) console.log(`   ${String(n).padStart(2)}  ${what}`);

const empty = ok.filter(r => r.placed === 0);
if (empty.length) {
  console.log(`\n⚠ ${empty.length} brief(s) placed NOTHING — the catalogue has no answer for these at all:`);
  for (const r of empty) console.log(`   ${r.brief}`);
}
if (outDir) console.log(`\n✓ ${ok.length} bundle(s) → ${outDir}`);
