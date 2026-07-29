#!/usr/bin/env node
// ── Can a model read a cake well enough for X-Ray to be worth showing? ────────
// The go/no-go check from AI_CREDITS_PLAN.md §4.3.1, run against our own data instead of by eye.
//
// WHY THIS IS CHEAP TO DO WELL: every DESIGNED order already carries both a thumbnail and the
// design_snapshot that produced it. That is a perfectly-labelled evaluation set, sitting in the
// orders table, costing nothing to collect. We hand the model the thumbnail, run the real
// pipeline over its answer (analyzeCake → matchAnalysis → buildDesignEstimate), and diff the
// result against the snapshot we already know is correct.
//
// ⚠️ READ THE SCORES AS OPTIMISTIC. Thumbnails are OUR renders: clean studio lighting, one known
// camera, no background. A customer's phone photo of a cake on a kitchen counter is harder in
// every way. Use this to decide whether the feature is viable at all and to RANK models — never
// to predict the accuracy a baker will actually see. Once a model wins here, re-score it on real
// reference photos before trusting the number.
//
// COSTS REAL MONEY (a few rupees) and sends order thumbnails to OpenAI. It is a script you run
// deliberately, which is why it is not wired into `npm run check`.
//
// Usage:
//   OPENAI_API_KEY=… SUPABASE_URL=… SUPABASE_SERVICE_KEY=… node scripts/smoke-design-estimate.mjs [count]

import 'dotenv/config';
import { supabase } from '../src/services/supabase.js';
import { analyzeCake } from '../src/services/openai.js';
import { matchAnalysis } from '../src/services/inspirationMatch.js';
import { buildDesignEstimate } from '../src/services/designEstimate.js';

const COUNT = Number(process.argv[2] || 5);

// ── Scoring ──────────────────────────────────────────────────────────────────
// Only the fields that decide whether a build guide is RIGHT. Tier count and shape drive
// computeTinPlan, so getting them wrong means the wrong tin — a re-bake, not a blemish. Colour
// drives gelRecipeFor. A missed piping element id silently drops its craft guide from the sheet.

