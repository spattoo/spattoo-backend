#!/usr/bin/env node
/* ── Can free text become an action? ─────────────────────────────────────────────────────────────
 *
 * ⚠️ THIS IS THE QUESTION, AND A HARNESS WITH DROPDOWNS CANNOT ANSWER IT. Sandeep: *"i wanted to
 * check if a user natural language text can be turned into action. just a predefined actions can
 * definitely be made."* `dev/arrange.html` validates the GEOMETRY from predefined input, which was
 * never the doubt. This validates the LANGUAGE — and deliberately not with the phrasings I would
 * write for a demo, because a model that handles only the sentences its author imagined has not
 * been tested at all.
 *
 * So the set below is mostly awkward on purpose: no zone named, quantity in words, a misspelling,
 * a thing we do not stock, two actions in one breath, a mood rather than an object.
 *
 *   node scripts/eval-place.mjs
 *   node scripts/eval-place.mjs --limit 5
 *
 * ⚠️ IT SPENDS REAL MONEY — one embedding and one gpt-4o call per line.
 */
import 'dotenv/config';
for (const [k, v] of Object.entries({
  REDIS_URL: 'redis://unused.eval.invalid:6379',
  R2_ACCESS_KEY_ID: 'unused-by-eval', R2_SECRET_ACCESS_KEY: 'unused-by-eval',
})) if (!process.env[k]) process.env[k] = v;

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };

/* `expect` is what a person would call right — checked by eye in the table, not asserted. A
   scoreboard that marked its own homework would only ever agree with the prompt that wrote it. */
const CASES = [
  { t: 'add a coral on the board',                         e: 'coral rows, board' },
  { t: 'put four peacocks in a ring around the side',      e: 'peacock, side, ring, 4' },
  // ── no zone named: it has to choose one the row allows
  { t: 'add some peacocks',                                e: 'peacock, any legal zone' },
  // ── quantity in words, not digits
  { t: 'put a few stars on top',                           e: 'stars, top, small count' },
  { t: 'cover the sides in butterflies',                   e: 'butterfly, side, high count' },
  // ── arrangement implied, never named
  { t: 'line the bottom of the cake with shells',          e: 'shells, side or rim, ring' },
  { t: 'one big lion right in the middle of the top',      e: 'lion, top, single' },
  // ── a misspelling
  { t: 'add a pecock on the side',                         e: 'peacock, side — spelling survived' },
  // ── a mood, not an object
  { t: 'make the board look like the sea floor',           e: 'coral/shell/seaweed on board' },
  // ── two actions in one breath: ONE group is the honest answer
  { t: 'a unicorn on top and stars all around it',         e: 'picks one; does not merge two' },
  /* ⚠️ MY OWN EXPECTATION WAS WRONG HERE, and the run is what corrected it. I wrote this case
     believing we had no dinosaur. We have three — and not one of them allows `board`, so the
     model obeyed "the zone must be one every chosen index allows", could not say "wrong zone",
     and placed a Tiger and an Elephant instead. Keep the case: it is the sharpest one in the set. */
  { t: 'add a dinosaur on the board',                      e: '3 dinosaurs exist, all side-only — say so, never swap the animal' },
  // ── Indian English, as a baker would actually type
  { t: 'kindly add some flowers on the sides',             e: 'flowers, side' },
  // ── a zone the row cannot take
  { t: 'put the cricket bat logo on the board',            e: 'refused or re-zoned, with a reason' },
  // ── nonsense
  { t: 'asdf qwerty',                                      e: 'nothing placed, said plainly' },
];

const cases = CASES.slice(0, Number(flag('--limit')) || Infinity);
const { placeFromInstruction } = await import('../src/services/ideaCompose.js');

const rows = [];
let tokens = 0;
for (const [i, c] of cases.entries()) {
  process.stdout.write(`[${String(i + 1).padStart(2)}/${cases.length}] ${c.t}\n`);
  let out;
  try { out = await placeFromInstruction(c.t); }
  catch (err) { console.error(`        ✗ ${err.message}`); rows.push({ ...c, err: err.message }); continue; }
  tokens += out.usage?.prompt_tokens ?? 0;

  if (!out.group) {
    console.log(`        — nothing: ${out.reason}`);
    rows.push({ ...c, none: out.reason, refused: (out.rejected ?? []).length });
    continue;
  }
  const names = (out.elements ?? []).map(r => r.name);
  console.log(`        ${out.group.count}x ${out.group.arrangement} on ${out.group.zone}  ← ${names.join(', ')}`);
  if (out.group.why) console.log(`        "${out.group.why}"`);
  rows.push({ ...c, g: out.group, names, refused: (out.rejected ?? []).length });
}

// ── the sheet ────────────────────────────────────────────────────────────────
const L = '─'.repeat(118);
console.log(`\n${L}\n${'what was typed'.padEnd(42)}${'→ what it did'.padEnd(40)}${'expected'}\n${L}`);
for (const r of rows) {
  const did = r.err  ? `ERROR ${r.err.slice(0, 26)}`
            : r.none ? '(nothing placed)'
            : `${r.g.count}x ${r.g.arrangement} on ${r.g.zone} · ${r.names.length} row(s)`;
  console.log(`${r.t.slice(0, 40).padEnd(42)}${did.padEnd(40)}${r.e}`);
}
console.log(L);

const placed = rows.filter(r => r.g);
const empty  = rows.filter(r => r.none);
console.log(`${placed.length}/${rows.length} produced an action · ${empty.length} placed nothing · ` +
            `${rows.filter(r => r.err).length} errored · ~${Math.round(tokens / Math.max(1, rows.length))} input tokens each`);

/* ⚠️ THE NUMBER THAT MATTERS IS NOT THE HIT RATE. Two of these SHOULD place nothing — a dinosaur
   we do not stock, and gibberish — so a 14/14 would be the bug, not the win. Read the sheet. */
const variety = placed.filter(r => r.names.length > 1).length;
console.log(`${variety}/${placed.length} drew on more than one row (the fix for 79 duplicate-named rows)`);
const kinds = new Set(placed.map(r => r.g.arrangement));
console.log(`arrangements actually chosen: ${[...kinds].join(', ') || '—'}`);
