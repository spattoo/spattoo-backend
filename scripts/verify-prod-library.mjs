#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// verify-prod-library.mjs — did migrate-master-to-prod actually work?
//
// The migration prints row counts and exits 0. That answers "did the writes
// return without error", which is not the same question. Three ways it can
// succeed and still be wrong, none of which the migration itself can see:
//
//   1. Rows land, objects do not. Every element renders as a broken image. The
//      row count is perfect.
//   2. Objects land, the CDN does not serve them. The bucket is right and the
//      custom domain is not attached, or its cache rules reject the request.
//      Indistinguishable from (1) in a browser.
//   3. Rows keep DEV's asset host. This is the invisible one: prod renders
//      PERFECTLY, because dev's bucket is public and happily serves it. Nothing
//      announces it. The day dev's bucket is locked down or rotated, every
//      global template breaks at once, in production, for a change made in
//      another environment.
//
// (3) is why this script exists. You cannot catch it by looking.
//
// READ-ONLY. Safe to run any number of times, before or after the migration.
//
// Usage:
//   PROD_SUPABASE_URL=… PROD_SUPABASE_SERVICE_KEY=… \
//   PROD_R2_PUBLIC_URL=https://www.spattoocdn.com \
//     node scripts/verify-prod-library.mjs
//
//   --skip-http   row parity + host scan only (no network fetch of 300 objects)
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { assetKeysIn } from '../src/lib/assetKeys.js';
import { PLAN } from './migrate-master-to-prod.mjs';

const SKIP_HTTP = process.argv.includes('--skip-http');

const DEV = {
  url: process.env.DEV_SUPABASE_URL         || process.env.SUPABASE_URL,
  key: process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY,
  base: process.env.DEV_R2_PUBLIC_URL || process.env.R2_PUBLIC_URL,
};
const PROD = {
  url:  process.env.PROD_SUPABASE_URL,
  key:  process.env.PROD_SUPABASE_SERVICE_KEY,
  base: process.env.PROD_R2_PUBLIC_URL,
};

let failures = 0;
const fail = (msg) => { failures++; console.error(`  ✖ ${msg}`); };

