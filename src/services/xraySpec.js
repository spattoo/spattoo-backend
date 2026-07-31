// ── analyzeCake + matchAnalysis → design_snapshot ────────────────────────────────────
// The mapper behind X-Ray for orders that have no design. A manual order carries reference
// photos and design_snapshot = null, so every X-Ray reader (tin plan, colour recipes, nozzle
// guides, the placeables checklist) has nothing to walk. This turns what the vision model saw
// into the SAME shape the 3D designer saves, and the entire existing X-Ray pipeline then runs
// over it unchanged.
//
// Rationale + why an estimate is never written into design_snapshot itself:
// migrations/022_ai_credits_ledger.sql, and docs (spattoo-core) AI_CREDITS_PLAN.md §1.2.
//
// PURE. No model calls, no DB, no I/O — inputs are the two service outputs, output is jsonb.
// That is deliberate: this file encodes every judgement about how a photo becomes a buildable
// spec, and those judgements need to be testable without spending a credit to run them.
//
// ── THE ONE RULE THAT MATTERS ───────────────────────────────────────────────────────
// Never invent. A decoration the matcher could not confidently identify becomes an explicit
// "unidentified" entry, never a guessed piping. harvest.js is blunt about why:
//
//   "A checklist makes a claim the rest of the report does not: that this is EVERYTHING. If it
//    enumerates six collections and the design grows a seventh, the sheet quietly gets shorter,
//    the baker trusts it, and a decoration ships missing. A checklist that silently omits is
//    worse than no checklist, because it is believed."
//
// The same trap, one step earlier. A confidently-wrong piping sends a baker to the wrong nozzle;
// a silently-dropped topper ships a cake without its topper. Both are worse than a line reading
// "we could not identify this — check the photo".

import { isMatchable } from './inspirationMaps.js';

// analyzeCake's cake.shape vocabulary → the only two footprints anything downstream understands.
// computeTinPlan's isSquare() tests shape === 'rect' | 'square' and the tin chart has exactly two
// columns (round, and round × 1.27 for square), so heart/number/sculpted have nowhere to go. They
// map to round — the closest tin a baker would actually reach for — and the shape is reported in
// the meta so the sheet can say the footprint was not recognised rather than implying it was.
const SHAPE_MAP = { round: 'round', square: 'square', rect: 'square' };
const UNMAPPED_SHAPES = new Set(['heart', 'number', 'sculpted', 'other']);

// analyzeCake placement → the zone string stickers carry (useCakeDesign addSticker).
const ZONE_MAP = {
  top_surface: 'top_surface',
  side:        'side',
  middle_tier: 'side',
  rim:         'rim',
  board:       'board',
};

const hex = (v) => {
  const m = String(v ?? '').trim().match(/^#?([0-9a-fA-F]{6})$/);
  return m ? `#${m[1].toLowerCase()}` : null;
};

// [x, y, w, h] as fractions of the image. Rejected wholesale unless every number is present, in
// range, and describes a box with area — a partially-valid box would crop to the wrong place, and
// the sheet is better with no close-up than with a picture of the wrong decoration. A generous
// pad is applied at crop time, not here: this stays the model's raw claim.
const bbox = (v) => {
  const a = Array.isArray(v) ? v : null;
  if (!a || a.length !== 4) return null;
  const [x, y, w, h] = a.map(Number);
  if (![x, y, w, h].every(n => Number.isFinite(n))) return null;
  if (w <= 0 || h <= 0) return null;
  if (x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) return null;
  return [x, y, w, h].map(n => +n.toFixed(4));
};

// A plain 0-1 fraction, or null. Unlike `ratio` there is no fallback: a missing size must stay
// missing rather than silently becoming a default the baker would cut fondant to.
const unitRatio = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1 ? +n.toFixed(3) : null;
};

const ratio = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
};

// A rim decoration goes to topPipings or bottomPipings — the two lists harvestPiping() reads as
// "Rim" and "Base". rim_side is the only signal, and analyzeCake is told to set it whenever
// placement is 'rim'. Missing → treat as a top border, which is the overwhelmingly common case
// (a base border sits where the cake meets the board and is far less often the only one).
const isRimPiping = (d) => d?.placement === 'rim';
const rimList = (d) => (d?.rim_side === 'bottom' ? 'bottomPipings' : 'topPipings');

