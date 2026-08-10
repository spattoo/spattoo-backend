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

/**
 * Every R2 key buried anywhere inside a value — a jsonb column, or a whole row.
 *
 * `FOLDER_POLICY` already calls itself the single source of truth for the folder list, so a new
 * folder is recognised here for free.
 */
export function assetKeysIn(value, out = new Set()) {
  if (typeof value === 'string') { if (isAssetKey(value)) out.add(value); return out; }
  if (Array.isArray(value)) { for (const v of value) assetKeysIn(v, out); return out; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) assetKeysIn(v, out); return out; }
  return out;
}

/** Every uuid-shaped string anywhere inside a value. */
export function uuidsIn(value, out = new Set()) {
  if (typeof value === 'string') { if (UUID_RE.test(value)) out.add(value.toLowerCase()); return out; }
  if (Array.isArray(value)) { for (const v of value) uuidsIn(v, out); return out; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) uuidsIn(v, out); return out; }
  return out;
}
