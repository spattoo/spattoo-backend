#!/usr/bin/env node
// ── Gate: a match must be SEMANTICALLY supported, not just plausibly placed ──────────
//
// Guards the defect that shipped: on a real order a pink fondant bow on a top surface matched the
// library element "Fondant doll 1", and the baker was shown a faithful, detailed guide to a doll
// at high reported confidence.
//
// The cause is arithmetic, not luck. inspirationMatch scores
//     0.40·semantic + 0.25·zone + 0.15·type + 0.08·mode + 0.12·colour
// against a 0.35 floor. The non-semantic terms total 0.60, so anything sitting in the right place,
// in the right medium, in a similar colour clears the floor with a semantic similarity of ZERO.
// A bow and a doll agree on every one of those.
//
// Runs offline: no embeddings, no database, no provider. That is deliberate — the failure is
// expressible as numbers, and a gate that needed a real match would cost money to run and would
// therefore not be run.
import { isConfidentMatch } from '../src/services/inspirationMaps.js';

let failed = 0;
const check = (name, got, want) => {
  if (got !== want) { console.error(`  ✗ ${name}: expected ${want}, got ${got}`); failed++; }
};

// A candidate as scoreCandidate() builds it. `score` is the composite; breakdown.semantic is the
// embedding similarity on its own.
const cand = (score, semantic) => ({ score, breakdown: { semantic } });

// ── THE REGRESSION ──────────────────────────────────────────────────────────────────
// The bow/doll shape: everything agrees except what the object is. Composite comfortably over the
// 0.35 floor, built almost entirely from placement, type, mode and colour.
//   0.40(0.20) + 0.25(1) + 0.15(1) + 0.08(1) + 0.12(0.9) = 0.068 + 0.25 + 0.15 + 0.08 + 0.108 = 0.656
check('a bow does not match a doll on placement and colour alone', isConfidentMatch(cand(0.656, 0.20)), false);

// Same, at the exact boundary of the old behaviour: a perfect non-semantic score with NO semantic
// support at all. Under the old single gate this was 0.59 and accepted.
check('zero semantic support is never a match, however well placed', isConfidentMatch(cand(0.59, 0.0)), false);

// ── WHAT MUST STILL MATCH ───────────────────────────────────────────────────────────
// A genuine recognition. The floor must not cost real coverage.
check('a well-recognised, well-placed candidate matches', isConfidentMatch(cand(0.82, 0.75)), true);
// Recognised, but placed somewhere unusual — semantics carry it.
check('strong recognition survives weak placement', isConfidentMatch(cand(0.45, 0.70)), true);

// ── BOTH GATES ARE LOAD-BEARING ─────────────────────────────────────────────────────
// Semantic alone must not resurrect a candidate the composite rejects: a decoration the model
// recognises but which cannot go where it needs to go is still not the right element.
check('a high semantic cannot rescue a failing composite', isConfidentMatch(cand(0.30, 0.90)), false);

// ── BOUNDARIES ──────────────────────────────────────────────────────────────────────
check('exactly at both floors is a match',        isConfidentMatch(cand(0.35, 0.45)), true);
check('a hair under the semantic floor is not',   isConfidentMatch(cand(0.90, 0.449)), false);
check('a hair under the composite floor is not',  isConfidentMatch(cand(0.349, 0.90)), false);

// ── DEGENERATE INPUT ────────────────────────────────────────────────────────────────
// An empty shortlist, or a candidate from a code path that never set a breakdown, must fail
// CLOSED. Failing open here would reintroduce the defect through the back door.
check('no candidate is not a match',              isConfidentMatch(null), false);
check('a missing breakdown fails closed',         isConfidentMatch({ score: 0.9 }), false);

if (failed) {
  console.error(`\n✗ check:match-confidence — ${failed} failed`);
  process.exit(1);
}
console.log('✓ match confidence: placement and colour alone cannot certify a match; both floors hold');
