#!/usr/bin/env node
// ── what X-Ray may offer for a decoration ─────────────────────────────────────
// Every rule here decides whether a baker is shown a way to hand-make something, and two of the
// failures cost real money in opposite directions: offering a modelling guide for something nobody
// hand-makes SPENDS CREDITS on a process that does not exist, and withholding one for something a
// baker does make leaves them with a sheet that says nothing about the hardest thing on the cake.
//
// Pure — decorationPolicy.js reads only the row handed to it, so this needs no network, no config
// and no database. Run via `npm run check:decoration-policy` (or the aggregate `npm run check`).
import { decorationPolicy } from '../src/services/decorationPolicy.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

// The REAL type names, read off decorationPolicy.js rather than invented — a fixture with a made-up
// type falls into the "type not recognised" branch and every assertion below it passes for the wrong
// reason.
const STICKER = 'Cake Topper';
const CREAM   = 'Cream Piping';
const el = (over = {}) => ({ element_types: { name: STICKER }, ...over });
const p  = (over) => decorationPolicy(el(over));

// ── ready-made beats every inference ─────────────────────────────────────────
// A faux ball, a bought topper, a candle. Every other branch INFERS whether something is hand-made
// from what it is made of; this is somebody saying so outright, and a statement beats an inference.
{
  const r = p({ placement_config: { ready_made: true } });
  ok(r.modelling === false, 'ready-made offers no modelling guide', JSON.stringify(r));
  // Printing at actual size exists to give a baker a template to model against. Nothing to model.
  ok(r.print === false, 'ready-made offers no print either', JSON.stringify(r));
}

// FIRST, not last. Without this an admin could tick Ready-made, generate a guide anyway, spend the
// credits, and have the result hidden by the fetch filter — the worst of both.
ok(p({ medium: 'fondant', placement_config: { ready_made: true } }).modelling === false,
   'ready-made overrides fondant, which would otherwise be modelled');
ok(p({ element_types: { name: CREAM }, placement_config: { ready_made: true } }).print === false,
   'ready-made is answered before the type branches too');

// It must not fire on a MISSING flag, or every decoration silently loses its guide.
ok(p({ medium: 'fondant' }).modelling === true, 'no flag means business as usual');
ok(p({ medium: 'fondant', placement_config: {} }).modelling === true, 'an empty config is not ready-made');
ok(p({ medium: 'fondant', placement_config: { ready_made: false } }).modelling === true,
   'ready_made:false is not ready-made');

// ── medium and ready_made are independent ────────────────────────────────────
// `medium` says what a thing is made OF; `ready_made` says you do not make it. A fondant ball bought
// pre-rolled is both, and collapsing the two would mean either lying about the material or losing
// the flag.
{
  const bought = p({ medium: 'fondant', placement_config: { ready_made: true } });
  const made   = p({ medium: 'fondant' });
  ok(bought.modelling === false && made.modelling === true,
     'the same medium answers differently once it is marked bought');
}

// ── the rules that were already here, so the new branch cannot quietly move them ──
ok(p({ element_types: { name: CREAM } }).modelling === false, 'cream is covered by the nozzle guide');
ok(p({ medium: 'fondant' }).print === true,       'fondant offers both paths — bakers substitute constantly');
ok(p({ medium: 'chocolate' }).modelling === false, 'chocolate has no guide format yet');
ok(p({ medium: 'chocolate' }).print === true,      'chocolate can still be printed');
ok(p({ medium: 'edible_paper' }).modelling === false, 'a printed sheet has no hand-made version');
ok(p({ medium: 'acrylic' }).modelling === false,   'acrylic is bought, not made');
ok(p({ medium: 'acrylic' }).print === false,       'acrylic is not printed either');
ok(p({}).modelling === true,                       'an unset medium offers both and lets the model answer');
ok(decorationPolicy({}).modelling === true,        'an unrecognised type does not silently withhold a guide');
// A row that never loaded, rather than a row with nothing set.
ok(decorationPolicy(null).modelling === true,      'a null row does not throw');

if (failures) {
  console.error(`\n✗ check:decoration-policy — ${failures} rule(s) broken.`);
  process.exit(1);
}
console.log('✓ check:decoration-policy — ready-made beats inference; medium and type rules intact');
