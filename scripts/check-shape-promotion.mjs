// ── A promoted template must bring its shape with it ────────────────────────────────────────────
// The failure this guards against is SILENT and produces a WRONG CAKE, not an error: a tier names
// its footprint by KEY, and core's `cakeShapeDef` deliberately falls back to ROUND for a key it does
// not know ("a design whose shape row was deactivated must still show a cake"). So a template built
// on a custom shape, promoted into an environment that has never heard of that key, renders as a
// plain round cake — nothing thrown, nothing logged, and it looks like a cake.
//
// ⚠️ AND THE LIVE DATA CANNOT TEST THIS. All eight global templates on dev are round, so the column
// and the tiers always agree and the tier path is never exercised. A check that only ran against
// real rows would pass while covering none of it — the same "vacuous runtime check" that let the
// template bundle ship without categories.
//
// Run via `npm run check:shape-promotion` (in `npm run check`).

process.env.SUPABASE_URL         ||= 'http://stub';
process.env.SUPABASE_SERVICE_KEY ||= 'stub';
process.env.OPENAI_API_KEY       ||= 'stub';
process.env.REMOVE_BG_API_KEY    ||= 'stub';
process.env.REDIS_URL            ||= 'redis://stub';
process.env.R2_ENDPOINT          ||= 'http://stub';
process.env.R2_ACCESS_KEY_ID     ||= 'stub';
process.env.R2_SECRET_ACCESS_KEY ||= 'stub';
process.env.R2_BUCKET            ||= 'stub';
process.env.R2_PUBLIC_URL        ||= 'http://stub';

const { shapeKeysReferencedBy } = await import('../src/lib/promotionBundle.js');

let failed = 0;
const ok  = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };
const has = (set, want, m) => {
  const got = [...set].sort();
  JSON.stringify(got) === JSON.stringify([...want].sort())
    ? ok(m)
    : bad(`${m}\n      expected ${JSON.stringify([...want].sort())}\n      got      ${JSON.stringify(got)}`);
};

// ── The column ──────────────────────────────────────────────────────────────────────────────────
has(shapeKeysReferencedBy([{ shape: 'tall_round', design: null }]), ['tall_round'],
    'a template’s own shape column is collected');

// ── The tiers ───────────────────────────────────────────────────────────────────────────────────
has(shapeKeysReferencedBy([{ shape: null, design: { tiers: [{ shape: 'heart' }] } }]), ['heart'],
    'a tier inside the design is collected even with no column');

// ── ⚠️ BOTH, because they disagree ──────────────────────────────────────────────────────────────
// A heart on a round base: the column says round and the design says otherwise. Reading only the
// column strands the heart and the promoted template grows a second round tier.
has(shapeKeysReferencedBy([{ shape: 'round', design: { tiers: [{ shape: 'round' }, { shape: 'heart' }] } }]),
    ['round', 'heart'],
    '⚠️ a heart on a round base carries BOTH — the column alone would strand the heart');

// ── Several templates, one set ──────────────────────────────────────────────────────────────────
has(shapeKeysReferencedBy([
      { shape: 'round',      design: { tiers: [{ shape: 'round' }] } },
      { shape: 'tall_round', design: { tiers: [{ shape: 'tall_round' }] } },
      { shape: 'round',      design: { tiers: [{ shape: 'heart' }] } },
    ]),
    ['round', 'tall_round', 'heart'],
    'keys are deduped across templates rather than fetched once each');

// ── Thin and broken rows ────────────────────────────────────────────────────────────────────────
// Every one of these is reachable: a template with no design yet, a design written before tiers
// carried a shape, a null in the array.
has(shapeKeysReferencedBy([]), [], 'no templates, no keys');
has(shapeKeysReferencedBy(), [], 'called with nothing at all does not throw');
has(shapeKeysReferencedBy([{ shape: null, design: null }]), [], 'a template with neither is not a key');
has(shapeKeysReferencedBy([{ shape: 'round', design: {} }]), ['round'], 'a design with no tiers still yields the column');
has(shapeKeysReferencedBy([{ shape: 'round', design: { tiers: [null, { shape: null }, { shape: 'heart' }] } }]),
    ['round', 'heart'], 'null tiers and tiers with no shape are skipped, not collected as keys');

if (failed) {
  console.error(`\n✗ check:shape-promotion — ${failed} failed\n`);
  process.exit(1);
}
console.log('✓ check:shape-promotion — a promoted template carries every shape its column AND its tiers name');