// ── Tier geometry ───────────────────────────────────────────────────────────────────
// Only RATIOS reach computeTinPlan (tierVolume is "arbitrary design units — only the RATIO
// between tiers matters"), and the real total comes from order.weight_kg. So the ratios are
// written straight in as the geometry, with no attempt to invent inches.
//
// Round tiers are sized by `radius`, everything else by width/depth — the same split
// starterDesign() makes, and tierVolume() reads whichever its family uses. Depth is set equal to
// width: a single photo cannot show a rectangular cake's depth, and assuming square is both the
// honest default and the one that keeps the volume ratio sane.
function mapTier(t, shape, index) {
  const h = ratio(t?.height_ratio, 1);
  const w = ratio(t?.width_ratio, Math.pow(0.62, index));   // same taper computeTinPlan falls back to
  const square = shape === 'square';
  return {
    shape,
    color: hex(t?.frosting?.base_color_hex) ?? '#ffffff',
    // Frosting type/finish are not read by X-Ray today, but they are what the customer asked for
    // and they cost nothing to carry — a later reader (or the baker's own eye) wants them.
    frostingType:  t?.frosting?.type   ?? null,
    frostingStyle: t?.frosting?.finish ?? null,
    height: h,
    ...(square ? { width: w, depth: w } : { radius: w / 2 }),
    topPipings: [],
    bottomPipings: [],
    creamLayers: [],
  };
}

