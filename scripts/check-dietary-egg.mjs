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

/* ── 4. the bakery's own standing fact ──────────────────────────────────────────────────────────
 *
 * A kitchen that does not offer `egg` makes every cake eggless, so since 2026-10-05 its orders
 * carry `eggless` whether or not anybody said so (migration 124). Three things can go wrong and
 * every one of them is silent:
 *
 *   1. IT IS STAMPED ON A BAKERY THAT OFFERS BOTH — which destroys a real question by answering it.
 *   2. IT IS WRITTEN AS THE CUSTOMER'S WORDS. `source` is provenance and nothing branches on it, so
 *      a wrong value is invisible until somebody is arguing about what was ordered.
 *   3. IT IS ADDED TWICE when the customer asked for eggless themselves — which the table's key
 *      refuses, turning an ordinary order into a 500.
 *
 * Pure: `bakeryPolicyIds` is exercised through its own vocabulary rather than the database by
 * handing it a fake requirement list, the same way the resolver checks above do.
 */
const { POLICY_SOURCE, policyKeysFor } = await import('../src/lib/dietaryRequirements.js');

const offeringBoth    = [{ key: EGG_KEY, offered: true  }, { key: EGGLESS_KEY, offered: true }];
const egglessKitchen  = [{ key: EGG_KEY, offered: false }, { key: EGGLESS_KEY, offered: true }];

const same = (got, want, label) => {
  const a = JSON.stringify([...got].sort()), b = JSON.stringify([...want].sort());
  if (a === b) return;
  failed++; console.error(`✗ ${label}  — got ${a}, wanted ${b}`);
};

same(policyKeysFor(egglessKitchen, []),            [EGGLESS_KEY], 'an eggless kitchen stamps eggless on an order nobody annotated');
same(policyKeysFor(offeringBoth, []),              [],            'a bakery offering both stamps NOTHING — the question is real');
same(policyKeysFor(egglessKitchen, [EGGLESS_KEY]), [],            'not stamped twice when the customer asked for it themselves');
same(policyKeysFor(egglessKitchen, ['vegan', EGGLESS_KEY]), [],   'nor alongside a diet that already spelled it out');
same(policyKeysFor(egglessKitchen, ['nut_free']),  [EGGLESS_KEY], 'still stamped beside an unrelated allergen');
same(policyKeysFor([], []),                        [],            'an empty vocabulary stamps nothing rather than throwing');

if (POLICY_SOURCE === 'customer' || POLICY_SOURCE === 'baker') {
  failed++;
  console.error(`✗ the stamp must not be filed as somebody's assertion — source is '${POLICY_SOURCE}'`);
}

/* ── 5. ⚠️ THE STAMP HAS TO BE REACHED ──────────────────────────────────────────────────────────
 *
 * Everything above tests the rule; this tests that the order path RUNS it. The fourth silent
 * failure, and the one that actually shipped: the create path guarded the call with
 * `if (Array.isArray(dietaryRequirementKeys))`, and the storefront omits that field entirely when
 * the customer ticked nothing (cakeDraft.js builds it conditionally). So the stamp was skipped on
 * precisely the order it exists for — a customer buying from a fully eggless kitchen, who was
 * never asked — while every test above stayed green, because none of them could see the call site.
 *
 * Source-read rather than behavioural: the alternative is a database. Comments are stripped first,
 * because the paragraph you are reading contains the string being searched for.
 */
{
  const src = await import('node:fs').then(fs => fs.readFileSync('src/routes/orders.js', 'utf8'));
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  code.includes('setOrderDietaryRequirements(order.id')
    ? ok('the create path calls setOrderDietaryRequirements')
    : bad('the create path no longer calls setOrderDietaryRequirements — no order can be stamped');

  /* Reads the statement rather than guessing the guard's shape. The first attempt at this check
     was `/if\s*\([^)]*dietaryRequirementKeys[^)]*\)/`, which cannot match
     `if (Array.isArray(dietaryRequirementKeys))` — the inner `)` ends `[^)]*` early — so it passed
     the exact bug it was written for when fed it deliberately. A gate nobody has fed the fault to
     is a gate nobody has tested. */
  const idx  = code.indexOf('setOrderDietaryRequirements(order.id');
  // slice(0, -1) drops the PARTIAL line the call itself sits on: without it `prev` is the
  // fragment `await ` and never the guard, which is how this check passed the bug twice.
  const prev = code.slice(0, idx).split('\n').slice(0, -1).filter(l => l.trim()).pop() ?? '';
  /^(if|}?\s*else|while|for)\b/.test(prev.trim()) || /&&\s*$|\?\s*$/.test(prev.trim())
    ? bad(`the create call is conditional — preceded by: ${prev.trim()}\n`
        + '      An order that carries no dietary field then skips the bakery stamp, which is every\n'
        + '      storefront order from an eggless-only kitchen. Call it unconditionally with `?? []`.')
    : ok('the create call is unconditional — an order with no dietary field still gets the stamp');
}

if (failed) {
  console.error(`\n✗ check:dietary-egg — ${failed} failed\n`);
  process.exit(1);
}
console.log('✓ check:dietary-egg — contradictions refused, every legitimate shape accepted, and the bakery stamp is reached and lands only where it is true');
