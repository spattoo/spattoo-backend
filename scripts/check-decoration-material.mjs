#!/usr/bin/env node
// ── What a decoration is made of must survive every hop ─────────────────────────────────────────
//
// The vision model reads a material off the photo. Between there and the build guide it passes
// through THREE reshapes, and each is an explicit field list — so a field not named is not null,
// it is ABSENT, and every reader downstream sees "the model did not say" rather than "we dropped
// it". The two are indistinguishable at the far end, which is what made this expensive:
//
//   analyzeCake            → { type, material, color_hex, placement, bbox, … }
//   inspirationMatch:93    → decoration: { type, subtype, placement, … }   ← material was MISSING
//   buildXraySpec          → unidentified[].material / stickers[].seen.material
//   suggestBuildGuide      → the prompt's material branch
//
// On 2026-09-21 a baker was shown six steps of rolling fondant for a WAFER PAPER flower. The model
// had identified it correctly; the matcher's projection had never listed `material`, because until
// that day nothing read it. Nothing failed, no test broke, and the guide looked entirely plausible
// — it was simply a guide to a different craft.
//
// Same shape as check:notify-contact, which guards a PostgREST projection for the same reason: a
// select that omits a column makes the absence look like a legitimate empty value.
//
// Pure text reading. Run via `npm run check:decoration-material`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
                     .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

// ── 1. The matcher's projection names it ────────────────────────────────────────────────────────
// THE hop that lost it. Everything a tier decoration carries passes through this object literal.
const match = code(read('src/services/inspirationMatch.js'));
const proj = match.match(/decoration:\s*\{[^}]*\}/);
ok(!!proj, 'inspirationMatch still projects a `decoration` object');
if (proj) {
  ok(/\bmaterial\s*:/.test(proj[0]),
     'the matcher carries `material` through to the spec builder',
     'a field missing from this literal is ABSENT downstream, not null — and reads as "the model did not say"');
  // The fields the rest of the pipeline is known to need. Listed so removing one fails here rather
  // than in a guide a baker follows.
  for (const f of ['type', 'placement', 'color_hex', 'bbox']) {
    ok(new RegExp(`\\b${f}\\s*:`).test(proj[0]), `the matcher still carries \`${f}\``);
  }
}

// ── 2. The spec builder records it on BOTH halves ───────────────────────────────────────────────
// Matched decorations become stickers; unmatched ones become `unidentified`. A build guide is
// offered for both now, so both need the material — and the unmatched half needs it MORE, because
// there is no element with an authored medium to fall back on.
const spec = code(read('src/services/xraySpec.js'));
const unidentifiedPushes = [...spec.matchAll(/unidentified\.push\(\{[\s\S]*?\}\);/g)].map(m => m[0]);
ok(unidentifiedPushes.length >= 2, 'both unidentified paths are present', `${unidentifiedPushes.length} found`);
unidentifiedPushes.forEach((p, i) => {
  ok(/material\s*:/.test(p), `unidentified push #${i + 1} records the material`);
  ok(/key\s*:/.test(p), `unidentified push #${i + 1} records a stable key`,
     'without one the entry cannot be addressed and no guide can be built for it');
});
const seen = spec.match(/seen:\s*\{[\s\S]*?\n\s{8}\}/);
ok(!!seen && /material\s*:/.test(seen[0]),
   'a matched sticker keeps the photo-read material beside what it matched to',
   'most of the catalogue has no authored medium, and a read beats the sugar-paste default');

// ── 3. The prompt distinguishes authored from inferred from unknown ─────────────────────────────
// Collapsing these is how "MATERIAL: sugar" and "No material was stated" ended up in one prompt.
const ai = code(read('src/services/openai.js'));
ok(/inferred/.test(ai), 'the guide prompt knows a material can be INFERRED rather than authored');
ok(/READ FROM THE PHOTOGRAPH/.test(read('src/services/openai.js')),
   'and says so to the model, rather than presenting a reading as fact');

// ── 4. The TECHNIQUE travels too, and outranks the material ────────────────────────────────────
// One material, several crafts: buttercream is piped through a nozzle AND pressed with a palette
// knife, so `cream.build_note` names both and settles neither. The technique lives on the element
// TYPE (migration 104) and has to reach the prompt, or a knife guide comes back describing nozzles.
// Each hop is asserted separately because the chain broke silently once already — the matcher
// dropped `material` and a wafer-paper flower got a gumpaste guide.
const guideSvc = read('src/services/decorationGuide.js');
ok(/technique\s*:/.test(guideSvc), 'the guide service passes a technique to the prompt');
ok(/element_types\?\.build_note|element_types\.build_note/.test(guideSvc),
   'and takes it from the element TYPE, where technique lives (migration 104)');
for (const f of ['src/routes/craftGuide.js', 'src/routes/elements.js']) {
  ok(/element_types\(name,\s*build_note\)/.test(read(f)),
     `${f} selects the type's build_note`, 'a column not selected is a column the prompt never sees');
}
ok(/technique\s*=\s*null/.test(ai), 'the prompt accepts a technique');
ok(/OUTRANKS/.test(read('src/services/openai.js')),
   'and tells the model the technique beats the material, not the other way round');

console.log(failures
  ? `\n✗ check:decoration-material — ${failures} failure(s).`
  : '\n✓ check:decoration-material — material and technique both survive the matcher, the spec and the prompt');
process.exit(failures ? 1 : 0);
