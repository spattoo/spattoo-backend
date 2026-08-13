// Backfill placement_config for `topper` + `top_side_decors` elements so the designer can stop
// injecting config BY ELEMENT TYPE at load (spattoo-core 0.1.136 removed that type→config backfill —
// element type is a logical category now, behaviour is each element's own placement_config).
//
// Materialises exactly what the old runtime backfill used to inject, so NOTHING changes appearance:
//   topper           → single_per_slot:true, top_surface:'stand', side:'hug',
//                      rotation:[0,270,0]+unit 'deg' (default facing, only if no rotation), zones ['top_surface']
//   top_side_decors  → single_per_slot:true
// Idempotent + ROW-WINS: only fills keys the element doesn't already have; never overwrites. Safe to
// re-run. MUST run in each environment BEFORE its designer bundle reaches >= 0.1.136.
//
//   node scripts/backfill-topper-placement.mjs            # dry run (prints planned changes)
//   node scripts/backfill-topper-placement.mjs --apply    # write
import 'dotenv/config';
import { supabase } from '../src/services/supabase.js';

const APPLY = process.argv.includes('--apply');

const { data: types, error: tErr } = await supabase.from('element_types').select('id, slug');
if (tErr) { console.error('load types failed:', tErr.message); process.exit(1); }
const topperId  = types.find(t => t.slug === 'topper')?.id;
const topSideId = types.find(t => t.slug === 'top_side_decors')?.id;
const ids = [topperId, topSideId].filter(Boolean);
if (!ids.length) { console.log('no topper / top_side_decors types found — nothing to do'); process.exit(0); }

const { data: rows, error } = await supabase
  .from('cake_elements')
  .select('id, name, element_type_id, allowed_zones, placement_config')
  .in('element_type_id', ids);
if (error) { console.error('load elements failed:', error.message); process.exit(1); }

console.log(`${rows.length} element(s) of type topper / top_side_decors  (${APPLY ? 'APPLY' : 'DRY RUN'})\n`);

let changed = 0, failed = 0;
for (const r of rows) {
  const isTopper = r.element_type_id === topperId;
  const pc = { ...(r.placement_config ?? {}) };
  let zones = r.allowed_zones;
  const diffs = [];
  const setIfAbsent = (k, v) => { if (pc[k] === undefined) { pc[k] = v; diffs.push(`${k}=${JSON.stringify(v)}`); } };

  setIfAbsent('single_per_slot', true);                       // both types are "hero"
  if (isTopper) {
    setIfAbsent('top_surface', 'stand');
    setIfAbsent('side', 'hug');
    if (pc.rotation == null) { pc.rotation = [0, 270, 0]; pc.rotation_unit = 'deg'; diffs.push('rotation=[0,270,0] (deg, default facing)'); }
    if (!zones?.length) { zones = ['top_surface']; diffs.push("allowed_zones=['top_surface']"); }
  }

  if (!diffs.length) { console.log(`  = ${r.name} — already explicit, skip`); continue; }
  changed++;
  console.log(`  ${APPLY ? '✎' : '·'} ${r.name}  →  ${diffs.join(', ')}`);
  if (APPLY) {
    const patch = { placement_config: pc };
    if (zones !== r.allowed_zones) patch.allowed_zones = zones;
    const { error: uErr } = await supabase.from('cake_elements').update(patch).eq('id', r.id);
    if (uErr) { failed++; console.log(`      ✗ ${uErr.message}`); }
  }
}
console.log(`\n${changed} row(s) ${APPLY ? 'updated' : 'would change'}${failed ? `, ${failed} failed` : ''}${APPLY ? '' : ' — pass --apply to write'}`);
process.exit(failed ? 1 : 0);
