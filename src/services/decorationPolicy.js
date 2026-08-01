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

  // Cream, in either technique. The nozzle guide already covers piping; palette-knife work needs a
  // guide format of its own, and the fondant one is written for sugar paste and would read wrongly.
  if (CREAM_TYPES.has(type)) {
    return { modelling: false, print: false, reason: 'cream — nozzle guide covers this' };
  }

  if (STICKER_TYPES.has(type)) {
    switch (el?.medium) {
      // The substitution case: hand-model it, or print it. Both, always.
      case 'fondant':      return { modelling: true,  print: true,  reason: 'fondant' };
      case 'chocolate':    return { modelling: false, print: true,  reason: 'chocolate — no guide format yet' };
      // There is no hand-modelled version of a printed sheet. A modelling guide here would invent
      // a process.
      case 'edible_paper': return { modelling: false, print: true,  reason: 'printed sheet' };
      // Bought, not made.
      case 'acrylic':      return { modelling: false, print: false, reason: 'acrylic — not made by hand' };
      // Not stated. Offer both and let the model answer: it self-reports when something is not
      // hand-made, returning empty steps and saying so, which costs at most one generation.
      default:             return { modelling: true,  print: true,  reason: 'medium not stated' };
    }
  }

  // An unrecognised or absent type. Same reasoning as an unset medium — let the model answer
  // rather than silently withholding a guide because our type list has fallen behind the catalogue.
  return { modelling: true, print: true, reason: 'type not recognised' };
}
