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
const KNIFE   = 'Palette knife art';

/* ⚠️ THE FIXTURES USED TO INVENT THEIR OWN MEDIUM STRINGS, AND THAT IS HOW THE BUG SURVIVED.
   This file asserted behaviour for `medium: 'edible_paper'` and `'chocolate'` — values the database
   has never been able to store — so it was green while a printed sheet ('edible_print', the real
   value) fell through to the permissive default and was offered a hand-modelling guide.
   Migration 101 makes the vocabulary a TABLE, and these rows mirror its seed. `check:schema-vocab`
   is what keeps the mirror honest; this file's job is the policy, not the list. */
const MEDIUMS = {
  fondant:      { key: 'fondant',      label: 'Fondant / gumpaste',          can_model: true,  can_print: true  },
  isomalt:      { key: 'isomalt',      label: 'Isomalt / sugar glass',       can_model: true,  can_print: false },
  wafer_paper:  { key: 'wafer_paper',  label: 'Wafer paper (shaped)',        can_model: true,  can_print: true  },
  edible_print: { key: 'edible_print', label: 'Edible print (printed sheet)', can_model: false, can_print: true  },
  modelling_chocolate: { key: 'modelling_chocolate', label: 'Modelling chocolate', can_model: true, can_print: true },
  acrylic:      { key: 'acrylic',      label: 'Acrylic / non-edible',        can_model: false, can_print: false },
};

const el = (over = {}) => ({ element_types: { name: STICKER }, ...over });
// Resolves the medium the way a route does — the joined row rides on the element.
const p  = (over) => {
  const e = el(over);
  return decorationPolicy(e, e.medium ? MEDIUMS[e.medium] ?? null : null);
};

// ── ready-made beats every inference ─────────────────────────────────────────
// A faux ball, a bought topper, a candle. Every other branch INFERS whether something is hand-made
// from what it is made of; this is somebody saying so outright, and a statement beats an inference.
{
  const r = p({ placement_config: { ready_made: true } });
  ok(r.modelling === false, 'ready-made offers no modelling guide', JSON.stringify(r));
}

// ── …but "not made" is NOT "not printable" ───────────────────────────────────
// The two are different claims and collapsing them loses a real answer. Butterflies are mostly
// bought AND routinely printed on wafer paper, so once the modelling guide is refused, "print it at
// actual size instead" is the most useful thing the sheet can say. Forcing print off answered the
// baker's question with silence.
ok(p({ medium: 'fondant', placement_config: { ready_made: true } }).print === true,
   'a ready-made fondant piece can still be printed');
ok(p({ medium: 'wafer_paper', placement_config: { ready_made: true } }).print === true,
   'a bought wafer decoration can still be printed');
// Where printing genuinely is impossible the MEDIUM says so, and that answer must survive.
ok(p({ medium: 'acrylic', placement_config: { ready_made: true } }).print === false,
   'acrylic is still unprintable once marked ready-made');

// FIRST, not last. Without this an admin could tick Ready-made, generate a guide anyway, spend the
// credits, and have the result hidden by the fetch filter — the worst of both.
ok(p({ medium: 'fondant', placement_config: { ready_made: true } }).modelling === false,
   'ready-made overrides fondant, which would otherwise be modelled');
ok(p({ element_types: { name: CREAM }, placement_config: { ready_made: true } }).modelling === false,
   'ready-made is answered for the type branches too');

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
ok(p({ element_types: { name: CREAM } }).modelling === false, 'piped cream is covered by the nozzle guide');

/* ⚠️ THE TWO CREAM TECHNIQUES MUST NOT SHARE AN ANSWER. They did, and a buttercream flower pressed
   with a palette knife was refused a guide with the reason "nozzle guide covers this" — which
   covers nothing about pressing cream with a blade. Both directions are asserted, because the bug
   was one set holding two types and either half could be lost again. */
