// ── Signed-upload policy (SEC-5) ────────────────────────────────────────────────────────────────
// What may be written to the bucket, by whom-agnostic rules: which folders exist, which
// content-types each will accept, and how many bytes. Extracted from routes/storage.js because a
// SECOND route now signs uploads — the storefront's reference-photo door, for a customer who has
// verified a phone but is not a baker app-user and therefore holds no capabilities at all.
//
// Two copies of this policy would be the worst possible thing to duplicate. The bucket is served
// publicly, so the type allowlist is the only thing standing between an upload and stored XSS on our
// own asset origin; a second copy that forgot `image/svg+xml` would not fail loudly, it would just
// be exploitable. So the policy lives here and both routes ask it.
//
// WHO may upload is deliberately NOT here — that is each route's own decision, and the two differ.

import { randomUUID } from 'crypto';
import { getSignedUploadUrl } from '../services/r2.js';
import { config } from '../config.js';
import { FOLDER_KIND, ALLOWED_FOLDERS } from './folders.js';

// SEC-5: the bucket is PUBLIC, so we sign uploads only for content-types that render inertly from
// our asset origin. NEVER allow text/html or image/svg+xml — both execute script when opened
// directly, turning an upload into stored XSS / phishing hosting on our own domain. Image folders
// take raster images only (SVG excluded on purpose); model folders take GLB/binary.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
export const MODEL_TYPES = ['model/gltf-binary', 'application/octet-stream'];
// Web fonts render inertly (no script, unlike SVG) — safe to sign from the public asset origin.
export const FONT_TYPES = ['font/woff2', 'font/woff'];

// SEC-5: the ceiling on a single signed upload, per KIND of asset. The body never passes through this
// process — it goes browser → R2 — so this is enforced by SIGNING the length (services/r2.js), not by
// trusting the number a client sends.
//
// The numbers are ENV (config.uploads, defaults 5MB image / 75MB model / 5MB font), not constants: this
// is a limit we will want to move — tighten it against abuse, or raise it when a customer's phone
// outgrows it — and neither should cost a deploy. GET /storage/limits hands the same numbers to the
// browser, so the client's "that image is too large" and the server's 413 can never disagree.
const MB = 1024 * 1024;
export const IMAGE_MAX = config.uploads.maxImageMb * MB;
export const MODEL_MAX = config.uploads.maxModelMb * MB;
export const FONT_MAX  = config.uploads.maxFontMb  * MB;

// Single source of truth: each managed folder → the content-types we'll sign for it AND the byte
// ceiling. Derived from FOLDER_KIND (lib/folders.js) so the folder list, the type policy and the
// size policy can never drift apart (DRY) — a new folder is added THERE, once.
//
// The folder NAMES live in their own module because recognising one of our object keys must not
// require this file: it pulls in config.js and its ten required env vars, which would stop the
// rollout script from running with only Supabase credentials. The types and sizes — the parts that
// actually matter for SEC-5 — stay here.
const TYPES_BY_KIND = {
  image:         { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  model:         { types: MODEL_TYPES, maxBytes: MODEL_MAX },
  model_or_json: { types: [...MODEL_TYPES, 'application/json'], maxBytes: MODEL_MAX },
  font:          { types: FONT_TYPES,  maxBytes: FONT_MAX },
};
export const FOLDER_POLICY = Object.fromEntries(
  Object.entries(FOLDER_KIND).map(([folder, kind]) => {
    const policy = TYPES_BY_KIND[kind];
    // A folder added with a kind nobody defined would otherwise become `undefined` here and throw
    // only later, inside a request, as "cannot read types of undefined".
    if (!policy) throw new Error(`folders.js: '${folder}' has unknown kind '${kind}'`);
    return [folder, policy];
  }),
);
export { ALLOWED_FOLDERS };

const EXT_BY_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'model/gltf-binary': 'glb', 'application/octet-stream': 'bin', 'application/json': 'json',
  'font/woff2': 'woff2', 'font/woff': 'woff',
};

// Derive a safe, short extension from the client filename (sanitised), falling back to the (already
// allowlisted) content-type. Only ever letters/digits — the client never controls the key path.
export function safeExt(filename, contentType) {
  const m = String(filename || '').match(/\.([A-Za-z0-9]{1,8})$/);
  if (m) return m[1].toLowerCase();
  return EXT_BY_TYPE[contentType] || 'bin';
}

/**
 * Validate a requested upload against the folder policy and sign it.
 *
 * Returns `{ error, status }` on refusal, or `{ url, key, publicUrl }` on success — a return value
 * rather than a thrown error, so each caller shapes its own HTTP response. Callers must have already
 * decided the requester is ALLOWED to write to `folder`; this answers "is this a legal object",
 * never "may you".
 */
export async function signUpload({ folder, filename, contentType, contentLength }) {
  if (!folder || !filename || !contentType) {
    return { status: 400, error: 'folder, filename and contentType are required' };
  }
  const policy = FOLDER_POLICY[folder];
  if (!policy) {
    return { status: 400, error: `Invalid folder. Allowed: ${ALLOWED_FOLDERS.join(', ')}` };
  }
  // SEC-5: reject anything not on the folder's allowlist (blocks text/html, image/svg+xml, …).
  if (!policy.types.includes(String(contentType).toLowerCase())) {
    return { status: 400, error: `Content-type "${contentType}" not allowed for ${folder}. Allowed: ${policy.types.join(', ')}` };
  }
  // SEC-5: the size ceiling. REQUIRED — a request without a length cannot be signed with one, and an
  // unbounded PUT to a bucket we pay for and serve publicly is exactly what this exists to stop. The
  // number is not trusted: it is signed into the URL, so a body of any other length fails at R2.
  const bytes = Number(contentLength);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    return { status: 400, error: 'contentLength (bytes) is required' };
  }
  if (bytes > policy.maxBytes) {
    return { status: 413, error: `File is too large for ${folder} (max ${Math.round(policy.maxBytes / MB)}MB).` };
  }

  // SEC-5: the key is derived SERVER-SIDE with an unguessable random component, so a client can
  // neither overwrite another tenant's object (no collision) nor predict/enumerate keys. The
  // client-supplied filename only contributes a sanitised extension.
  const key = `${folder}/${randomUUID()}.${safeExt(filename, contentType)}`;
  const url = await getSignedUploadUrl(key, contentType, bytes);
  const publicUrl = config.r2.publicUrl ? `${config.r2.publicUrl}/${key}` : null;
  return { url, key, publicUrl };
}
