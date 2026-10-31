#!/usr/bin/env node
/* ── The composer's guardrails hold, without a network ───────────────────────────────────────────
 *
 * ⚠️ EVERY RULE IN THE PROMPT IS A REQUEST; THESE ARE THE ENFORCEMENT. A model that ignores "only
 * choose from the list" does not error — it returns a confident, well-shaped cake made of parts
 * that do not exist, and the failure shows up as an empty design nobody can explain. So the
 * mapping half is pure and this holds it to its properties, with no OpenAI call and no database.
 *
 * ⚠️ AND IT IS PURE SO IT CAN RUN AT ALL. `ideaCompose.js` imports `config.js`, which refuses to
 * load without every runtime secret including a Redis URL — the same reason `storyRank.js` is
 * separate from `storyMatch.js` and `inspirationMaps.js` from `inspirationMatch.js`.
 *
 * Run by `npm run check` with the other gates.
 */

import {
  elementLines, composePrompt, parseJson, specFromModel, seatableZones, seatZone,
  ZONES, MAX_COUNT, MAX_KINDS,
  placePrompt, groupFromModel, ARRANGEMENTS,
} from '../src/services/ideaComposeMap.js';

let failed = 0;
const ok = (cond, what) => { if (!cond) { failed++; console.error(`  ✗ ${what}`); } };
/* ⚠️ EVERY READ IS OPTIONAL, AND THAT IS NOT TIDINESS. Proving this gate can fail (by disabling
   the zone guard) made it CRASH on the next line rather than report — so the one broken guardrail
   hid every assertion after it, which is the opposite of what a gate is for. */

/* A stand-in shortlist. The zones differ per row on purpose — that is the thing being enforced. */
const ROWS = [
  { id: 'uuid-bansuri', name: 'Ornate Peacock Feather Bansuri', description: 'a gold flute',
    allowed_zones: ['top_surface', 'side'], element_types: { name: 'topper' } },
  { id: 'uuid-feather', name: 'Sculpted Emerald Peacock Feather', description: 'a green feather',
    allowed_zones: ['side'], element_types: { name: 'sticker' } },
  { id: 'uuid-matki', name: 'Terracotta Pot Overflowing with Butter', description: 'a butter pot',
    allowed_zones: ['top_surface', 'board'], element_types: { name: 'topper' } },
];

const sane = {
  cake: { shape: 'round', tiers: [{ color: '#2E6FD9' }] },
  message: { text: 'Happy 5th Birthday', look: 'fondant', surface: 'top', color: '#FFD233' },
  age: { number: 5 },
  elements: [{ i: 0, zone: 'top_surface', count: 1, prominence: 'hero' }],
  palette: ['#2E6FD9'],
  wanted: ['a cow'],
  why: 'the flute is the look',
};

// ── What the model is shown ─────────────────────────────────────────────────
{
  const lines = elementLines(ROWS).split('\n');
  ok(lines.length === 3, 'one line per part');
  ok(lines[0].startsWith('0|'), 'indexed from zero');
  /* ⚠️ A UUID IS ~16 TOKENS. At 200 parts that is 3,200 tokens of identifier before a single
     description — and a string the model can typo into something that matches nothing. */
  ok(!elementLines(ROWS).includes('uuid-'), 'ids are never shown to the model');
  ok(lines[1].includes('side') && !lines[1].includes('board'),
     "each line carries that part's OWN zones, so the model need not guess");

  const prompt = composePrompt({ brief: { subject: 'krishna', ages: [5], gender: 'boys' }, lines: elementLines(ROWS) });
  ok(prompt.includes('krishna') && prompt.includes('age 5') && prompt.includes('boys'),
     'the brief reaches the prompt');
  ok(prompt.includes('Never invent a part'), 'the parts list is stated as a constraint');
  ok(prompt.includes('"wanted"'), 'and a place to put what the catalogue lacks');
}

// ── Parsing ─────────────────────────────────────────────────────────────────
{
  ok(parseJson('```json\n{"a":1}\n```').value.a === 1, 'a code fence it was told not to use is stripped');
  ok(parseJson('not json').ok === false, 'prose is a reported failure, not a throw');
}

