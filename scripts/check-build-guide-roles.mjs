#!/usr/bin/env node
// ── the build guide must use the parts we authored ────────────────────────────
// A decoration recomposed in admin carries its own part map — `placement_config._model.groups`,
// one entry per recolourable area with a label and the hex chosen for it. The build-guide prompt
// was asking a vision model to reinvent that list from ONE thumbnail, and it showed: a fondant doll
// came back with no steps for its hair and none for its shoes, and the stage picture painted the
// dress colour across its face because nothing tied the illustration to a real part.
//
// Two things are checked, and they fail in opposite directions:
//   * a segmented decoration whose roles are NOT read → back to guessing, and parts go missing
//   * an unsegmented one that somehow produces roles → a fabricated list presented as authored
//
// Pure — knownRoles reads only the row handed to it, so this needs no network, no config and no
// database, the same bargain check-decoration-policy makes. Run via
// `npm run check:build-guide-roles` (or the aggregate `npm run check`).
import { readFileSync } from 'node:fs';
import { knownRoles } from '../src/services/decorationPolicy.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

// The REAL shape Recompose writes, copied off a live element (Fondant doll 2) rather than invented:
// a fixture with the wrong key name would pass every assertion below for the wrong reason.
const DOLL = {
  placement_config: {
    _model: {
      source: 'glb-recompose',
      mode: 'parts',
      groups: [
        { key: 'Hair',     label: 'Hair',     default: '#b24d03', editable: true },
        { key: 'Body',     label: 'Body',     default: '#fbc9a3', editable: true },
        { key: 'Dress',    label: 'Dress',    default: '#fdd5d4', editable: true },
        { key: 'Shoe',     label: 'Shoe',     default: '#a35e7e', editable: true },
        { key: 'Eyes',     label: 'Eyes',     default: '#190a0c', editable: true },
        { key: 'Eyebrows', label: 'Eyebrows', default: '#ad5d33', editable: true },
      ],
    },
  },
};

// ── every authored part is offered to the prompt ─────────────────────────────
{
  const roles = knownRoles(DOLL);
  ok(roles.length === 6, 'the doll yields all six authored roles', `got ${roles.length}`);
  for (const want of ['hair', 'body', 'dress', 'shoe', 'eyes', 'eyebrows']) {
    ok(roles.some(r => r.role === want), `role "${want}" is offered`);
  }
  // The two the report was about. Neither is clearly visible in the one thumbnail we send, which is
  // exactly why they have to come from the data rather than from looking.
  ok(roles.find(r => r.role === 'hair')?.hex === '#b24d03', 'hair carries its authored hex');
  ok(roles.find(r => r.role === 'shoe')?.hex === '#a35e7e', 'shoe carries its authored hex');
}

// ── tokens, because the guide's own contract is tokens ───────────────────────
// Instructions embed a role as {body}. A role called "Hair" would never match, and a mismatch is
// silent — the guide reads fine and the swatch beside it is empty.
{
  const roles = knownRoles({ placement_config: { _model: { groups: [
    { key: 'Inner Ear', default: '#ffffff' },
    { key: 'Left-Arm',  default: '#ABCDEF' },
  ] } } });
  ok(roles[0].role === 'inner_ear', 'a spaced label becomes a token', roles[0]?.role);
  ok(roles[1].role === 'left_arm', 'a hyphen becomes an underscore', roles[1]?.role);
  ok(roles[1].hex === '#abcdef', 'hex is normalised to lower case', roles[1]?.hex);
}

// ── nothing invented for a decoration nobody segmented ───────────────────────
// Most elements have no part map, and the prompt must fall back to looking. Returning a made-up
// role here would be worse than returning none: the prompt states these as FACT.
{
  ok(knownRoles({}).length === 0, 'no element data → no roles');
  ok(knownRoles({ placement_config: {} }).length === 0, 'no _model → no roles');
  ok(knownRoles({ placement_config: { _model: {} } }).length === 0, 'no groups → no roles');
  ok(knownRoles({ placement_config: { _model: { groups: 'nope' } } }).length === 0, 'groups not an array → no roles');
  ok(knownRoles(null).length === 0, 'null element → no roles');
}

// ── a malformed row degrades, it does not throw ──────────────────────────────
{
  const roles = knownRoles({ placement_config: { _model: { groups: [
    { key: '', default: '#000000' },        // no key at all
    { key: 'Body' },                        // no colour
    { key: 'Body', default: '#fff' },       // duplicate key, and a short hex
    { key: 'Hat', default: 'not-a-hex' },
  ] } } });
  ok(roles.length === 2, 'blank keys dropped, duplicates collapsed', `got ${roles.length}`);
  ok(roles.find(r => r.role === 'body')?.hex === null, 'a missing hex is null, not invented');
  ok(roles.find(r => r.role === 'hat')?.hex === null, 'an unparseable hex is null, not passed through');
}

// ── the prompt actually consumes them ────────────────────────────────────────
// The extractor being right is worth nothing if the prompt never receives it. Checked as source
// text because calling the real thing costs a request and an API key.
{
  const gen = readFileSync(new URL('../src/services/decorationGuide.js', import.meta.url), 'utf8');
  ok(/knownRoles\(el\)/.test(gen), 'the generator reads the element\'s roles');
  // Matched across the call's whole argument object: `[^)]*` stops at the first `)`, which is the
  // one inside toPublicUrl(imageKey), so it never reached the argument that matters.
  ok(/suggestBuildGuide\(\{[\s\S]{0,300}?\broles\b/.test(gen), 'the roles are passed to the prompt');
  ok(/build-guide-v4/.test(gen), 'the prompt version records the change');

  const ai = readFileSync(new URL('../src/services/openai.js', import.meta.url), 'utf8');
  ok(/roles = \[\]/.test(ai), 'suggestBuildGuide accepts roles');
  ok(/EVERY role above must be MADE/.test(ai), 'the prompt requires a step per authored role');
  ok(/do not read them off the image/.test(ai), 'the prompt takes hexes from the data, not the picture');
  // The reported failure in one line: a part that is hard to see was simply left out.
  ok(/still part of the decoration/.test(ai), 'the prompt says an unseen part is still made');
}

if (failures) {
  console.error(`\n✗ check:build-guide-roles — ${failures} failed`);
  process.exit(1);
}
console.log('✓ check:build-guide-roles — authored parts reach the guide, and nothing is invented without them');
