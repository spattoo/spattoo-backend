import { config } from '../config.js';

// ── A stored R2 key → a URL a browser can load ───────────────────────────────────────
// We store KEYS, never URLs. The public base is deployment config, and baking it into a row would
// rot every one of them the day the bucket or its domain moves. So expansion happens on the way
// out, once, here.
//
// This existed as SEVEN near-copies across the routes, and they had already drifted: only some
// carried the already-a-URL guard below, so the same stored value expanded correctly through one
// endpoint and became `https://cdn/https://cdn/...` through another. A helper this small is exactly
// the kind that gets re-typed instead of imported — which is the argument for it having an obvious
// home rather than a shorter one.
export function toPublicUrl(key) {
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return key;   // already a full URL — don't double-prefix
  return `${config.r2.publicUrl}/${key}`;
}