// ── The guardrails ──────────────────────────────────────────────────────────
{
  const { spec, rejected } = specFromModel(sane, ROWS, { brief: { subject: 'krishna' } });
  ok(spec.elements.length === 1 && spec.elements[0]?.elementId === 'uuid-bansuri',
     'an index maps back to the real id');
  ok(rejected.length === 0, 'a sane answer is not second-guessed');
  ok(spec.version === 1, 'the spec says which version it is');
  ok(spec.message?.text === 'Happy 5th Birthday' && spec.age?.number === 5,
     'the message and the age survive');
}
{
  /* The failure this whole file exists for: a confident, well-shaped cake made of nothing. */
  const { spec, rejected } = specFromModel({ ...sane, elements: [{ i: 99, zone: 'top_surface' }] }, ROWS);
  ok(spec.elements.length === 0, 'a hallucinated index places nothing');
  ok(rejected[0]?.why?.includes('no such index'), 'and says so, so the prompt can be fixed');
}
{
  /* ⚠️ THE MODEL PROPOSES, THE ROW DISPOSES. A side-only part on the board is a claim about
     geometry the model cannot see; `allowed_zones` already knows. */
  const { spec, rejected } = specFromModel({ ...sane, elements: [{ i: 1, zone: 'board' }] }, ROWS);
  ok(spec.elements.length === 0, 'a zone the part does not allow is refused');
  ok(rejected[0]?.why?.includes('side'), 'and the refusal names what it DOES allow');
}
{
  const { spec, rejected } = specFromModel({ ...sane, elements: [{ i: 0, zone: 'ceiling' }] }, ROWS);
  ok(spec.elements.length === 0 && /invented zone/.test(rejected[0]?.why ?? ''), 'an invented surface is refused');
}
{
  /* Asked for sprinkles a model will say 200, and every one is a real placement through the real
     add path. The cap makes a bad answer ugly rather than fatal. */
  const { spec } = specFromModel({ ...sane, elements: [{ i: 0, zone: 'side', count: 500 }] }, ROWS);
  ok(spec.elements[0]?.count === MAX_COUNT, `count is capped at ${MAX_COUNT}`);
  const zero = specFromModel({ ...sane, elements: [{ i: 0, zone: 'side', count: 0 }] }, ROWS);
  ok(zero.spec.elements[0]?.count === 1, 'and never falls below one');
}
{
  const many = Array.from({ length: 20 }, () => ({ i: 0, zone: 'top_surface' }));
  const { spec, rejected } = specFromModel({ ...sane, elements: many }, ROWS);
  ok(spec.elements.length === 1, 'the same part on the same zone is placed once, not twenty times');
  ok(rejected.some(r => r.why.includes('already placed')), 'and the repeats are reported');
}
{
  const kinds = [
    ...Array.from({ length: 9 }, (_, n) => ({ i: n % 3, zone: ['top_surface', 'side', 'board'][n % 3] })),
  ];
  const { spec } = specFromModel({ ...sane, elements: kinds }, ROWS);
  ok(spec.elements.length <= MAX_KINDS, `no more than ${MAX_KINDS} different parts`);
}
{
  const { spec } = specFromModel({ ...sane, elements: [{ i: 0, zone: 'side', prominence: 'enormous' }] }, ROWS);
  ok(spec.elements[0]?.prominence === 'feature', 'an invented prominence falls back rather than refusing the part');
}
{
  /* A model says "a cow" and "Cow figurine" in one breath; that is one missing element, and a
     commissioning queue that counts it twice ranks it wrong. */
  const { spec } = specFromModel({ ...sane, wanted: ['A Cow', 'a cow ', 'a swing', 7] }, ROWS);
  ok(spec.wanted.length === 2 && spec.wanted.includes('a cow'), 'wanted is trimmed, lowercased and de-duplicated');
}
{
  const { spec } = specFromModel({ elements: [] }, ROWS);
  ok(spec.cake.tiers.length === 1 && spec.message === null && spec.age === null,
     'an empty answer still yields a buildable one-tier spec rather than null');
}
{
  ok(ZONES.length === 4 && ZONES.includes('rim'), 'four seatable surfaces, not the six ZONES names');
}
/* ── The zones shown are the zones the SEAT honours ──────────────────────────
 * ⚠️ CAUGHT ON THE FIRST REAL RUN, not here. `placementSlots` collapses `middle_tier` into a SIDE
 * slot — there is no middle_tier seat — so showing a row's `allowed_zones` verbatim offered the
 * model a surface that does not exist, and the refusal then blamed it for taking the offer. The
 * model put a Lion on `middle_tier` because the parts list said it could. Same distinction the
 * placement chooser draws with `zonePoses`: the poses the seat honours, not the ones config names.
 */
{
  const LION = { id: 'uuid-lion', name: 'Lion', allowed_zones: ['middle_tier', 'top'] };
  ok(seatZone('middle_tier') === 'side', 'middle_tier IS a side seat');
  ok(seatableZones(LION).join(',') === 'side,top_surface', 'a row is shown only seatable zones');
  ok(!elementLines([LION]).includes('middle_tier'), 'so the model is never offered middle_tier');

  const { spec, rejected } = specFromModel({ ...sane, elements: [{ i: 0, zone: 'middle_tier' }] }, [LION]);
  ok(spec.elements[0]?.zone === 'side',
     'and a model echoing the row\'s own wording back is understood, not refused');
  ok(rejected.length === 0, 'no refusal for a zone we offered');
}
{
  const NONE = { id: 'x', name: 'Odd', allowed_zones: [] };
  ok(seatableZones(NONE).join(',') === 'top_surface', 'a row naming no zone still has somewhere to go');
}

