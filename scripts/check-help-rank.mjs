#!/usr/bin/env node
/* ── The help ranker behaves, without a network ──────────────────────────────────────────────────
 *
 * ⚠️ THE TWO THINGS THAT GO WRONG HERE ARE BOTH SILENT. Drop the floor and the assistant answers
 * "what is the weather" with a cake article; drop the per-article cap and a top-four becomes four
 * pieces of the same article, which reads as one answer repeated and hides the three others that
 * might have been right. Neither throws. So they are asserted.
 *
 * Run by `npm run check` with the other gates.
 */

import { cosine, rankSections, ANSWER_FLOOR } from '../src/services/helpRank.js';

let failed = 0;
const ok = (cond, what) => { if (!cond) { failed++; console.error(`  ✗ ${what}`); } };

// ── cosine ──────────────────────────────────────────────────────────────────────────────────────
ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9, 'a vector matches itself exactly');
ok(Math.abs(cosine([1, 0], [0, 1])) < 1e-9, 'orthogonal scores zero');
ok(Math.abs(cosine([1, 0], [2, 0]) - 1) < 1e-9, 'length does not matter, only direction');
ok(cosine([1, 0], [1, 0, 0]) === 0, 'a length mismatch scores zero rather than throwing');
ok(cosine(null, [1]) === 0 && cosine([1], undefined) === 0, 'a missing embedding scores zero');
ok(cosine([0, 0], [0, 0]) === 0, 'a zero vector does not divide by zero');

// ── the floor: nothing rather than the closest thing ────────────────────────────────────────────
{
  const near = [{ doc_slug: 'tiers', position: 0, score: ANSWER_FLOOR - 0.01 }];
  ok(rankSections(near).length === 0, 'below the floor returns nothing, not the nearest article');
  const at = [{ doc_slug: 'tiers', position: 0, score: ANSWER_FLOOR }];
  ok(rankSections(at).length === 1, 'exactly at the floor is an answer');
  ok(ANSWER_FLOOR > 0, 'there is a floor at all');
}
ok(rankSections([]).length === 0 && rankSections(null).length === 0, 'no sections is an empty answer');
ok(rankSections([{ doc_slug: 'a', score: NaN }, { doc_slug: 'b', score: 'x' }]).length === 0,
   'a rubbish score is not an answer');

// ── one section per article ─────────────────────────────────────────────────────────────────────
/* The real corpus is internally similar by construction: "Changing the cake colour" has six
   sections that all mention tiers and cream. Unfiltered, they take every slot. */
{
  const same = [
    { doc_slug: 'colour', heading: 'a', position: 0, score: 0.80 },
    { doc_slug: 'colour', heading: 'b', position: 1, score: 0.79 },
    { doc_slug: 'colour', heading: 'c', position: 2, score: 0.78 },
    { doc_slug: 'tiers',  heading: 'd', position: 0, score: 0.60 },
    { doc_slug: 'glaze',  heading: 'e', position: 0, score: 0.55 },
  ];
  const out = rankSections(same, { limit: 4 });
  ok(out.length === 3, 'four slots over three articles returns three sections, not four');
  ok(out.map(s => s.doc_slug).join() === 'colour,tiers,glaze', 'best article first, then the others');
  ok(out[0].heading === 'a', 'and the best section of the winning article is the one shown');
  const two = rankSections(same, { limit: 4, perDoc: 2 });
  ok(two.filter(s => s.doc_slug === 'colour').length === 2, 'perDoc is honoured when a caller raises it');
}

// ── ordering is total, so the same question gives the same answer twice ─────────────────────────
/* ⚠️ A TIE BROKEN BY ARRAY ORDER IS A DIFFERENT ANSWER EVERY TIME THE ROWS COME BACK IN A
   DIFFERENT ORDER — and they do, because nothing orders the select. */
{
  const tied = [
    { doc_slug: 'zebra', position: 1, score: 0.7 },
    { doc_slug: 'apple', position: 3, score: 0.7 },
    { doc_slug: 'apple', position: 0, score: 0.7 },
  ];
  const a = rankSections(tied, { limit: 3, perDoc: 2 }).map(s => `${s.doc_slug}#${s.position}`).join();
  const b = rankSections([...tied].reverse(), { limit: 3, perDoc: 2 }).map(s => `${s.doc_slug}#${s.position}`).join();
  ok(a === b, 'shuffling the rows does not change the answer');
  ok(a === 'apple#0,apple#3,zebra#1', 'ties break by article then by position in the article');
}

// ── the embedding never travels to the browser ──────────────────────────────────────────────────
/* 1536 floats per section is ~30KB of payload nobody renders, and it is the service's job to strip
   it — but the ranker must not put it back. */
{
  const out = rankSections([{ doc_slug: 'a', position: 0, score: 0.9, body: 'text' }]);
  ok(!('embedding' in out[0]), 'the ranker adds no embedding to what it returns');
  ok(out[0].body === 'text', 'and it carries the article text through');
  ok(out[0].score === 0.9, 'and a readable score');
}

if (failed) { console.error(`\n✗ check:help-rank — ${failed} property/properties broken\n`); process.exit(1); }
console.log('✓ check:help-rank — the help ranker keeps its properties');