// ── The mapper ──────────────────────────────────────────────────────────────────────
//   analysis  — analyzeCake() output
//   matched   — matchAnalysis(analysis) output
// Returns { snapshot, coverage } where `snapshot` is design_snapshot-shaped and `coverage` is
// the honesty report that belongs in xray_spec_meta.
export function buildXraySpec(analysis, matched) {
  const rawShape = String(analysis?.cake?.shape ?? 'round').toLowerCase();
  const shape    = SHAPE_MAP[rawShape] ?? 'round';

  const srcTiers = Array.isArray(analysis?.tiers) ? analysis.tiers : [];
  const tiers    = srcTiers.map((t, i) => mapTier(t, shape, i));
  if (!tiers.length) tiers.push(mapTier({}, shape, 0));

  const stickers     = [];
  const texts        = [];
  const unidentified = [];

  // matchAnalysis returns one entry per tier, in the same order, each holding the per-decoration
  // match. Walk them together so a decoration keeps the tier it was seen on — the checklist has to
  // say WHICH tier the topper goes on or it saves nobody a decision.
  const matchTiers = Array.isArray(matched?.tiers) ? matched.tiers : [];

  srcTiers.forEach((srcTier, tierIndex) => {
    const mt    = matchTiers.find(m => m.index === (srcTier.index ?? tierIndex)) ?? matchTiers[tierIndex];
    const items = Array.isArray(mt?.matches) ? mt.matches : [];

    items.forEach((item, k) => {
      const d = item?.decoration ?? {};
      const m = item?.match;

      // No confident match. Recorded, never guessed at. TWO gates can produce this: the composite
      // score (0.35) or the semantic floor (0.45) — and they mean different things. A low
      // composite is "nothing in the library is close". A high composite with a low semantic is
      // "something sits in the right place in the right colour, but is not this object" — which is
      // exactly the bow that matched a fondant doll. Both scores travel so the two are separable.
      if (!m?.id) {
        unidentified.push({
          what:       [d.type, d.subtype].filter(Boolean).join(' ').replace(/_/g, ' ') || 'decoration',
          tierIndex,
          placement:  d.placement ?? null,
          color:      hex(d.color_hex),
          confidence: item?.confidence ?? 0,
          semantic:   item?.semantic ?? 0,
          bbox:       bbox(d.bbox),
        });
        return;
      }

      const colour = hex(d.color_hex) ?? hex(m.default_color) ?? null;

      // A rim border is PIPING — the one decoration class X-Ray treats specially, because its
      // element id is what fetchCraftGuides() resolves into a real nozzle recommendation.
      if (isRimPiping(d)) {
        tiers[tierIndex]?.[rimList(d)].push({
          id:    m.id,               // the field harvestPiping() reads → craft guide lookup
          name:  m.name ?? 'Piping',
          color: colour ?? '#ffffff',
        });
        return;
      }

      // Everything else is a placeable.
      stickers.push({
        id:        `est-${tierIndex}-${k}`,
        elementId: m.id,
        name:      m.name ?? 'Decoration',
        imageUrl:  m.image_url ?? null,
        zone:      ZONE_MAP[d.placement] ?? 'top_surface',
        tierIndex,
        color:     colour,
        // WHAT THE MODEL ACTUALLY SAW, kept alongside what it matched to. `name` above is the
        // LIBRARY ELEMENT's name, and matching can be confidently wrong: zone, type, colour and
        // mode contribute 0.60 of the score against a 0.35 floor, so a pink fondant topper
        // certifies as any other pink fondant topper. A real cake's bow matched "Fondant doll 1".
        //
        // Decoration steps read the photo and must be told what to look for, so they need the
        // description rather than the match — asking for the doll on a cake that has a bow is how
        // a wrong match becomes a wrong answer the baker pays for.
        seen: {
          what:      [d.type, d.subtype].filter(Boolean).join(' ').replace(/_/g, ' ') || 'decoration',
          color:     hex(d.color_hex),
          placement: d.placement ?? null,
          // Where it is IN THE PHOTO, so the sheet can show a close-up of the real decoration
          // instead of describing it. Null whenever the model would not commit — a wrong crop
          // shows the baker a picture of the wrong thing, which is worse than showing none.
          bbox:      bbox(d.bbox),
          // Width as a fraction of its tier, which is what turns a photo into a real measurement:
          // the tin plan knows the tier's actual diameter, so ratio x diameter is the decoration's
          // true size. Null is common and fine — a border has no single width, and a template
          // printed at the wrong size is worse than none because the baker cuts to it.
          tierWidthRatio: unitRatio(d.tier_width_ratio),
        },
      });
    });
  });

  // ── Cake-level types the matcher deliberately skips ───────────────────────────────
  // inspirationMaps.NON_MATCHED_TYPES excludes 'drip' and 'lettering' from element matching — they
  // are cake properties, not library elements. They still have to reach the sheet:
  //   * lettering is the MESSAGE ON THE CAKE. Dropping it is the single most visible omission
  //     available to us, and it never appears in `matches`, so it is exactly the kind of thing an
  //     enumerator written in a hurry loses.
  //   * a drip is a colour the baker has to mix, and harvestColors only sees colours attached to
  //     something — so it rides in as a placeable to reach both the colour table and the checklist.
  //
  // Read from `analysis`, NOT from matched.nonMatched: that array carries only
  // { type, placement, note } (inspirationMatch.js) — the text and the colour, which are the whole
  // reason these two need handling, are dropped on the way through. It also has no tier, and a
  // drip belongs to the tier it runs down.
  //
  // isMatchable is imported rather than restated so the set of skipped types has ONE definition.
  // If a third cake-level type is ever added there, this loop sees it and the `default` branch
  // below records it as unidentified instead of silently swallowing it.
  srcTiers.forEach((srcTier, tierIndex) => {
    (srcTier?.decorations ?? []).forEach((d, i) => {
      if (isMatchable(d?.type)) return;   // already handled via matchAnalysis above

      if (d.type === 'lettering') {
        const content = String(d.text ?? '').trim();
        if (!content) return;
        texts.push({
          id: `est-text-${tierIndex}-${i}`,
          content,
          color: hex(d.color_hex) ?? '#ffffff',
        });
        return;
      }

      if (d.type === 'drip') {
        stickers.push({
          id: `est-drip-${tierIndex}-${i}`,
          elementId: null,                       // not a library element — nothing to look up
          name: 'Drip',
          zone: ZONE_MAP[d.placement] ?? 'rim',
          tierIndex,
          color: hex(d.color_hex),
        });
        return;
      }

      // A cake-level type this mapper has no case for. Surfaced, never dropped.
      unidentified.push({
        what:       String(d.type ?? 'decoration').replace(/_/g, ' '),
        tierIndex,
        placement:  d.placement ?? null,
        color:      hex(d.color_hex),
        confidence: 0,
      });
    });
  });

  const snapshot = {
    // Marks every downstream reader. NEVER omit — the printed sheet has to be able to say this was
    // read off a photo rather than measured, and a baker must never mistake the two.
    source: 'photo',
    tiers,
    texts,
    ages: [],
    stickers,
    // `writing` is the designer's ONE cream-pen message. An estimate never sets it: analyzeCake
    // reports lettering without saying whether it was piped by hand or a printed/fondant topper,
    // and texts[] carries either honestly. harvestPlaceables reads both, so nothing is lost.
    writing: null,
    piping: [],        // freehand cream-pen strokes: not inferable, and craft guides cover nozzles
  };

  const cov = matched?.coverage ?? {};
  const coverage = {
    decorationsSeen:      cov.total ?? 0,
    decorationsIdentified: cov.matched ?? 0,
    unidentified,
    // Surfaced so the sheet can say "this cake's footprint was not recognised; the tin plan
    // assumes round" instead of quietly pretending a heart cake is a circle.
    shapeRecognised: !UNMAPPED_SHAPES.has(rawShape),
    reportedShape:   rawShape,
    // analyzeCake's own confidence in what it saw, distinct from per-decoration match confidence.
    analysisConfidence: Number(analysis?.confidence) || null,
  };

  return { snapshot, coverage };
}
