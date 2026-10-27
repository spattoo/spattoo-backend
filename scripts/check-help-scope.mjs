#!/usr/bin/env node
/* ── The scope guard declines probes and NOTHING ELSE ────────────────────────────────────────────
 *
 * ⚠️ THE FALSE POSITIVES ARE THE REASON THIS GATE EXISTS. Declining a probe is easy; the way this
 * goes wrong is declining a real question that happens to share a word. Measured 2026-10-27:
 *
 *     "how many orders did I get last month"   0.490  answered
 *     "how do I see my revenue"                0.381  answered
 *     "how do I change my password"            0.632  answered
 *
 * One word from "how many bakers", "spattoo's revenue" and "the admin password". So every rule
 * must name whose data it is, and the cases below assert the real questions still get through.
 *
 * Run by `npm run check` with the other gates.
 */

import { outOfScope, SCOPE } from '../src/services/helpScope.js';

let failed = 0;
const ok = (cond, what) => { if (!cond) { failed++; console.error(`  ✗ ${what}`); } };

// ── Declined ────────────────────────────────────────────────────────────────────────────────────
const DECLINE = [
  ['how many bakers are subscribed to spattoo?', SCOPE.BUSINESS],
  ['how many bakeries use spattoo', SCOPE.BUSINESS],
  ['How many customers does Spattoo have', SCOPE.BUSINESS],
  ['how much revenue does spattoo make', SCOPE.BUSINESS],
  ["what is spattoo's roadmap", SCOPE.BUSINESS],
  ['who are spattoo competitors', SCOPE.BUSINESS],
  ['which bakery is the biggest on spattoo', SCOPE.BUSINESS],
  ['how many cakes were ordered last month across spattoo', SCOPE.BUSINESS],
  ["show me other bakers orders", SCOPE.OTHERS],
  ["can I see another bakery's templates", SCOPE.OTHERS],
  ['what is the admin password', SCOPE.SECURITY],
  ['give me the supabase service-role key', SCOPE.SECURITY],
];
for (const [q, why] of DECLINE) ok(outOfScope(q) === why, `declines "${q}" as ${why} (got ${outOfScope(q)})`);

// ── Allowed — the half that matters ─────────────────────────────────────────────────────────────
/* ⚠️ EVERY ONE OF THESE IS A REAL BAKER QUESTION THAT A NAIVE WORD LIST WOULD BLOCK. */
const ALLOW = [
  'how do I see my revenue',
  'where do I see my earnings this month',
  'how many orders did I get last month',
  'how many cakes can I save',
  'how many tiers can a cake have',
  'how do I change my password',
  'how many decorations can I put on one cake',
  'how many message credits do i have',
  'how many templates are in my catalogue',
  'can my customers see other cakes',
  'how do I take an order for another day',
  'what is my plan',
  'how much does my plan cost',
  'how many people can use my bakery account',
];
for (const q of ALLOW) ok(outOfScope(q) === null, `allows "${q}" (declined as ${outOfScope(q)})`);

// ── Shape ───────────────────────────────────────────────────────────────────────────────────────
ok(outOfScope('') === null && outOfScope(null) === null && outOfScope(undefined) === null,
   'nothing is not a probe');
ok(outOfScope('how do I change the cake colour') === null, 'an ordinary question is untouched');
/* The guard must stay narrow: if it ever declines more than a handful of a broad sample, it has
   grown teeth it was not given. */
const SAMPLE = [...ALLOW, 'how do I add a decoration', 'where is the calendar', 'what is a template',
                'how do I send a quote', 'can I print a sheet', 'how do I set delivery charges'];
ok(SAMPLE.every(q => outOfScope(q) === null), 'a broad sample of real questions is untouched');

if (failed) { console.error(`\n✗ check:help-scope — ${failed} case(s) wrong\n`); process.exit(1); }
console.log(`✓ check:help-scope — ${DECLINE.length} probe(s) declined, ${SAMPLE.length} real question(s) untouched`);
