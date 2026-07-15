// One-time migration: give every cake_shapes row a self-contained `design`, and MOVE the sheet/square
// cakes out of cake_templates and into cake_shapes where they belong.
//
// Two jobs, both idempotent:
//
//   1. BACKFILL — build each existing shape's `design` from its legacy family/config/tiers columns
//      (the same mapping core's starterDesign() uses), embedding shapeFamily/shapeConfig on every tier
//      so the geometry is self-contained. Rows that already carry a real design (authored after the
//      migration) are skipped, so re-running never clobbers new work.
//
//   2. MOVE THE SHEETS — the 5 global sheet/square rows were seeded into cake_templates (see
//      seed_sheet_templates.js), but a blank rectangular STARTER is a shape, not a decorated template.
//      Copy each into cake_shapes (design = its template design + self-contained rect geometry), then
//      SOFT-deactivate the cake_templates copy (is_active=false — reversible, and existing orders keep
//      their own snapshots regardless). The "New cake" picker then offers Round/Rect + these sheets from
//      one table.
//
// Run AFTER cake_shapes_design.sql (adds the `design` column) and BEFORE cake_shapes_drop_legacy_cols.sql
// (drops family/config/tiers). Uses SUPABASE_SERVICE_KEY from .env.
//
//   node scripts/migrate_cake_shapes_to_design.js

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const CAKE_COLOR = '#f5b8c8';
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// A shape's stack entry ({width, depth, height}) → a self-contained design tier. Mirrors core's
// starterDesign(): a round tier is sized by RADIUS (diameter = width), every other footprint by
// width/depth; shapeFamily/shapeConfig carry the geometry so nothing is resolved from a lookup at render.
function designTier(key, family, config, sz) {
  const tier = {
    shape: key, shapeFamily: family, shapeConfig: config || {},
    color: CAKE_COLOR, topPipings: [], bottomPipings: [],
  };
  if (sz) {
    tier.height = sz.height;
    if (family === 'circle') tier.radius = sz.width / 2;
    else { tier.width = sz.width; tier.depth = sz.depth; }
  }
  return tier;
}

// Legacy family/config/tiers → a full design. An empty stack means "one tier at the designer's default
// size" (the pre-existing behaviour), so it becomes a single sizeless tier — toCanvasConfig fills the
// default, exactly as before.
function legacyDesign(key, family, config, tiers) {
  const stack = Array.isArray(tiers) ? tiers : [];
  const tierArr = stack.length
    ? stack.map(sz => designTier(key, family, config, sz))
    : [designTier(key, family, config, null)];
  return { tiers: tierArr, texts: [], ages: [], stickers: [], writing: null, piping: [] };
}

// A sheet TEMPLATE's design → a shape design: its single rect tier gains self-contained rounded_rect
// geometry ({square} when width == depth or the admin enum says so); decoration passes through.
function sheetDesign(templateDesign, shapeEnum) {
  const t0 = (templateDesign?.tiers || [])[0] || {};
  const width = t0.width, depth = t0.depth;
  const square = shapeEnum === 'square' || (width != null && depth != null && Math.abs(width - depth) < 1e-3);
  return {
    tiers: [{
      shape: 'rect', shapeFamily: 'rounded_rect', shapeConfig: square ? { square: true } : {},
      color: t0.color ?? CAKE_COLOR, width, depth, height: t0.height ?? 0.85,
      topPipings: t0.topPipings ?? (t0.topPiping ? [t0.topPiping] : []),
      bottomPipings: t0.bottomPipings ?? (t0.bottomPiping ? [t0.bottomPiping] : []),
    }],
    texts: templateDesign?.texts ?? [], ages: templateDesign?.ages ?? [],
    stickers: templateDesign?.stickers ?? [], writing: templateDesign?.writing ?? null,
    piping: templateDesign?.piping ?? [],
  };
}

async function backfillExistingShapes() {
  const { data: rows, error } = await supabase.from('cake_shapes').select('*');
  if (error) { console.error('read cake_shapes failed:', error.message); process.exit(1); }

  for (const row of rows ?? []) {
    // Skip rows that already carry a real (tiered) design — never overwrite post-migration authoring.
    if (row.design?.tiers?.length) { console.log(`  · ${row.key} already has a design — skipped`); continue; }
    const design = legacyDesign(row.key, row.family ?? 'circle', row.config ?? {}, row.tiers);
    const { error: upErr } = await supabase.from('cake_shapes').update({ design }).eq('id', row.id);
    if (upErr) { console.error(`  backfill ${row.key} failed:`, upErr.message); process.exit(1); }
    console.log(`  ↻ backfilled ${row.key} (${design.tiers.length} tier${design.tiers.length > 1 ? 's' : ''})`);
  }
}

const SHEET_NAMES = ['Quarter Sheet', 'Half Sheet', 'Full Sheet', 'Square (8")', 'Square (12")'];

async function moveSheetsIntoShapes() {
  const { data: templates, error } = await supabase
    .from('cake_templates')
    .select('id, name, shape, design, thumbnail_url, sort_order')
    .is('baker_id', null)
    .in('name', SHEET_NAMES);
  if (error) { console.error('read sheet templates failed:', error.message); process.exit(1); }
  if (!templates?.length) { console.log('  (no sheet templates found — nothing to move)'); return; }

  // Which shape keys already exist, so we update vs insert (idempotent).
  const { data: existingShapes } = await supabase.from('cake_shapes').select('id, key');
  const shapeIdByKey = new Map((existingShapes ?? []).map(r => [r.key, r.id]));

  for (const t of templates) {
    const key = slug(t.name);
    const row = {
      key, label: t.name,
      design: sheetDesign(t.design, t.shape),
      thumbnail_key: t.thumbnail_url ?? null,   // shapes store the R2 KEY (same value templates store)
      sort_order: 10 + (t.sort_order ?? 0),     // after the primary Round/Rect (sort 1/2)
      is_active: true,
    };
    if (shapeIdByKey.has(key)) {
      const { error: e } = await supabase.from('cake_shapes').update(row).eq('id', shapeIdByKey.get(key));
      if (e) { console.error(`  update shape ${key} failed:`, e.message); process.exit(1); }
      console.log(`  ↻ updated shape ${key}`);
    } else {
      const { error: e } = await supabase.from('cake_shapes').insert(row);
      if (e) { console.error(`  insert shape ${key} failed:`, e.message); process.exit(1); }
      console.log(`  + inserted shape ${key}`);
    }
  }

  // Soft-deactivate the template copies only after the shapes exist (reversible; orders are unaffected).
  const ids = templates.map(t => t.id);
  const { error: deErr } = await supabase.from('cake_templates').update({ is_active: false }).in('id', ids);
  if (deErr) { console.error('deactivate sheet templates failed:', deErr.message); process.exit(1); }
  console.log(`  ⏻ deactivated ${ids.length} sheet template${ids.length > 1 ? 's' : ''} in cake_templates`);
}

async function run() {
  console.log('1. Backfilling existing cake_shapes designs…');
  await backfillExistingShapes();
  console.log('2. Moving sheet/square cakes into cake_shapes…');
  await moveSheetsIntoShapes();
  console.log('Done.');
}

run();
