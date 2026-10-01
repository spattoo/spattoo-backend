/* Flip the stored lean so cakes saved before the tilt-sign change still look the way they were left.
 *
 * ── What changed, and why anything has to move ─────────────────────────────────────────────────
 *
 * The designer's up/down arrows wrote a `tiltAngle` that the renderer then NEGATED for a piece
 * standing on a surface (`tiltX = -tiltAngle`), while a verge or inserted piece used the value as
 * written. One button therefore meant opposite things on different poses, and on the common one it
 * meant the opposite of its own arrow: UP laid a butterfly flat and DOWN stood it up. Measured on a
 * wired butterfly, ↑ held to the limit left 64 lit pixels against 682 at centre.
 *
 * spattoo-core now uses one sign for every pose — the un-negated one verge and insert already had.
 * So a STAND-posed sticker saved before that change leans the other way from today. Negating its
 * stored `tiltAngle` restores exactly the pose the baker left, which is the whole point: this script
 * exists so that NOTHING changes appearance.
 *
 * ⚠️ VERGE AND INSERT MUST NOT BE TOUCHED. They were already on the new sign and did not move. A
 * blanket negation would break the poses that were correct — so the rule is applied per sticker,
 * from the same two signals the renderer branches on (`mode === 'verge'`, and `insertDepth != null`,
 * where 0 is a real value meaning flush and NOT "absent").
 *
 * ⚠️ NEGATION IS NOT IDEMPOTENT — running it twice undoes it. That is the one way this script can do
 * harm, so every design it rewrites is stamped `__tiltSign: 2` and any design already carrying that
 * stamp is skipped. Re-running is therefore safe, which matters because a half-finished run is the
 * normal way a migration ends.
 *
 * ⚠️ ORDERS ARE MIGRATED TOO, NOT ONLY TEMPLATES. An order is a record of a cake somebody approved;
 * if its snapshot is left alone it will RENDER differently from what was agreed. Preserving the
 * picture is the reason to touch it at all.
 *
 *   node scripts/migrate-tilt-sign.mjs            # dry run — prints every row it would change
 *   node scripts/migrate-tilt-sign.mjs --apply    # write
 */
import 'dotenv/config';
import { supabase } from '../src/services/supabase.js';

const APPLY = process.argv.includes('--apply');
const STAMP = 2;   // bump if the sign is ever revisited again

/* Every place a design blob is stored. `design_sessions` carries in-flight work a customer may come
   back to, so it is on the list for the same reason orders are. */
const TABLES = [
  { table: 'cake_templates',        column: 'design',          label: 'name' },
  { table: 'orders',                column: 'design_snapshot', label: 'id'   },
  { table: 'order_design_versions', column: 'design_snapshot', label: 'id'   },
  { table: 'design_sessions',       column: 'design_snapshot', label: 'id'   },
];

/* The renderer's own test, restated once. A sticker leans through the stand path unless it is a
   verge piece or an inserted one. */
const movedWithTheStand = (s) => !(s?.mode === 'verge' || s?.insertDepth != null);

function flip(design) {
  if (!design || typeof design !== 'object') return null;
  if (design.__tiltSign >= STAMP) return null;              // already done
  const stickers = Array.isArray(design.stickers) ? design.stickers : [];
  const touched = [];
  const next = stickers.map((s) => {
    const t = s?.tiltAngle;
    if (typeof t !== 'number' || t === 0 || !movedWithTheStand(s)) return s;
    touched.push(`${s.id ?? '?'} ${t.toFixed(3)} → ${(-t).toFixed(3)}`);
    return { ...s, tiltAngle: -t };
  });
  /* Stamped even when nothing needed flipping: the stamp records that this design has been SEEN at
     this sign, so a later pass does not have to reason about it again. */
  return { design: { ...design, stickers: next, __tiltSign: STAMP }, touched };
}

let rows = 0, changed = 0, leans = 0;

for (const { table, column, label } of TABLES) {
  const { data, error } = await supabase.from(table).select(`id, ${label}, ${column}`);
  if (error) { console.error(`! ${table}: ${error.message} — skipped`); continue; }

  for (const row of data ?? []) {
    rows++;
    const out = flip(row[column]);
    if (!out) continue;
    if (!out.touched.length) {
      /* Nothing to negate, but stamp it so the next run can skip it outright. */
      if (APPLY) await supabase.from(table).update({ [column]: out.design }).eq('id', row.id);
      continue;
    }
    changed++; leans += out.touched.length;
    console.log(`${table}  ${row[label] ?? row.id}`);
    for (const t of out.touched) console.log(`    ${t}`);
    if (APPLY) {
      const { error: uErr } = await supabase.from(table).update({ [column]: out.design }).eq('id', row.id);
      if (uErr) console.error(`    ! write failed: ${uErr.message}`);
    }
  }
}

console.log(`\n${rows} design(s) read · ${changed} with a stand lean · ${leans} sticker(s) flipped`);
console.log(APPLY ? 'written.' : 'DRY RUN — nothing written. Re-run with --apply.');
