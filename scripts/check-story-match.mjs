#!/usr/bin/env node
/* ── The story→template ranker behaves, without a network ────────────────────────────────────────
 *
 * ⚠️ THE SCORING IS THE PART THAT GOES WRONG QUIETLY. A ranker never throws; it just puts the wrong
 * cake first, and nobody can tell whether that is the library or the maths. So the ranking function
 * is pure and these are the properties it must keep — asserted against made-up similarities, with
 * no embedding call and no database.
 *
 * Run by `npm run check` with the other gates.
 */

import {
  rankTemplates, evidenceOf, EVIDENCE_FLOOR, MAX_EVIDENCE,
  genderOf, suitsAge, applyAudience, subjectOf, AGE_CEILING, GENDER_PENALTY,
} from '../src/services/storyRank.js';

let failed = 0;
const ok = (cond, what) => { if (!cond) { failed++; console.error(`  ✗ ${what}`); } };
const names = new Map([['e1', { name: 'lipstick' }], ['e2', { name: 'eyeshadow palette' }],
                       ['e3', { name: 'nail polish' }], ['e4', { name: 'piping border' }]]);

// ── the floor ───────────────────────────────────────────────────────────────────────────────────
ok(evidenceOf(EVIDENCE_FLOOR) === 0, 'a similarity exactly at the floor is not evidence');
ok(evidenceOf(EVIDENCE_FLOOR - 0.1) === 0, 'below the floor is not evidence');
ok(evidenceOf(1) === 1, 'certainty is full evidence');
ok(evidenceOf(null) === 0 && evidenceOf(NaN) === 0 && evidenceOf('x') === 0, 'rubbish is not evidence');

// ── one strong match beats several weak ones ────────────────────────────────────────────────────
/* ⚠️ THE WHOLE REASON THIS IS NOT A SUM. A busy cake has more chances to catch a weak similarity,
   so adding them up ranks "the cake with the most on it" rather than "the cake the story is about".
   A plain cake with one perfect match has to be able to win. */
{
  const r = rankTemplates({
    hits: [{ id: 'e1', similarity: 0.80 }, { id: 'e2', similarity: 0.30 },
           { id: 'e3', similarity: 0.30 }, { id: 'e4', similarity: 0.30 }],
    links: [{ template_id: 'plain', element_id: 'e1' },
            { template_id: 'busy', element_id: 'e2' }, { template_id: 'busy', element_id: 'e3' },
            { template_id: 'busy', element_id: 'e4' }],
    elements: names,
  });
  ok(r[0]?.templateId === 'plain', 'one strong match outranks three weak ones');
}

// ── corroboration still counts ──────────────────────────────────────────────────────────────────
/* Three decent matches ARE the cake the customer described, and must beat a single decent one. */
{
  const r = rankTemplates({
    hits: [{ id: 'e1', similarity: 0.55 }, { id: 'e2', similarity: 0.55 }, { id: 'e3', similarity: 0.55 }],
    links: [{ template_id: 'three', element_id: 'e1' }, { template_id: 'three', element_id: 'e2' },
            { template_id: 'three', element_id: 'e3' }, { template_id: 'one', element_id: 'e1' }],
    elements: names,
  });
  ok(r[0]?.templateId === 'three', 'three matching elements outrank one of the same strength');
  ok(r.every(x => x.score < 1), 'the score stays below certainty however much evidence there is');
}

// ── quantity cannot run away ────────────────────────────────────────────────────────────────────
{
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, similarity: 0.45 }));
  const r = rankTemplates({
    hits: [...many, { id: 'best', similarity: 0.95 }],
    links: [...many.map(m => ({ template_id: 'parts-list', element_id: m.id })),
            { template_id: 'bullseye', element_id: 'best' }],
    elements: new Map(),
  });
  ok(r[0]?.templateId === 'bullseye', 'a thirty-element parts list does not beat one bullseye');
  ok((r.find(x => x.templateId === 'parts-list')?.why ?? []).length <= MAX_EVIDENCE,
     `at most ${MAX_EVIDENCE} elements are allowed to explain a match`);
}

// ── it explains itself ──────────────────────────────────────────────────────────────────────────
/* The names are the point: tags could never say "because it has a lipstick and a nail polish". */
{
  const r = rankTemplates({
    hits: [{ id: 'e1', similarity: 0.7 }, { id: 'e3', similarity: 0.6 }],
    links: [{ template_id: 't', element_id: 'e1' }, { template_id: 't', element_id: 'e3' }],
    elements: names,
  });
  ok(r[0].why.map(w => w.name).join(',') === 'lipstick,nail polish', 'the reason is the element names, strongest first');
}

// ── nothing, and rubbish ────────────────────────────────────────────────────────────────────────
ok(rankTemplates().length === 0, 'no arguments is an empty list, not a throw');
ok(rankTemplates({ hits: [], links: [] }).length === 0, 'no hits is an empty list');
ok(rankTemplates({ hits: [{ id: 'e1', similarity: 0.1 }], links: [{ template_id: 't', element_id: 'e1' }] }).length === 0,
   'a template whose only match is below the floor does not appear at all');
ok(rankTemplates({ hits: [{ id: 'e1', similarity: 0.9 }], links: [{ template_id: 't', element_id: 'nope' }] }).length === 0,
   'a link to an element the story did not match contributes nothing');

