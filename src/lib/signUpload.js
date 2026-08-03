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
// ceiling. ALLOWED_FOLDERS is derived from this so the folder list, the type policy and the size
// policy can never drift apart (DRY).
export const FOLDER_POLICY = {
  'elements/files/2D':    { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  'elements/files/3D':    { types: MODEL_TYPES, maxBytes: MODEL_MAX },
  'elements/thumbnails':  { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  'templates/files':      { types: [...MODEL_TYPES, 'application/json'], maxBytes: MODEL_MAX },
  'templates/thumbnails': { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  // Front view of a cake shape, captured through the real designer renderer when admin saves the shape.
  // The New-cake picker shows these as <img> — one image per shape, rather than one WebGL context per
  // shape (browsers cap those around 16, so a live-3D grid blanks tiles once the catalog grows).
  'shapes/thumbnails':    { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  'logos':                { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  'portraits':            { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },   // baker portrait for the storefront "Our story" section
  'storefront/gallery':   { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },   // baker cake photos for the storefront slideshow
  'orders/thumbnails':    { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  'orders/photos':        { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },   // baker-uploaded finished-cake photos (public → inline in order-ready email)
  'orders/reference':     { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },   // customer reference photos — a manual order's picture, and the storefront photo door
  'customer/photos':      { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },   // customer-uploaded photo for a photo-cake frame (public → designer textures it)
  'meshy/source':         { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },   // uploaded 2D image for the image→3D wizard (public so Meshy can fetch it)
  'meshy/outputs':        { types: MODEL_TYPES, maxBytes: MODEL_MAX },   // our copy of the Meshy-generated GLB (written server-side via putObject)
  // "Extract Elements": the uploaded cake photo we identify decorations in. Public so GPT-4o vision
  // can fetch it by URL. Crops + regenerated outputs are written SERVER-side via putObject (no signed
  // upload needed for those), but they share this folder tree — see routes/elementExtract.js.
  'elements/candidates':  { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  // The typeface a text_styles row shapes its placeholder glyphs with. The face is DATA, not a
  // hardcoded family — a new art style is a new font + config row, never a code change.
  'elements/fonts':       { types: FONT_TYPES,  maxBytes: FONT_MAX },
};
export const ALLOWED_FOLDERS = Object.keys(FOLDER_POLICY);

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
