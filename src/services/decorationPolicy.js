// ── What a decoration is, and what may be offered for it ─────────────────────────────
// PURE. No imports, so the policy can be exercised without a database, a provider or an env file —
// the same reason inspirationMaps.js holds the match gates rather than inspirationMatch.js. These
// are decisions about our own catalogue, and a decision that is expensive to test does not get
// tested.

// The formats OpenAI's vision endpoint accepts. Anything else is a hard invalid_image_format, not
// a degraded answer.
const VISION_FORMATS = /\.(png|jpe?g|gif|webp)(\?|$)/i;

// Which stored key do we hand the model?
//
// NOT image_url on its own, which is the SOURCE asset: for a library element that is frequently a
// .glb or an .svg, and OpenAI rejects both outright. thumbnail_url and thumb_key are always raster
// — written by services/thumbnails.js as WebP with an image/webp content-type — which is why
// autoTag, the one OpenAI-by-URL path already proven in production, feeds the thumbnail.
//
// Ordered best-detail-first: the source when it happens to be a usable raster (a baker's own
// uploaded decoration is a PNG, sharper than any thumbnail we derive), then the master thumbnail,
// then the size-suffixed one. Extension-checked rather than assumed, so a new asset type added
// later degrades to the thumbnail instead of failing at the provider.
export function visionImageKey(el) {
  return [el?.image_url, el?.thumbnail_url, el?.thumb_key].find(k => k && VISION_FORMATS.test(k)) ?? null;
}