const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function main() {
  for (const [k, v] of Object.entries({
    PROD_SUPABASE_URL: PROD.url, PROD_SUPABASE_SERVICE_KEY: PROD.key, PROD_R2_PUBLIC_URL: PROD.base,
    'SUPABASE_URL (dev)': DEV.url, 'R2_PUBLIC_URL (dev)': DEV.base,
  })) if (!v) { console.error(`✖ Missing ${k}`); process.exit(1); }

  console.log(`\n▶ verify-prod-library   (read-only)`);
  console.log(`  dev  ${DEV.url}  assets ${DEV.base}`);
  console.log(`  prod ${PROD.url}  assets ${PROD.base}\n`);

  const devSb  = createClient(DEV.url, DEV.key);
  const prodSb = createClient(PROD.url, PROD.key);

  // ── 1. Row parity, per table ────────────────────────────────────────────────
  // Against what the migration should have carried, which is NOT dev's raw count. Two reductions
  // apply, and both are legitimate:
  //
  //   filter   — global rows only (cake_templates: baker_id IS NULL)
  //   parents  — a join row whose parent was filtered out cannot travel. dev has 4 template_tags
  //              and ALL FOUR belong to baker templates, so the correct prod count is 0. A naive
  //              dev-vs-prod comparison would report that as a failure forever.
  //
  // Same PLAN, same declarations as the migration — so this cannot drift from what it does.
  console.log('── row parity (expected = global rows whose parents also migrated) ──');
  const devIds = new Map();
  for (const step of PLAN) {
    let dq = devSb.from(step.table).select('*');
    if (step.filter) dq = step.filter(dq);
    const { data: devRows, error: dErr } = await dq;
    if (dErr) { fail(`${step.table}: dev read — ${dErr.message}`); continue; }

    const expected = step.parents
      ? devRows.filter(r => Object.entries(step.parents).every(([col, parent]) => {
          const ids = devIds.get(parent);
          return r[col] == null || !ids || ids.has(r[col]);
        }))
      : devRows;
    if (expected.length && expected[0]?.id !== undefined) {
      devIds.set(step.table, new Set(expected.map(r => r.id)));
    }

    const { count: prodN, error } = await prodSb.from(step.table).select('*', { count: 'exact', head: true });
    if (error) { fail(`${step.table}: prod read — ${error.message}`); continue; }

    const ok = prodN >= expected.length;
    if (!ok) fail(`${step.table}: expected ≥${expected.length}, prod has ${prodN} — SHORT`);
    const note = expected.length !== devRows.length ? ` (${devRows.length - expected.length} not migratable)` : '';
    console.log(`  ${step.table.padEnd(22)} expected=${String(expected.length).padStart(3)}  prod=${String(prodN).padStart(3)}  ${ok ? '✔' : '✖'}${note}`);
  }

  // ── 2. No dev host anywhere in prod's rows ──────────────────────────────────
  // The failure that renders perfectly. Scanning the serialised row catches it wherever it hides —
  // a column, a nested jsonb value, a URL inside a template's design.
  console.log('\n── host check (the one that renders perfectly when wrong) ──');
  const devHost = new URL(DEV.base).host;
  let leaked = 0, leakedTables = new Set();
  const prodKeys = new Set();
  for (const step of PLAN) {
    const { data: rows, error } = await prodSb.from(step.table).select('*');
    if (error) { fail(`${step.table}: ${error.message}`); continue; }
    for (const r of rows) {
      if (JSON.stringify(r).includes(devHost)) { leaked++; leakedTables.add(step.table); }
      for (const k of assetKeysIn(r, new Set(), PROD.base)) prodKeys.add(k);
    }
  }
  if (leaked) fail(`${leaked} prod row(s) still reference the DEV asset host ${devHost} — in: ${[...leakedTables].join(', ')}`);
  else console.log(`  ✔ no row references ${devHost}`);
  console.log(`  ${prodKeys.size} distinct asset keys referenced by prod's rows`);

  // ── 3. Every referenced object is actually served ───────────────────────────
  // Through the PUBLIC base, not the bucket API — that is what a browser does, so it tests the
  // object, the custom domain and the cache rules in one request. A bucket full of objects nobody
  // can fetch is the same outage as an empty one.
  if (!SKIP_HTTP) {
    console.log(`\n── serving check (HEAD ${PROD.base}/<key>) ──`);
    const base = PROD.base.replace(/\/+$/, '');
    const bad = [];
    let done = 0;
    for (const batch of chunk([...prodKeys], 16)) {
      await Promise.all(batch.map(async (k) => {
        try {
          const res = await fetch(`${base}/${k}`, { method: 'HEAD' });
          if (!res.ok) bad.push(`${res.status} ${k}`);
        } catch (e) { bad.push(`ERR ${k} — ${e.message}`); }
      }));
      done += batch.length;
      process.stdout.write(`\r  ${done}/${prodKeys.size} checked…`);
    }
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
    if (bad.length) {
      fail(`${bad.length} of ${prodKeys.size} objects are not served:`);
      for (const b of bad.slice(0, 15)) console.error(`      ${b}`);
      if (bad.length > 15) console.error(`      … and ${bad.length - 15} more`);
    } else {
      console.log(`  ✔ all ${prodKeys.size} objects return 200 from ${base}`);
    }
  }

  console.log('');
  if (failures) {
    console.error(`✖ verify-prod-library — ${failures} check(s) failed\n`);
    process.exit(1);
  }
  console.log(`✓ verify-prod-library — rows present, no dev host, every asset served\n`);
}

main().catch(e => { console.error('FATAL:', e?.message || e); process.exit(1); });
