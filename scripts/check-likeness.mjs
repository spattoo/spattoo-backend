// ── A person's face never reaches an image model ────────────────────────────────────────────────
// OpenAI's usage policy forbids reproducing "the likeness of any person without express consent".
// Two of its three limbs we are clearly clear of — we never ask a model to identify anyone, and we
// never ask for private or sensitive information. The third has no intent test: it is about what
// comes OUT. generateDecorationStages runs /v1/images/edits at `input_fidelity: 'high'`, which
// exists precisely to reproduce the reference faithfully, so a crop containing a face produces that
// face whatever we were aiming at.
//
// Every failure here is silent in production. The guard not running does not error, does not log,
// and produces a plausible-looking stage sheet — the only signal is a face on it, which nobody on
// our side ever sees.
//
// Run via `npm run check:likeness` (in `npm run check`).

import { readFileSync } from 'node:fs';
import { isLikenessRisk, LIKENESS_REFUSAL } from '../src/lib/likeness.js';

let failed = 0;
const ok  = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };
const yes = (d, m) => (isLikenessRisk(d) ? ok(m) : bad(`${m} — expected a refusal, got through`));
const no  = (d, m) => (isLikenessRisk(d) ? bad(`${m} — expected to pass, got refused`) : ok(m));

// ── 1. The type is the answer ───────────────────────────────────────────────────────────────────
// `photo_print` is what analyzeCake is told to use. The rest are what a printed portrait was
// plausibly filed under before that type existed — those rows are still in xray_spec jsonb, and a
// guard that only knew the new name would let every one of them through.
console.log('photo types are refused');
yes({ type: 'photo_print' },   'photo_print (the type the prompt now asks for)');
yes({ type: 'photo' },         'photo');
yes({ type: 'portrait' },      'portrait');
yes({ type: 'edible_print' },  'edible_print');
yes({ type: 'printed_image' }, 'printed_image');
yes({ element_kind: 'photo_print' }, 'element_kind, not just type — candidates use the other name');

// ── 2. The description is the backstop ──────────────────────────────────────────────────────────
// A model with no box for what it can see picks `other` and explains itself in prose. That is not a
// hypothetical: it is the normal failure mode of a closed vocabulary, and it is exactly how a face
// would have reached the image model before `photo_print` existed.
console.log('a person described in prose is refused, whatever the type says');
yes({ type: 'other', seen: { what: 'printed photograph of a boy' } }, 'seen.what — what the model actually described');
yes({ type: 'topper', notes: 'a photo of the birthday girl' },        'notes');
yes({ type: 'other', label: 'Family portrait print' },                 'label');
yes({ type: 'other', prompt: 'a picture of a smiling child' },         'prompt');
// `name` is the LIBRARY ELEMENT matched to, which can be confidently wrong — a printed photo that
// matched some pink fondant topper carries the topper's name. Checked anyway: it costs nothing and
// the whole point of this gate is that being wrong in this direction is cheap.
yes({ type: 'other', name: 'Bride and groom photo' },                  'name');

// ── 3. Real decorations still get their guide ───────────────────────────────────────────────────
// The word list is deliberately blunt, so this is the half that has to be checked. A gate that
// refused everything would pass section 2 forever and quietly kill a paid feature.
console.log('ordinary decorations are not refused');
no({ type: 'rosette', seen: { what: 'buttercream rosette' } },        'rosette');
no({ type: 'piping_border', subtype: 'shell' },                        'shell border');
no({ type: 'ribbon_bow', seen: { what: 'fondant bow' } },              'fondant bow');
no({ type: 'flower', notes: 'sugar peony, wired' },                    'sugar flower');
no({ type: 'lettering', text: 'Happy Birthday Aarav' },                'lettering — a NAME is not a likeness');
no({ type: 'figurine', seen: { what: 'fondant unicorn' } },            'a modelled figurine is the feature, not a photo');
no({},                                                                 'an empty decoration says nothing, so it is not a risk');
no(null,                                                               'null');

// ── 4. The guard is wired, and wired BEFORE the credit is spent ─────────────────────────────────
// Order matters and is invisible at runtime: a guard placed after withAiCredits still refuses, but
// the baker has been charged and the idempotency key taken — so the retry they are told to make
// returns the same refusal forever, against a credit they cannot get back.
{
  const src = readFileSync(new URL('../src/routes/xraySpec.js', import.meta.url), 'utf8');
  const guard  = src.indexOf('isLikenessRisk');
  const spend  = src.indexOf('withAiCredits(');
  if (guard === -1) bad('routes/xraySpec.js does not call isLikenessRisk — decoration steps are unguarded');
  else if (spend === -1) bad('routes/xraySpec.js no longer calls withAiCredits — this gate cannot check the order');
  else if (guard > spend) bad('the likeness guard runs AFTER withAiCredits — a refusal would charge a credit');
  else ok('the guard runs before withAiCredits, so a refusal costs nothing');

  if (src.includes('LIKENESS_REFUSAL')) ok('the refusal says why, rather than returning an empty guide');
  else bad('routes/xraySpec.js does not use LIKENESS_REFUSAL — a silent refusal reads as a broken feature');
}

// ── 5. The vision prompt classifies a printed photo, and says nothing about who is in it ────────
// The image guard stops a face being REPRODUCED. This stops one being DESCRIBED: without a box for
// it, a model writes "printed photo of a smiling boy" into notes, and that lands in xray_spec jsonb
// and renders in the report — personal data about a real child that we had no purpose for.
{
  const src = readFileSync(new URL('../src/services/openai.js', import.meta.url), 'utf8');
  if (src.includes('photo_print')) ok('analyzeCake offers a photo_print type');
  else bad('analyzeCake has no photo_print type — a printed photo falls into "other" and is described in prose');

  // \s+ across the whole phrase: the prompt is a wrapped template literal, so any word boundary in
  // it may be a newline plus indentation. A literal-space regex passes today and fails the first
  // time somebody reflows the paragraph, which would report the rule as missing when it is present.
  const saysNothingAboutThePerson = /Do\s+NOT\s+describe,\s+name,\s+characterise\s+or\s+guess\s+at\s+anyone/;
  if (saysNothingAboutThePerson.test(src)) ok('and is told to describe nobody in it');
  else bad('analyzeCake is not told to leave the person out of its description');
}

// ── 6. The refusal is a sentence a baker can act on ─────────────────────────────────────────────
if (LIKENESS_REFUSAL.code && LIKENESS_REFUSAL.message?.length > 40) ok('the refusal carries a code and an explanation');
else bad('LIKENESS_REFUSAL is too thin to render');

if (failed) {
  console.error(`\n✗ check:likeness — ${failed} failure(s)`);
  process.exit(1);
}
console.log('\n✓ check:likeness — no path sends a person to an image model, and none describes one');