// ── stable ──────────────────────────────────────────────────────────────────────────────────────
/* ⚠️ A LIST THAT RESHUFFLES BETWEEN IDENTICAL CALLS is impossible to test and reads as a bug. */
{
  const args = {
    hits: [{ id: 'e1', similarity: 0.5 }, { id: 'e2', similarity: 0.5 }],
    links: [{ template_id: 'b', element_id: 'e1' }, { template_id: 'a', element_id: 'e2' }],
    elements: names,
  };
  const one = rankTemplates(args).map(r => r.templateId).join(',');
  const two = rankTemplates(args).map(r => r.templateId).join(',');
  ok(one === two && one === 'a,b', 'equal scores tie-break on the id, the same way every time');
}

// ── the limit is honoured ───────────────────────────────────────────────────────────────────────
{
  const hits = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, similarity: 0.9 - i * 0.01 }));
  const links = hits.map((h, i) => ({ template_id: `t${i}`, element_id: h.id }));
  ok(rankTemplates({ hits, links, limit: 5 }).length === 5, 'limit caps the list');
}


// ── who the cake is for ─────────────────────────────────────────────────────────────────────────
/* ⚠️ THIS HALF SHIPPED UNBUILT ONCE ALREADY. `subjectOf` pulled the 8 out of "a super hero cake for
   8 year old boy", handed it back, and nothing used it — so a story about an eight-year-old ranked
   a wedding cake exactly as highly as a children's one. These are the properties that says it. */
ok(genderOf('a cake for my 8 year old boy') === 'boys', 'a boy is read from the story');
ok(genderOf('my daughter likes makeup kits') === 'girls', 'a daughter is read as girls');
ok(genderOf('she loves doing her nails') === 'girls', 'pronouns count too');
ok(genderOf('i need a birthday cake') === null, 'a story that says nothing gives nothing');
/* ⚠️ REFUSES TO GUESS WHEN BOTH ARE NAMED. "for my son and daughter" names two people; picking one
   files the cake under half the request. */
ok(genderOf('a cake for my son and daughter') === null, 'two genders named is not a signal');

/* ⚠️ THE GENDER WORDS LEAVE THE SUBJECT once they have been read — they describe the person, never
   the cake. "daughter makeup kits" was embedding a word about no cake at all. */
ok(!subjectOf('my daughter likes makeup kits').subject.includes('daughter'), 'gender words leave the subject');
ok(subjectOf('my daughter likes makeup kits').subject.includes('makeup'), '…and the subject survives');

// ⚠️ MIRRORS core's matchesAge. The two surfaces must agree about the same template.
ok(suitsAge({ min_age: 1, max_age: 10 }, 8), 'an 8-year-old fits a 1–10 cake');
ok(!suitsAge({ min_age: 20, max_age: 99 }, 8), 'and does not fit a 20–99 cake');
ok(suitsAge(null, 8) && suitsAge({}, 8), 'a cake with no range stated excludes nobody');
ok(suitsAge({ min_age: 1, max_age: 10 }, null), 'no age asked for excludes nobody');
/* ⚠️ THE CEILING MEANS "18 OR OLDER", NOT EXACTLY 18 — core's own comment. Testing 18 exactly
   would drop every design whose min_age is 20, Couple (20–99) among them. */
ok(suitsAge({ min_age: 20, max_age: 99 }, AGE_CEILING), 'at the ceiling, a 20–99 cake still counts');
ok(!suitsAge({ min_age: 1, max_age: 10 }, AGE_CEILING), '…but one that stops at 10 does not');

// ── age excludes, gender only demotes ───────────────────────────────────────────────────────────
{
  const ranked = [{ templateId: 'kids', score: 0.5 }, { templateId: 'adult', score: 0.9 }];
  const byId = new Map([
    ['kids',  { attrs: { min_age: 1, max_age: 10 }, genders: ['girls'] }],
    ['adult', { attrs: { min_age: 20, max_age: 99 }, genders: ['anyone'] }],
  ]);
  const out = applyAudience(ranked, { ages: [8], gender: null }, byId);
  ok(out.length === 1 && out[0].templateId === 'kids', 'an age mismatch is excluded, however well it scored');
}
{
  const ranked = [{ templateId: 'girly', score: 0.9 }, { templateId: 'neutral', score: 0.7 }];
  const byId = new Map([
    ['girly',   { attrs: null, genders: ['girls'] }],
    ['neutral', { attrs: null, genders: ['anyone'] }],
  ]);
  const out = applyAudience(ranked, { ages: [], gender: 'boys' }, byId);
  ok(out[0].templateId === 'neutral', 'a gender mismatch is demoted below a neutral cake');
  ok(out.length === 2, '…but never removed — a catalogue that leans one way must still answer');
  ok(out.find(r => r.templateId === 'girly')?.audience === 'other gender', 'and it says why it dropped');
  ok(GENDER_PENALTY > 0 && GENDER_PENALTY < 1, 'the penalty reorders rather than buries');
}
{
  const byId = new Map([['t', { attrs: null, genders: [] }]]);
  const out = applyAudience([{ templateId: 't', score: 0.8 }], { ages: [], gender: 'boys' }, byId);
  ok(out[0].score === 0.8, 'a template that states no gender is not penalised for saying nothing');
}

if (failed) { console.error(`\n✗ check:story-match — ${failed} property/properties broken\n`); process.exit(1); }
console.log('✓ check:story-match — the story→template ranker keeps its properties');
