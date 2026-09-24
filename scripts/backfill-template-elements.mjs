#!/usr/bin/env node
/**
 * Rebuild `template_elements` from every template's design.
 *
 * The table is DERIVED — each row is the design walked for uuids and intersected with
 * cake_elements — so this can be run at any time, as often as you like. It is how the table is
 * first populated (migration 110 creates it empty) and how drift is repaired if a sync ever failed
 * quietly, which syncTemplateElements is deliberately allowed to do rather than fail a save.
 *
 * Usage:
 *   SUPABASE_URL=...  SUPABASE_SERVICE_KEY=... \
 *   node scripts/backfill-template-elements.mjs
 *
 * Options (env vars):
 *   DRY_RUN=1    — report what would be written, change nothing
 *   ONLY=<uuid>  — a single template, for checking one before doing all of them
 */

import { createClient } from '@supabase/supabase-js';
import { uuidsIn } from '../src/lib/assetKeys.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN      = process.env.DRY_RUN === '1';
const ONLY         = process.env.ONLY || null;

for (const v of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) {
  if (!process.env[v]) { console.error(`Missing ${v}`); process.exit(1); }
}

/* ⚠️ `uuidsIn` is IMPORTED, not reimplemented. It is the same walk elementIdsReferencedBy uses at
   runtime, and a second copy here would be a second answer to "what does this design reference" —
   the backfill and the live path drifting apart is the one failure that would make this table look
   right and be wrong. assetKeys.js imports only a constant list, so it is safe in a standalone
   script; the supabase CLIENT is this script's own, because the service module reads config the
   server's way. */
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function allElementIds() {
  // One read, then set-membership in memory: the alternative is a query per template, and the
  // element catalogue is small next to the template list it is checked against.
  const ids = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('cake_elements').select('id').range(from, from + PAGE - 1);
    if (error) throw error;
    for (const r of data ?? []) ids.add(r.id);
    if (!data || data.length < PAGE) break;
  }
  return ids;
}

async function allTemplates() {
  const rows = [];
  const PAGE = 200;   // designs are large; a smaller page keeps the response sane
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from('cake_templates').select('id, name, design').range(from, from + PAGE - 1);
    if (ONLY) q = q.eq('id', ONLY);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data ?? []));
    if (ONLY || !data || data.length < PAGE) break;
  }
  return rows;
}

const elementIds = await allElementIds();
const templates  = await allTemplates();
console.log(`${templates.length} template(s), ${elementIds.size} element(s) in the catalogue`);
if (DRY_RUN) console.log('DRY_RUN — nothing will be written\n');

let written = 0, empty = 0, failed = 0;
for (const t of templates) {
  // Every uuid in the design, kept only if it is an element id. Same rule as the runtime walk: a
  // uuid that is not an element simply does not come back, so a false positive is impossible.
  const referenced = [...uuidsIn(t.design ?? {})].filter(id => elementIds.has(id));

  if (DRY_RUN) {
    console.log(`  ${referenced.length.toString().padStart(3)}  ${t.name}`);
    if (!referenced.length) empty++;
    continue;
  }

  try {
    const { error: delErr } = await supabase
      .from('template_elements').delete().eq('template_id', t.id);
    if (delErr) throw delErr;

    if (referenced.length) {
      const { error: insErr } = await supabase
        .from('template_elements')
        .insert(referenced.map(element_id => ({ template_id: t.id, element_id })));
      if (insErr) throw insErr;
      written += referenced.length;
    } else {
      empty++;
    }
  } catch (err) {
    failed++;
    console.error(`  ✗ ${t.name}: ${err?.message ?? err}`);
  }
}

console.log(`\n${DRY_RUN ? 'would write' : 'wrote'} ${written} row(s)`);
console.log(`${empty} template(s) reference no catalogue element`);
if (failed) console.log(`⚠️  ${failed} template(s) failed — re-run to retry, it is idempotent`);
