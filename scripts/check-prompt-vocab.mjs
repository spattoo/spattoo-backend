#!/usr/bin/env node
// ── The decoration vocabulary has ONE home, and the prompt builder is not it ─────────────────────
//
// `check:medium-vocab` beside this guards the BACKEND copies of "what is a decoration made of".
// It passed green all day on 2026-10-30 while spattoo-admin's prompt builder carried a FIFTH copy:
//
//     MATERIALS = [fondant, buttercream, chocolate, sugar, wafer]
//
// Every problem migration 101 was written to end, reproduced in one array. `sugar` and
// `buttercream` are not keys. `wafer` is `wafer_paper`. Marzipan, isomalt, modelling chocolate and
// royal icing were missing. And "Buttercream" maps to `cream`, which has `can_model = false` — an
// option put in front of staff for a material that cannot be modelled at all.
//
// It was invisible because the gate could not see across the repo boundary, and because the
// correct accessor — `getDecorationMediums()` — was already sitting in the same file it should
// have been read from.
//
// ── What this checks ────────────────────────────────────────────────────────────────────────────
// Not "is the list right" — a list that is right today drifts tomorrow, which is the entire lesson.
// It checks that admin's prompt builder holds NO list at all: no material keys, no pose keys, no
// category names. The questions and their options arrive from the API, resolved server-side
// (routes/elements.js → /decoration-prompt-questions), so there is nothing local to drift.
//
// Pure text reading: no network, no database. Run via `npm run check:prompt-vocab`.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT  = join(dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = join(ROOT, '..', 'spattoo-admin');
const BUILDER = join(ADMIN, 'src', 'lib', 'decorationPrompt.js');

// A checkout without admin beside it is a legitimate state (CI for the API alone); say so and pass
// rather than inventing a failure about a file that is not there.
if (!existsSync(BUILDER)) {
  console.log('ℹ check:prompt-vocab — spattoo-admin is not checked out beside this repo; skipped');
  process.exit(0);
}

const src = readFileSync(BUILDER, 'utf8');
// Comments EXPLAIN the old list by quoting it, and must keep doing so — the explanation is why the
// rule exists. Only the code is checked.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const failures = [];

// 1. No material key may appear. These are the keys decoration_mediums actually holds, plus the
//    invented ones that were in the bad list — a reintroduction is as likely to be wrong as right.
const MEDIUM_WORDS = [
  'fondant', 'chocolate', 'marzipan', 'isomalt', 'wafer', 'royal_icing', 'royal icing',
  'ganache', 'buttercream', 'gumpaste', 'sugarpaste', 'sugar paste', 'edible_print',
];
for (const w of MEDIUM_WORDS) {
  if (new RegExp(`['"\`]${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(code)) {
    failures.push(`a material ("${w}") is named in code. The list comes from /decoration-prompt-questions, resolved from decoration_mediums where can_model.`);
  }
}

// 2. No pose/placement option list. Same failure one axis over: these belong to
//    decoration_prompt_options, per category, because a flower is never "sitting".
for (const w of ['sitting', 'standing', 'lying']) {
  if (new RegExp(`['"\`]${w}['"\`]`, 'i').test(code)) {
    failures.push(`a pose ("${w}") is named in code. Poses are rows in decoration_prompt_options, scoped to the categories where they make sense.`);
  }
}

// 3. No category is named. The moment one is, the twenty-second category has no questions and
//    nobody notices — root CLAUDE.md rule 2.
// ⚠️ WORD BOUNDARIES, NOT A LEADING QUOTE. The first version required a quote before the word, so
//    `const Q = { animals: ['pose'] }` — an unquoted object key, which is the MOST natural way to
//    write the branch this forbids — sailed straight past it. Proven by writing that exact line and
//    watching the gate stay green.
for (const w of ['animals', 'flowers', 'vehicles', 'people', 'fruits']) {
  if (new RegExp(`\\b${w}\\b`, 'i').test(code)) {
    failures.push(`a category ("${w}") is named in code. Questions are keyed by element_categories in the database, never branched on here.`);
  }
}

// 4. And the builder must actually TAKE the server's questions, rather than quietly going back to
//    fixed parameters. Without this the three rules above pass on a file that asks nothing.
if (!/questions\s*=\s*\[\]/.test(code) || !/answers\s*=\s*\{\}/.test(code)) {
  failures.push('buildDecorationPrompt no longer takes `questions` and `answers` — the server-supplied question set is how this stays config-driven.');
}

if (failures.length) {
  console.error('✗ check:prompt-vocab — the decoration vocabulary is being kept in two places:\n');
  for (const f of failures) console.error(`    • ${f}`);
  console.error('\n  Fix: read it from GET /api/decoration-prompt-questions. See migration 149 and 101.');
  process.exit(1);
}

console.log('✓ check:prompt-vocab — admin\'s prompt builder names no material, pose or category; the question set comes from the API');