const hex2rgb = (h) => {
  const m = String(h ?? '').replace('#', '').match(/^([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Plain RGB distance, normalised 0..1. Not CIEDE2000 — we are ranking models, not proofing ink,
// and a rough number that everyone can reason about beats a precise one nobody checks.
function colourDelta(a, b) {
  const ra = hex2rgb(a), rb = hex2rgb(b);
  if (!ra || !rb) return null;
  return Math.sqrt((ra[0] - rb[0]) ** 2 + (ra[1] - rb[1]) ** 2 + (ra[2] - rb[2]) ** 2) / 441;
}

const pipingIds = (design) =>
  (design?.tiers ?? []).flatMap(t => [...(t.topPipings ?? []), ...(t.bottomPipings ?? [])])
    .map(p => p?.id).filter(Boolean);

function score(truth, guess) {
  const tTiers = truth?.tiers ?? [], gTiers = guess?.tiers ?? [];

  const deltas = [];
  for (let i = 0; i < Math.min(tTiers.length, gTiers.length); i++) {
    const d = colourDelta(tTiers[i]?.color, gTiers[i]?.color);
    if (d != null) deltas.push(d);
  }

  const truthIds = new Set(pipingIds(truth));
  const guessIds = new Set(pipingIds(guess));
  const hits = [...guessIds].filter(id => truthIds.has(id)).length;

  // What the baker would have to notice is missing: real placeables vs estimated ones.
  const truthPlaceables = (truth?.stickers ?? []).length + (truth?.texts ?? []).length;
  const guessPlaceables = (guess?.stickers ?? []).length + (guess?.texts ?? []).length;

  return {
    tierCountOk: tTiers.length === gTiers.length,
    tiersTruth:  tTiers.length,
    tiersGuess:  gTiers.length,
    shapeOk:     (tTiers[0]?.shape === 'rect' || tTiers[0]?.shape === 'square')
                   === (gTiers[0]?.shape === 'square'),
    colourAvg:   deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : null,
    pipingTruth: truthIds.size,
    pipingHits:  hits,
    placeablesTruth: truthPlaceables,
    placeablesGuess: guessPlaceables,
  };
}

const pct = (n) => (n == null ? '  —  ' : `${String(Math.round(n * 100)).padStart(3)}%`);

// ── Run ──────────────────────────────────────────────────────────────────────
const { data: orders, error } = await supabase
  .from('orders')
  .select('id, design_snapshot, design_thumbnail_url')
  .not('design_snapshot', 'is', null)
  .not('design_thumbnail_url', 'is', null)
  .order('created_at', { ascending: false })
  .limit(COUNT);

if (error) { console.error('Could not read orders:', error.message); process.exit(1); }
if (!orders?.length) {
  console.error('No designed orders with a thumbnail — nothing to score against.');
  process.exit(1);
}

const base = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
const toUrl = (k) => (!k ? null : /^https?:\/\//i.test(k) ? k : `${base}/${k}`);

console.log(`\nScoring ${orders.length} designed order(s). Thumbnails are clean renders — treat every number as optimistic.\n`);
console.log('order     tiers      shape   colourΔ  piping ids   placeables');
console.log('─'.repeat(64));

const rows = [];
for (const o of orders) {
  const url = toUrl(o.design_thumbnail_url);
  if (!url) { console.log(`${o.id.slice(0, 8)}  (no resolvable thumbnail url — skipped)`); continue; }
  try {
    const analysis = await analyzeCake(url);
    const matched  = await matchAnalysis(analysis);
    const { snapshot } = buildDesignEstimate(analysis, matched);
    const s = score(o.design_snapshot, snapshot);
    rows.push(s);
    console.log(
      `${o.id.slice(0, 8)}  ${s.tierCountOk ? '✓' : '✗'} ${s.tiersGuess}/${s.tiersTruth}      `
      + `${s.shapeOk ? '✓' : '✗'}      ${pct(s.colourAvg)}   `
      + `${String(s.pipingHits).padStart(2)}/${String(s.pipingTruth).padEnd(2)}       `
      + `${String(s.placeablesGuess).padStart(2)}/${s.placeablesTruth}`,
    );
  } catch (e) {
    console.log(`${o.id.slice(0, 8)}  FAILED — ${e.message.slice(0, 60)}`);
  }
}

if (!rows.length) process.exit(1);

const avg = (f) => { const v = rows.map(f).filter(n => n != null); return v.length ? v.reduce((s, n) => s + n, 0) / v.length : null; };
const tierOk   = rows.filter(r => r.tierCountOk).length;
const shapeOk  = rows.filter(r => r.shapeOk).length;
const pipeTrue = rows.reduce((s, r) => s + r.pipingTruth, 0);
const pipeHit  = rows.reduce((s, r) => s + r.pipingHits, 0);

console.log('─'.repeat(64));
console.log(`tier count correct : ${tierOk}/${rows.length}`);
console.log(`shape correct      : ${shapeOk}/${rows.length}`);
console.log(`mean colour delta  : ${pct(avg(r => r.colourAvg))}   (lower is better)`);
console.log(`piping id recall   : ${pipeHit}/${pipeTrue}`);

// The call this script exists to make. Tier count is the gate: everything downstream of a wrong
// tier count is wrong too, and it is the one thing a baker cannot spot from the sheet alone.
console.log('\nVERDICT');
if (tierOk / rows.length >= 0.8) {
  console.log('  Tier count holds on clean renders → the feature is worth pursuing.');
  console.log('  Next: re-score on ~20 REAL reference photos before trusting any of this with a baker.');
} else {
  console.log('  Tier count is unreliable even on clean renders — a customer photo will be worse.');
  console.log('  Do NOT ship photo→X-Ray on this prompt/model. Fix the prompt or change the model first.');
}
console.log();
