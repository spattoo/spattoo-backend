// ── The egg choice, and the two ways it can go wrong ────────────────────────────────────────────
// `egg` is the one row in dietary_requirements that RESTRICTS nothing — it is the customer
// choosing the ordinary cake, asked outright instead of inferred from their not mentioning it.
// See migrations/078_egg_choice.sql. Both failures below are SILENT in production:
//
//   1. A CONTRADICTION IS STORED. "Vegan, with egg" reads as an ordinary order all the way to
//      the bench. Nothing throws, the sheet prints, and the first person to notice is holding
//      a cake somebody will refuse.
//
//   2. ⚠️ PRESENCE IS ENFORCED HERE BY MISTAKE. Requiring an egg answer on the order path would
//      refuse REAL ORDERS: a fully-eggless bakery is TOLD to the customer as a fact and records
//      nothing, so its orders legitimately carry no egg key. A check that demanded one would
//      turn the commonest kind of bakery in this market into a 400 — and the failure arrives
//      as "could not place order" with no way for anyone to see why.
//
// Run via `npm run check:dietary-egg` (in `npm run check`).

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

const { validateDietaryCoherence, EGG_KEY, EGGLESS_KEY, IMPLIES_EGGLESS } =
  await import('../src/lib/dietaryRequirements.js');

let failed = 0;
const ok  = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };
const refuses = (keys, m) =>
  (validateDietaryCoherence(keys) ? ok(m) : bad(`${m}\n      accepted ${JSON.stringify(keys)}`));
const accepts = (keys, m) => {
  const err = validateDietaryCoherence(keys);
  err ? bad(`${m}\n      refused ${JSON.stringify(keys)} with: ${err}`) : ok(m);
};

// ── 1. the contradictions ───────────────────────────────────────────────────────────────────────
refuses([EGG_KEY, EGGLESS_KEY], 'with egg AND eggless is refused — the two cannot both be true');
for (const diet of IMPLIES_EGGLESS) {
  refuses([diet, EGG_KEY], `“${diet} + with egg” is refused — that diet contains the eggless rule`);
}
refuses(['vegan', 'nut_free', EGG_KEY], 'the clash is caught with an unrelated allergen alongside');

// The message has to name the way out. A 400 that says only "invalid" leaves a customer
// re-reading a form where every chip they can see looks fine.
{
  const msg = validateDietaryCoherence(['vegan', EGG_KEY]) ?? '';
  msg.includes('vegan') && /remove/i.test(msg)
    ? ok('the refusal names the diet and says which chip to drop')
    : bad(`the refusal is not actionable: ${JSON.stringify(msg)}`);
}

// ── 2. ⚠️ everything legitimate still passes ────────────────────────────────────────────────────
// Each of these is a real order shape. A check that tightened into "an egg answer is required"
// would break the first three, and every one of them is somebody's whole business.
accepts([],                'no answer at all — the bakery offers one side only, so nothing was asked');
accepts([EGGLESS_KEY],     'a fully-eggless bakery, or a customer who asked for it');
accepts([EGG_KEY],         'the ordinary cake, now stated rather than inferred from silence');
accepts(['vegan'],         'vegan alone — eggless is implied and need not be spelled out');
accepts(['vegan', EGGLESS_KEY], 'vegan WITH eggless spelled out, which is what the form submits');
accepts(['jain', EGGLESS_KEY],  'Jain with eggless spelled out');
accepts(['nut_free', EGG_KEY],  'an allergen alongside the egg choice — unrelated, both stand');
accepts(['eggless', 'nut_free', 'gluten_free'], 'several restrictions at once');

// ── 3. the shapes that must not throw ───────────────────────────────────────────────────────────
// This runs inside validateDietaryKeys on every write path, including enquiries that carry no
// dietary field at all. Throwing here would 500 an order rather than reject it.
accepts(null,      'null does not throw — an enquiry carries no dietary field');
accepts(undefined, 'undefined does not throw');
accepts('eggless', 'a non-array is left to validateDietaryKeys to reject, not crashed on here');

if (failed) {
  console.error(`\n✗ check:dietary-egg — ${failed} failed\n`);
  process.exit(1);
}
console.log('✓ check:dietary-egg — contradictions refused, and every legitimate order shape still accepted');