/* ── Placing ONE thing, from one sentence ────────────────────────────────────
 * "add a coral on the board". The arrangement is the half the whole-cake composer was losing, so
 * these guard the narrow door where it can be judged on its own. Same rule as above: every line of
 * `placePrompt` is a request, every line here is enforced.
 */
{
  const CORALS = [
    { id: 'c1', name: 'Sea Coral',    allowed_zones: ['top_surface', 'board'], element_types: { name: 'sticker' } },
    { id: 'c2', name: 'Sea Coral',    allowed_zones: ['top_surface', 'middle_tier', 'board'], element_types: { name: 'sticker' } },
    { id: 'c3', name: 'Coral Branch', allowed_zones: ['side'], element_types: { name: 'sticker' } },
  ];
  const { group, rejected } = groupFromModel(
    { i: [0, 1, 2], zone: 'board', arrangement: 'ring', count: 6 }, CORALS);

  ok(group !== null, 'a group survives when the rows allow the zone');
  ok(group.elementIds.join(',') === 'c1,c2', 'rows that do not allow the zone are dropped, not placed');
  ok(rejected.some(r => r.name === 'Coral Branch'), 'and the drop is reported, never swallowed');
  ok(group.arrangement === 'ring' && group.count === 6, 'the arrangement and count come back intact');
}
{
  /* ⚠️ THE WHOLE POINT OF ASKING FOR SEVERAL INDICES. Four coral rows exist and two share a name
     character for character; a group that collapses to one row is six copies of one coral, which
     is the render Sandeep rejected. */
  const { group } = groupFromModel({ i: [0, 1], zone: 'top_surface', arrangement: 'ring', count: 1 },
    [{ id: 'a', name: 'A', allowed_zones: ['top_surface'] }, { id: 'b', name: 'B', allowed_zones: ['top_surface'] }]);
  ok(group.count >= 2, 'count is never below the number of rows chosen — a chosen row gets used');
}
{
  const ROW = [{ id: 'a', name: 'A', allowed_zones: ['top_surface'] }];
  ok(groupFromModel({ i: [0], zone: 'top_surface', arrangement: 'ring', count: 99 }, ROW).group.count === MAX_COUNT,
     `count is capped at ${MAX_COUNT}, the same ceiling the composer has`);
  ok(groupFromModel({ i: [0], zone: 'top_surface', arrangement: 'helix', count: 4 }, ROW).group.arrangement === 'cluster',
     'an invented arrangement falls back rather than reaching the designer');
  ok(groupFromModel({ i: [0], zone: 'top_surface', arrangement: 'single', count: 9 }, ROW).group.count === 1,
     '"single" means one, whatever count says');
  ok(groupFromModel({ i: [9], zone: 'top_surface' }, ROW).group === null,
     'a hallucinated index places nothing at all');
  ok(groupFromModel({ i: [0], zone: 'the moon' }, ROW).group === null,
     'an invented zone places nothing at all');
  ok(groupFromModel({ i: [0, 0], zone: 'top_surface', count: 4 }, ROW).group.elementIds.length === 1,
     'the same row named twice is one row');
}
{
  /* A prompt that does not name the vocabulary cannot be obeyed, and the parser would then coerce
     every answer to the default — a silent collapse to one arrangement. */
  const txt = placePrompt({ instruction: 'add a coral on the board', lines: '0|Sea Coral|sticker|board|x' });
  for (const a of ARRANGEMENTS) ok(txt.includes(a), `the prompt names "${a}"`);
  ok(txt.includes('add a coral on the board'), 'the prompt carries the instruction verbatim');
  ok(/EVERY index/.test(txt), 'the prompt asks for every matching row, not the single best');
}

if (failed) { console.error(`\n✗ check:idea-compose — ${failed} guardrail(s) broken\n`); process.exit(1); }
console.log('✓ check:idea-compose — the composer only ever returns parts that exist, on zones they allow');
