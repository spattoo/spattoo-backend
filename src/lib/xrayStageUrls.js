import { toPublicUrl } from './publicUrl.js';

// ── Stage images: stored as KEYS, served as URLs ──────────────────────────────────────
// A decoration's stage sheet lives in R2 and its key is what goes into xray_spec — the public base
// is deployment config, and baking it into a stored row would rot every one of them the day the
// bucket moves. So the API expands on the way out, exactly as every other asset column does, and
// spattoo-core never learns the bucket.
//
// Here, rather than in a route, because TWO routes hand a decoration to the client and they must
// agree: GET /orders expands the whole spec, and POST /orders/:id/xray-steps returns the single
// decoration it just generated. That second one did NOT expand, so a freshly generated guide
// arrived with `stages_key` and no `stages_url` — the words rendered and the picture did not,
// until the next full reload made it appear from the other path. Two expansions in two files is
// how that happened; one is how it stops.
//
// Returns a COPY. Mutating in place would write the expanded URL back into whatever the caller
// does next, and an expanded URL round-tripping into storage is precisely the rot the key avoids.
export function withStageUrl(decoration) {
  if (!decoration?.stages_key) return decoration;
  return { ...decoration, stages_url: toPublicUrl(decoration.stages_key) };
}

// The same expansion across a whole spec's decorations.
export function withStageUrls(spec) {
  const decorations = spec?.decorations;
  if (!decorations) return spec;
  const out = {};
  for (const [k, v] of Object.entries(decorations)) out[k] = withStageUrl(v);
  return { ...spec, decorations: out };
}

// ── Why lib and not services/xraySpec.js ─────────────────────────────────────────────
// It lived there for about ten minutes. That module is imported by scripts/check-xray-spec.mjs,
// which runs with no environment; adding these pulled in config.js through toPublicUrl and the
// gate went from passing to `Missing required env var: SUPABASE_URL` at import time.
//
// Same shape as the check:ai-credit-pricing break earlier: a module that a GATE imports must not
// acquire a dependency that needs the world to exist. Response shaping needs config, so it belongs
// on this side of that line; the spec MAPPER, which is the part worth gating, stays pure.
