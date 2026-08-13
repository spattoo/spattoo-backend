#!/usr/bin/env node
// ── xray_spec mapper gate ───────────────────────────────────────────────
// Exercises services/xraySpec.js over hand-written analyzeCake/matchAnalysis fixtures.
//
// This is a unit test wearing a check's clothes, and deliberately so: this repo has no test
// framework, adding one is a repo-wide decision, and the mapper is the single place where "what
// the model saw" becomes "what the baker bakes". Every assertion below is a judgement that would
// otherwise only be verified by spending a credit and eyeballing a PDF.
//
// The mapper is PURE, so none of this touches the network, the DB, or a model.
// Run via `npm run check:xray-spec` (or the aggregate `npm run check`).

import { buildXraySpec } from '../src/services/xraySpec.js';

let failures = 0;
const ok = (cond, label) => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}`);
};

// ── Fixtures ─────────────────────────────────────────────────────────────────
// A 2-tier round cake: a piped rim border on the base tier (matched), a topper on the top tier
// (matched), a rosette the matcher could not place (no confident match), a drip and a message.
const analysis = {
  cake: { shape: 'round', tier_count: 2 },
  confidence: 0.8,
  tiers: [
    {
      index: 0, position: 'bottom', height_ratio: 0.6, width_ratio: 1.0,
      frosting: { type: 'buttercream', finish: 'matte', base_color_hex: '#F5B8C8' },
      decorations: [
        { type: 'piping_border', subtype: 'shell', placement: 'rim', rim_side: 'top', color_hex: '#FFFFFF' },
        { type: 'drip', placement: 'rim', color_hex: '#8B4513' },
      ],
    },
    {
      index: 1, position: 'top', height_ratio: 0.4, width_ratio: 0.65,
      frosting: { type: 'buttercream', finish: 'matte', base_color_hex: '#FFF3D6' },
      decorations: [
        { type: 'topper', placement: 'top_surface', color_hex: '#D4AF37' },
        { type: 'rosette', placement: 'side', color_hex: '#F5B8C8' },
        { type: 'lettering', placement: 'side', text: 'Happy Birthday', color_hex: '#8B0000' },
      ],
    },
  ],
};

// matchAnalysis output: the border and topper matched; the rosette did not. Note lettering/drip
// never appear in `matches` at all — isMatchable filters them before matching, which is exactly
// the path that used to lose them.
const matched = {
  tiers: [
    { index: 0, matches: [
      { decoration: { type: 'piping_border', placement: 'rim', rim_side: 'top', color_hex: '#FFFFFF' },
        match: { id: 'elem-shell-1', name: 'Shell border', default_color: '#FFFFFF' }, confidence: 0.82 },
    ] },
    { index: 1, matches: [
      { decoration: { type: 'topper', placement: 'top_surface', color_hex: '#D4AF37' },
        match: { id: 'elem-topper-9', name: 'Gold crown topper', image_url: 'https://x/y.png' }, confidence: 0.71 },
      { decoration: { type: 'rosette', placement: 'side', color_hex: '#F5B8C8' },
        match: null, confidence: 0.21 },
    ] },
  ],
  coverage: { matched: 2, total: 3, gaps: [{ type: 'rosette' }] },
  nonMatched: [{ type: 'drip' }, { type: 'lettering' }],
};

const { snapshot, coverage } = buildXraySpec(analysis, matched);

// ── Provenance ───────────────────────────────────────────────────────────────
ok(snapshot.source === 'photo', 'snapshot is marked source:ai_estimate');

// ── Tier geometry: ratios only, round tiers sized by radius ──────────────────
ok(snapshot.tiers.length === 2, 'two tiers mapped');
ok(snapshot.tiers[0].radius > snapshot.tiers[1].radius, 'base tier is wider than the top tier');
ok(snapshot.tiers[0].height > snapshot.tiers[1].height, 'base tier is taller than the top tier');
ok(snapshot.tiers[0].width === undefined, 'a round tier carries radius, not width (tierVolume reads one or the other)');
ok(snapshot.tiers[0].color === '#f5b8c8', 'tier colour comes from frosting.base_color_hex, normalised');

// ── Piping: the element id is what makes craft guides work ───────────────────
ok(snapshot.tiers[0].topPipings.length === 1, 'rim/top border landed in topPipings');
ok(snapshot.tiers[0].topPipings[0].id === 'elem-shell-1', 'piping carries the matched element id (fetchCraftGuides reads `id`)');
ok(snapshot.tiers[0].bottomPipings.length === 0, 'nothing invented in bottomPipings');

// ── Placeables ───────────────────────────────────────────────────────────────
const topper = snapshot.stickers.find(s => s.elementId === 'elem-topper-9');
ok(!!topper, 'matched topper became a sticker');
ok(topper?.tierIndex === 1, 'topper kept the tier it was seen on');
ok(topper?.zone === 'top_surface', 'placement mapped to a zone');

// ── The rule that matters: never invent, never silently drop ─────────────────
ok(coverage.unidentified.length === 1, 'the unmatched rosette is recorded as unidentified');
ok(coverage.unidentified[0].what.includes('rosette'), 'unidentified entry names what was seen');
ok(!snapshot.stickers.some(s => s.name?.toLowerCase().includes('rosette')), 'the unmatched rosette was NOT invented as a sticker');
ok(snapshot.tiers.every(t => t.topPipings.every(p => p.id) && t.bottomPipings.every(p => p.id)),
   'every piping has a real element id — none guessed');

// ── Cake-level types read from `analysis`, not from nonMatched ───────────────
// This is the regression that matters: matchAnalysis's nonMatched carries only
// { type, placement, note }, so a mapper reading text/colour from THERE loses both.
ok(snapshot.texts.length === 1, 'lettering became a text');
ok(snapshot.texts[0].content === 'Happy Birthday', 'the message survived (it is not in matched.nonMatched)');
ok(snapshot.texts[0].color === '#8b0000', 'the message kept its colour');
const drip = snapshot.stickers.find(s => s.name === 'Drip');
ok(!!drip, 'drip reached the placeables so its colour reaches the colour table');
ok(drip?.color === '#8b4513', 'drip kept its colour');
ok(drip?.tierIndex === 0, 'drip kept the tier it runs down');

// ── Shape handling ───────────────────────────────────────────────────────────
ok(coverage.shapeRecognised === true, 'round is a recognised footprint');

const sq = buildXraySpec(
  { cake: { shape: 'square' }, tiers: [{ index: 0, height_ratio: 1, width_ratio: 1, frosting: {} }] },
  { tiers: [], coverage: {}, nonMatched: [] },
);
ok(sq.snapshot.tiers[0].shape === 'square', 'square maps through');
ok(sq.snapshot.tiers[0].width > 0 && sq.snapshot.tiers[0].depth > 0, 'a square tier carries width/depth (computeTinPlan isSquare)');
ok(sq.snapshot.tiers[0].radius === undefined, 'a square tier does not also carry radius');

const heart = buildXraySpec(
  { cake: { shape: 'heart' }, tiers: [{ index: 0, height_ratio: 1, width_ratio: 1, frosting: {} }] },
  { tiers: [], coverage: {}, nonMatched: [] },
);
ok(heart.snapshot.tiers[0].shape === 'round', 'an unmappable footprint falls back to round (the tin chart has two columns)');
ok(heart.coverage.shapeRecognised === false, 'and says so, rather than pretending a heart is a circle');

// ── Degenerate input must not produce a broken snapshot ──────────────────────
const empty = buildXraySpec({}, {});
ok(empty.snapshot.tiers.length === 1, 'an empty analysis still yields one tier (computeTinPlan needs something to walk)');
ok(Array.isArray(empty.snapshot.stickers) && Array.isArray(empty.snapshot.texts),
   'collections are always arrays — harvest.js walks them unconditionally');

if (failures) {
  console.error(`\n${failures} design-estimate mapper check(s) failed.`);
  process.exit(1);
}
console.log('✓ xray_spec mapper: geometry, piping ids, placeables, cake-level types and shape fallback all hold');
