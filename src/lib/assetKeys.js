// ── Finding what a row references, without knowing the row's shape ───────────────────────────────
//
// Two deep walks used wherever rows have to be moved between environments: every R2 object key a
// value names, and every uuid it names. Both are STRUCTURAL — they know what a key and a uuid look
// like, and nothing at all about designs, stickers or piping.
//
// That is the whole point. The alternative — enumerating `stickers[].imageUrl`,
// `stickers[].elementId`, `tiers[].topPipings[].glbUrl` — copies spattoo-core's knowledge of the
// design shape into this repo, where it cannot be kept in step: add a nested asset in core and the
// list silently stops finding it, and the row promotes with an object missing.
//
// Lives apart from promotionBundle.js (which needs a Supabase client) and from signUpload.js (which
// needs config.js and its ten required env vars) so that `scripts/migrate-master-to-prod.mjs` can
// use exactly this walk while running with nothing but dev Supabase credentials.

import { ALLOWED_FOLDERS } from './folders.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this string one of our managed R2 object keys? */
export const isAssetKey = (v) =>
  typeof v === 'string' &&
  !/^https?:\/\//i.test(v) &&                       // absolute → somebody else's object, not ours to copy
  ALLOWED_FOLDERS.some(f => v.startsWith(`${f}/`));

/** `https://host/base/` → the trailing-slash form, or null. */
const asBase = (publicBase) => (publicBase ? `${String(publicBase).replace(/\/+$/, '')}/` : null);

/**
 * Every R2 key buried anywhere inside a value — a jsonb column, or a whole row.
 *
 * `FOLDER_POLICY` already calls itself the single source of truth for the folder list, so a new
 * folder is recognised here for free.
 *
 * `publicBase` (optional) makes the walk ALSO see keys wrapped in an absolute URL under that base.
 * Bare keys are the architecture — `lib/publicUrl.js` expands them on the way out — but
 * `cake_templates.design` predates it and stores fully-qualified URLs, because nothing expands a
 * design. Without this, those objects are invisible to the walk: the row promotes, the design names
 * an object, and nothing ever copied it.
 *
 * Recognition is by BASE, not by "it looks like a URL". An arbitrary external URL must not be
 * mistaken for one of our objects — that would make the migration try to copy something that was
 * never in our bucket, and fail at the last step of a rollout.
 */
export function assetKeysIn(value, out = new Set(), publicBase = null) {
  const base = asBase(publicBase);
  const visit = (v) => {
    if (typeof v === 'string') {
      if (isAssetKey(v)) out.add(v);
      else if (base && v.startsWith(base) && isAssetKey(v.slice(base.length))) out.add(v.slice(base.length));
      return;
    }
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  return out;
}

/**
 * A deep copy with every absolute URL under `from` re-pointed at `to`. Used when a row moves between
 * environments: the object was copied to the SAME key in the destination bucket, so only the host in
 * front of the key changes.
 *
 *   https://pub-….r2.dev/elements/files/2D/abc.png  →  https://spattoocdn.com/elements/files/2D/abc.png
 *
 * Only strings that resolve to a managed key are touched. A link to a marketing page that happens to
 * sit on the same host is left exactly as it was.
 */
export function rewriteAssetHost(value, from, to) {
  const f = asBase(from), t = asBase(to);
  if (!f || !t || f === t) return value;
  const visit = (v) => {
    if (typeof v === 'string') {
      return v.startsWith(f) && isAssetKey(v.slice(f.length)) ? t + v.slice(f.length) : v;
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
    return v;
  };
  return visit(value);
}

/** How many strings `rewriteAssetHost` would change — for a dry run that has to say so. */
export function countAssetUrls(value, from) {
  const f = asBase(from);
  if (!f) return 0;
  let n = 0;
  const visit = (v) => {
    if (typeof v === 'string') { if (v.startsWith(f) && isAssetKey(v.slice(f.length))) n++; return; }
    if (Array.isArray(v)) { v.forEach(visit); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  return n;
}

/** Every uuid-shaped string anywhere inside a value. */
export function uuidsIn(value, out = new Set()) {
  if (typeof value === 'string') { if (UUID_RE.test(value)) out.add(value.toLowerCase()); return out; }
  if (Array.isArray(value)) { for (const v of value) uuidsIn(v, out); return out; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) uuidsIn(v, out); return out; }
  return out;
}