// ── The parts we already know, because we authored them ──────────────────────────────
//
// A decoration recomposed in admin carries its own part map: `placement_config._model.groups`, one
// entry per recolourable area, with the label and the hex that was authored for it. A fondant doll
// has six — Hair, Body, Dress, Shoe, Eyes, Eyebrows.
//
// ⚠️ THE BUILD GUIDE WAS GUESSING ALL OF THAT FROM A THUMBNAIL. The prompt asks the model to invent
// `roles` and to read one hex per role "you can SEE on this decoration" — which is exactly this
// list, derived by looking instead of by reading. The reported result: no steps for the hair, no
// steps for the shoes (they are barely visible from the one angle we send), and a stage picture
// that put the dress colour on the doll's face because nothing anchored it to a real part.
//
// Returned as prompt-ready role TOKENS, because the guide's own contract is lowercase tokens
// ("body", "inner_ear") written as {body} inside instructions — a role called "Hair" would not
// match, and a mismatch is silent.
//
// Absent for anything not recomposed (most elements), and the caller falls back to the old
// look-and-guess behaviour — which is right for a decoration nobody has segmented.
export function knownRoles(el) {
  const groups = el?.placement_config?._model?.groups;
  if (!Array.isArray(groups)) return [];
  const seen = new Set();
  const out = [];
  for (const g of groups) {
    const role = String(g?.key ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    if (!role || seen.has(role)) continue;
    seen.add(role);
    const hex = typeof g?.default === 'string' && /^#[0-9a-f]{6}$/i.test(g.default.trim())
      ? g.default.trim().toLowerCase()
      : null;
    out.push({ role, label: String(g?.label ?? g?.key ?? '').trim() || role, hex });
  }
  return out;
}

// ── What may be offered for this decoration ──────────────────────────────────────────
// ELEMENT TYPE IS THE PRIMARY SIGNAL, and `medium` only speaks where the type genuinely cannot.
//
// Most types answer the question by themselves. A 'Cream Piping' element is cream, worked with a
// nozzle — its material was never in doubt, and its guidance is the curated nozzle recommendation,
// not a modelling guide. 'Palette knife art' is the same material worked a different way, which is
// exactly why technique lives in the TYPE and not in the medium column (migration 032).
//
// The ambiguity is confined to FLAT PLACEABLES — the stickers and toppers, where the stored asset
// is a 2D image and the picture alone cannot tell you whether the real thing is hand-modelled
// fondant, a printed icing sheet, or a bought acrylic. That is the only place `medium` is read.
//
// Type names rather than ids: TYPE_MAP in inspirationMaps.js already keys on them, so this follows
// existing practice rather than inventing a second convention.
const CREAM_TYPES   = new Set(['Cream Piping', 'Palette knife art']);
const STICKER_TYPES = new Set(['Cake Topper', 'Image topper', 'Top&Side Decors', 'Scattered Decor']);

// FLAT or IN THE ROUND. The two crafts share almost no steps — one is "roll a sheet and cut the
// outline", the other is "roll a ball and pinch out a tail" — so a guide written for the wrong one
// is not roughly right, it is unusable. A real generation for a flat sticker came back as
// instructions for sculpting a standing figurine, and the picture agreed with it.
//
// THE ASSET DECIDES, not the type name. A .glb is a three-dimensional model and renders as one on
// the cake; anything else is a 2D image lying flat on it. That is a structural fact about the file
// we hold, so it cannot fall behind the catalogue the way a hand-kept list of type names does —
// and it already did: the first version keyed on TYPE_MAP's names, which are a subset of the real
// element_types, so any type not in that list silently got no instruction at all.
//
// The type list survives only as a fallback for the case the asset cannot answer: no image yet.
const MODEL_ASSET = /\.(glb|gltf)(\?|$)/i;

export function decorationDimension(el) {
  const asset = el?.image_url ?? '';
  if (MODEL_ASSET.test(asset)) return '3d';
  if (asset) return '2d';

  // No asset to judge. A sticker type is still flat by definition — it is a 2D image placed on the
  // cake, which is the same fact that makes its MATERIAL ambiguous and gave us the medium column.
  const type = el?.element_types?.name ?? el?.element_type ?? null;
  if (STICKER_TYPES.has(type)) return '2d';

  // Genuinely unknown. Say nothing rather than guess: the prompt then falls back to its own
  // judgement, which is better than being told the wrong thing with confidence.
  return null;
}

// Returns { modelling, print, reason } — what X-Ray may offer for this decoration.
//
// `print` is deliberately generous. Printing a decoration at actual size is a real option for
// anything flat, and a baker substitutes a print for hand-modelling constantly: for time, for a
// customer's budget, or because the cake is travelling. Withholding it would take away a decision
// that is theirs to make.
//
// `modelling` is the narrow one, because offering a way to hand-make something nobody hand-makes
// is worse than offering nothing.
export function decorationPolicy(el) {
  const type = el?.element_types?.name ?? el?.element_type ?? null;

  // ── Ready-made: not MADE, but often still PRINTED ─────────────────────────────────────────────
  // Ticked in admin: a faux ball, a bought topper, a wafer butterfly. Every other branch here INFERS
  // whether something is hand-made from what it is made of; this is somebody saying so outright, and
  // a statement beats an inference. So `modelling` is off, and it is decided FIRST — without that an
  // admin could tick the box, generate a guide anyway, SPEND THE CREDITS, and have the result hidden
  // by the fetch filter.
  //
  // `print` is deliberately NOT forced off with it, and that distinction is the whole point:
  // "you do not make this" and "you cannot print this" are different claims. Butterflies are mostly
  // bought AND routinely printed on wafer paper, so "print it at actual size instead" is the most
  // useful thing the sheet can say once the modelling guide is refused. Suppressing it would answer
  // a baker's question with silence.
  //
  // Where print genuinely is impossible the MEDIUM already says so — `acrylic` returns print:false —
  // and that answer is preserved by falling through rather than short-circuiting. It also does not
  // replace `medium`: that says what a thing is made of, this says you do not make it, and a fondant
  // ball bought pre-rolled is both.
  const readyMade = !!el?.placement_config?.ready_made;
  const settle = (r) => (readyMade
    ? { ...r, modelling: false, reason: `ready-made — bought, not made (${r.reason})` }
    : r);

  // Cream, in either technique. The nozzle guide already covers piping; palette-knife work needs a
  // guide format of its own, and the fondant one is written for sugar paste and would read wrongly.
  if (CREAM_TYPES.has(type)) {
    return settle({ modelling: false, print: false, reason: 'cream — nozzle guide covers this' });
  }

  if (STICKER_TYPES.has(type)) {
    switch (el?.medium) {
      // The substitution case: hand-model it, or print it. Both, always.
      case 'fondant':      return settle({ modelling: true, print: true, reason: 'fondant' });
      case 'chocolate':    return settle({ modelling: false, print: true, reason: 'chocolate — no guide format yet' });
      // There is no hand-modelled version of a printed sheet. A modelling guide here would invent
      // a process.
      case 'edible_paper': return settle({ modelling: false, print: true, reason: 'printed sheet' });
      // Bought, not made.
      case 'acrylic':      return settle({ modelling: false, print: false, reason: 'acrylic — not made by hand' });
      // Not stated. Offer both and let the model answer: it self-reports when something is not
      // hand-made, returning empty steps and saying so, which costs at most one generation.
      default:             return settle({ modelling: true, print: true, reason: 'medium not stated' });
    }
  }

  // An unrecognised or absent type. Same reasoning as an unset medium — let the model answer
  // rather than silently withholding a guide because our type list has fallen behind the catalogue.
  return settle({ modelling: true, print: true, reason: 'type not recognised' });
}
