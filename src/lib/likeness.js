// ── Never send a person's face to an image model ─────────────────────────────────────
// One predicate, because the rule has to hold at every point an image generation is reached and a
// rule spread across call sites is a rule with a hole in it.
//
// ── WHY ─────────────────────────────────────────────────────────────────────────────
// OpenAI's usage policy forbids using visual capabilities to identify a person, to infer private
// or sensitive information about one, or to "reproduce the likeness of any person without express
// consent". That is an obligation on US, not on the baker: the ToS makes the baker warrant they
// hold consent for every identifiable person in an upload (prohibited-uses list, B5.6), and that
// settles who is liable to whom — it does not make an API call compliant.
//
// The exposure is specific and it is real. `generateDecorationStages` runs `/v1/images/edits` with
// `input_fidelity: 'high'`, deliberately, so the sheet shows THIS bow rather than a stock one. Hand
// it a crop of a photo cake and that same fidelity reproduces a child's face. The consent we hold
// is the baker's warranty; the person in the photograph never agreed to be re-rendered by a model.
//
// The admin extract path is already covered — `/admin/element-extract/identify` calls
// validateCakeImage first, which rejects any image with a person in it. The X-Ray decoration-steps
// path had no equivalent: it reads the order's reference photo, crops a decoration out of it and
// generates. This is that equivalent.
//
// ── WHY A PRINTED PHOTO IS NOT SILENTLY DROPPED ─────────────────────────────────────
// The obvious fix is to tell the vision model to ignore photographs on the cake. That is wrong for
// the same reason harvest.js gives about the checklist: the report claims to describe EVERYTHING on
// the cake, so a decoration that quietly disappears makes the report lie about the cake in front of
// the baker. A photo print is a real feature — it is the whole point of a photo cake — and the tin
// plan and placeables list should say so.
//
// So the model classifies it (`photo_print`) and X-Ray shows it. What is refused is one narrow
// thing: turning that crop into a generated picture. The baker loses nothing they needed, because
// there is no craft technique to teach — an edible sheet is printed, not modelled by hand.

// Decoration TYPES that depict a person, or may. `photo_print` is the type analyzeCake is told to
// use for a photograph printed on an edible sheet; the others are the types a printed portrait
// would most plausibly be filed under before that type existed, and rows written then are still in
// the database.
const RISKY_TYPES = new Set(['photo_print', 'photo', 'portrait', 'edible_print', 'printed_image']);

// Words that give away a person, checked against the label and description. A backstop, not the
// mechanism: the type is the answer, and this catches a model that picked `other` and then wrote
// "printed photo of a smiling boy" in the notes — which is exactly what a model does when the
// vocabulary has no box for what it can see.
//
// Deliberately blunt, and deliberately biased toward refusing. A false positive costs a baker one
// stage sheet for a decoration that has no technique to teach anyway; a false negative sends a
// child's face to an image model. Those are not comparable, so this does not try to be clever.
const RISKY_WORDS = [
  'photo', 'photograph', 'portrait', 'selfie', 'picture of',
  'face', 'person', 'people', 'child', 'baby', 'boy', 'girl',
  'man', 'woman', 'couple', 'bride', 'groom', 'family', 'headshot',
];

const words = (s) => String(s ?? '').toLowerCase();

/**
 * Would generating a picture from this decoration risk reproducing a person's likeness?
 *
 * Takes the shape X-Ray stores: `{ type, subtype, seen: { what }, name, label, notes }`. Every
 * field is optional — a spec row written before `photo_print` existed carries none of them — and an
 * empty decoration is not a risk, because there is nothing to say it is one.
 */
export function isLikenessRisk(decoration) {
  if (!decoration) return false;

  const type = words(decoration.type ?? decoration.element_kind);
  if (RISKY_TYPES.has(type)) return true;

  // `seen.what` is what the model actually described, as opposed to `name`, which is whatever
  // library element it matched to. The description is the honest field and the one worth reading:
  // a printed photo that matched some pink fondant topper would carry the topper's NAME.
  const haystack = [
    decoration.subtype,
    decoration.seen?.what,
    decoration.label,
    decoration.name,
    decoration.notes,
    decoration.prompt,
  ].map(words).join(' ');

  return RISKY_WORDS.some(w => haystack.includes(w));
}

// What to tell the baker. Not an error and not a failure — the decoration is on their cake, X-Ray
// still shows it, and there is genuinely nothing to teach about it. Saying so plainly beats a
// silent absence, which reads as the feature being broken.
export const LIKENESS_REFUSAL = {
  code: 'PRINTED_PHOTO',
  message: 'This is a printed edible image, not a decoration made by hand — there are no steps to '
         + 'show. Print it on an edible sheet in the Edible Print Studio.',
};
