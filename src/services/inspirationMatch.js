import { supabase } from './supabase.js';
import { embedText } from './openai.js';
import { config } from '../config.js';
import {
  TYPE_MAP, isMatchable, ZONE_ADJACENCY,
  normalizeZones, zoneCompat, bestZone, modeCompat, colourProximity, decorationQueryText,
  isConfidentMatch,
} from './inspirationMaps.js';

// Score weights — semantic dominates, placement is the strong secondary signal.
const W = { semantic: 0.40, zone: 0.25, type: 0.15, mode: 0.08, colour: 0.12 };
const ZONE_FLOOR = 0.1;       // a placement-incompatible candidate (e.g. board-only for a top-rim deco) is dropped
const SHORTLIST = 20;
// CONFIDENCE_MIN / SEMANTIC_MIN and the gate itself live in inspirationMaps.js with the other
// knobs, so the policy can be tested without pulling in supabase and the whole config.

function publicUrl(key) {
  if (!key) return null;
  return /^https?:\/\//i.test(key) ? key : `${config.r2.publicUrl?.replace(/\/+$/, '')}/${key}`;
}
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

// KNN shortlist over the element index. Prefers the pgvector RPC (scale); falls back to in-JS
// cosine if the RPC isn't present yet (works before migration 011 is applied).
async function retrieve(queryEmbedding, k = SHORTLIST) {
  const rpc = await supabase.rpc('match_elements', { query_embedding: JSON.stringify(queryEmbedding), match_count: k });
  if (!rpc.error && Array.isArray(rpc.data)) {
    const sim = new Map(rpc.data.map(r => [r.id, r.similarity]));
    const { data: rows } = await supabase
      .from('cake_elements')
      .select('id, name, default_color, allowed_zones, placement_config, image_url, thumbnail_url, element_types(name)')
      .in('id', [...sim.keys()]);
    return (rows || []).map(r => ({ ...r, similarity: sim.get(r.id) ?? 0 })).sort((a, b) => b.similarity - a.similarity);
  }
  // fallback: fetch all active embeddings + cosine in JS
  const { data: all } = await supabase
    .from('cake_elements')
    .select('id, name, default_color, allowed_zones, placement_config, image_url, thumbnail_url, description_embedding, element_types(name)')
    .not('description_embedding', 'is', null).is('baker_id', null).eq('is_active', true);
  return (all || []).map(r => {
    const { description_embedding, ...rest } = r;
    const v = typeof description_embedding === 'string' ? JSON.parse(description_embedding) : description_embedding;
    return { ...rest, similarity: cosine(queryEmbedding, v) };
  }).sort((a, b) => b.similarity - a.similarity).slice(0, k);
}

// Score one candidate element for one decoration. Returns null if placement-incompatible (dropped).
function scoreCandidate(deco, cand) {
  const zones = normalizeZones(cand.allowed_zones);
  const z = zoneCompat(deco.placement, zones);
  if (deco.placement && zones.length && z < ZONE_FLOOR) return null;   // wrong place → not a fit
  const bz = deco.placement ? bestZone(deco.placement, zones) : (zones[0] || deco.placement);
  const mode = modeCompat(deco.type, cand.placement_config, bz);
  const colour = colourProximity(deco.color_hex, cand.default_color);
  const typeNames = TYPE_MAP[deco.type];
  const typeBonus = !typeNames ? 1 : (typeNames.includes(cand.element_types?.name) ? 1 : 0.4);
  const score = W.semantic * cand.similarity + W.zone * z + W.type * typeBonus + W.mode * mode + W.colour * colour;
  return {
    score, matchedZone: bz,
    breakdown: { semantic: +cand.similarity.toFixed(3), zone: z, type: typeBonus, mode, colour: +colour.toFixed(3) },
  };
}

async function matchDecoration(deco, calls) {
  const { embedding: qv, usage, model } = await embedText(decorationQueryText(deco) || deco.type || 'cake decoration');
  // Every decoration costs one embedding. Individually trivial (~$0.00002), but a metered caller
  // that ignored them would understate its own cost by however many decorations the cake has — and
  // the point of the margin guardrail is that it is not guessing. Collected, not summed here: the
  // pricing table lives in services/aiCredits.js and this file has no business knowing rupees.
  calls?.push({ model, usage });
  const cands = await retrieve(qv);
  const scored = cands
    .map(c => {
      const s = scoreCandidate(deco, c);
      // Render-ready fields (image_url/placement_config/default_color/allowed_zones) ride along so a
      // consumer can build a live preview from the match — already fetched here, so no extra query.
      return s && {
        id: c.id, name: c.name, element_type: c.element_types?.name,
        thumbnail_url: publicUrl(c.thumbnail_url), image_url: publicUrl(c.image_url),
        placement_config: c.placement_config, default_color: c.default_color, allowed_zones: c.allowed_zones,
        ...s,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  const best = scored[0] || null;
  const confident = isConfidentMatch(best);
  return {
    decoration: { type: deco.type, subtype: deco.subtype, placement: deco.placement, rim_side: deco.rim_side, color_hex: deco.color_hex, count: deco.count, text: deco.text },
    match: confident ? best : null,
    alternatives: scored.slice(1, 4),
    confidence: best ? +best.score.toFixed(3) : 0,
    // The semantic term on its own, kept whether or not the match was accepted. Without it a
    // rejection is unattributable — a composite of 0.58 looks like a near-miss when it may have
    // been 0.58 of pure placement agreement — and SEMANTIC_MIN could only ever be re-argued
    // rather than measured. This is the tuning signal.
    semantic: best ? best.breakdown.semantic : 0,
  };
}

// Match a full analysis spec → per-tier matches + a coverage summary. Cake-level decoration
// types (drip, lettering) are skipped (handled outside element matching) and reported separately.
export async function matchAnalysis(analysis) {
  const tiers = [];
  let matched = 0, total = 0;
  const gaps = [], nonMatched = [];
  // Provider calls this run made, for the caller's cost accounting. Additive to the return shape,
  // so the (unmetered) inspiration route is free to ignore it.
  const calls = [];

  for (const tier of analysis.tiers || []) {
    const items = [];
    for (const deco of tier.decorations || []) {
      if (!isMatchable(deco.type)) {
        nonMatched.push({ type: deco.type, placement: deco.placement, note: 'cake-level / special — handled outside element matching' });
        continue;
      }
      total++;
      const r = await matchDecoration(deco, calls);
      if (r.match) matched++; else gaps.push({ type: deco.type, placement: deco.placement, color_hex: deco.color_hex });
      items.push(r);
    }
    tiers.push({ index: tier.index ?? null, position: tier.position ?? null, matches: items });
  }

  return { tiers, coverage: { matched, total, gaps }, nonMatched, calls };
}