ok(p({ element_types: { name: KNIFE } }).modelling === true,  'palette-knife cream is hand-made and gets a guide');
ok(p({ element_types: { name: KNIFE } }).print === false,     'a flat print cannot stand in for the relief a blade leaves');
ok(/palette|knife/i.test(p({ element_types: { name: KNIFE } }).reason), 'and the reason says which craft it is');
ok(p({ medium: 'fondant' }).print === true,       'fondant offers both paths — bakers substitute constantly');
/* ⚠️ THESE TWO ASSERTED THE OPPOSITE OF WHAT NOW HOLDS, against values the database never accepted.
   'chocolate' claimed modelling:false "no guide format yet" — but modelling chocolate IS modelled,
   by hand, and the only reason it was refused is that nobody had written the format. That is a gap
   in our tooling being encoded as a fact about the craft. It is `modelling_chocolate` now and it
   gets the same build sheet as fondant, because the two are worked the same way.
   'edible_paper' conflated a PRINTED sheet with SHAPED wafer paper; they are separate rows now and
   only one of them has a hand-made version. */
ok(p({ medium: 'edible_print' }).modelling === false, 'a printed sheet has no hand-made version');
ok(p({ medium: 'acrylic' }).modelling === false,   'acrylic is bought, not made');
ok(p({ medium: 'acrylic' }).print === false,       'acrylic is not printed either');
ok(p({}).modelling === true,                       'an unset medium offers both and lets the model answer');
ok(decorationPolicy({}).modelling === true,        'an unrecognised type does not silently withhold a guide');
// A row that never loaded, rather than a row with nothing set.
ok(decorationPolicy(null).modelling === true,      'a null row does not throw');


// ── The regression this file failed to catch, asserted directly ─────────────────────────────────
// Each of these was WRONG before migration 101 and the policy reading the material's own row.
{
  // A printed sheet has no hand-made version. This returned `modelling: true` because 'edible_print'
  // matched no case in the old switch and fell to the generous default.
  const print = p({ medium: 'edible_print' });
  ok(print.modelling === false, 'a printed sheet offers no modelling guide', JSON.stringify(print));
  ok(print.print === true, 'a printed sheet can still be printed');
  ok(!/not stated/.test(print.reason), 'a STATED medium never reports "not stated"', print.reason);

  // Isomalt is cooked and poured, never printed — and it must still get a build guide. Before 101
  // the material could not be stored at all, so this had no answer.
  const iso = p({ medium: 'isomalt' });
  ok(iso.modelling === true,  'isomalt offers a build guide', JSON.stringify(iso));
  ok(iso.print === false,     'isomalt cannot be printed',    JSON.stringify(iso));

  // Shaped wafer paper IS made by hand — cut, wetted to curl, dried, dusted. The distinction from
  // a printed sheet is the whole reason the two are separate rows.
  const wafer = p({ medium: 'wafer_paper' });
  ok(wafer.modelling === true, 'shaped wafer paper offers a build guide', JSON.stringify(wafer));

  // ⚠️ AN UNRESOLVED MEDIUM IS NOT "NOT STATED". A join the caller forgot must not land on the most
  // permissive answer available — that is exactly how the original bug stayed invisible.
  const unresolved = decorationPolicy(el({ medium: 'something_new' }), null);
  ok(unresolved.modelling === false, 'an unresolved medium refuses the modelling guide', JSON.stringify(unresolved));
  ok(/not resolved/.test(unresolved.reason), 'and says so rather than claiming "not stated"', unresolved.reason);

  // Genuinely unset still means "let the model answer".
  const unset = p({});
  ok(unset.modelling === true && /not stated/.test(unset.reason), 'an unset medium still offers both', JSON.stringify(unset));
}

if (failures) {
  console.error(`\n✗ check:decoration-policy — ${failures} rule(s) broken.`);
  process.exit(1);
}
console.log('✓ check:decoration-policy — ready-made stops MODELLING not printing; medium and type rules intact');
