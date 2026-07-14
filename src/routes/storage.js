import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { randomUUID } from 'crypto';
import { getSignedUploadUrl, deleteObject } from '../services/r2.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability, requireAdmin } from '../middleware/rbac.js';
import { config } from '../config.js';

const router = Router();

// SEC-5: the bucket is PUBLIC, so we sign uploads only for content-types that render inertly from
// our asset origin. NEVER allow text/html or image/svg+xml — both execute script when opened
// directly, turning an upload into stored XSS / phishing hosting on our own domain. Image folders
// take raster images only (SVG excluded on purpose); model folders take GLB/binary.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];
const MODEL_TYPES = ['model/gltf-binary', 'application/octet-stream'];
// Web fonts render inertly (no script, unlike SVG) — safe to sign from the public asset origin.
const FONT_TYPES = ['font/woff2', 'font/woff'];

// SEC-5: the ceiling on a single signed upload, per KIND of asset. The body never passes through this
// process — it goes browser → R2 — so this is enforced by SIGNING the length (services/r2.js), not by
// trusting the number a client sends.
//
// The numbers are ENV (config.uploads, defaults 5MB image / 75MB model / 5MB font), not constants: this
// is a limit we will want to move — tighten it against abuse, or raise it when a customer's phone
// outgrows it — and neither should cost a deploy. GET /storage/limits below hands the same numbers to
// the browser, so the client's "that image is too large" and the server's 413 can never disagree.
const MB = 1024 * 1024;
const IMAGE_MAX = config.uploads.maxImageMb * MB;
const MODEL_MAX = config.uploads.maxModelMb * MB;
const FONT_MAX  = config.uploads.maxFontMb  * MB;

// Single source of truth: each managed folder → the content-types we'll sign for it AND the byte
// ceiling. ALLOWED_FOLDERS is derived from this so the folder list, the type policy and the size
// policy can never drift apart (DRY).
const FOLDER_POLICY = {
  'elements/files/2D':    { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  'elements/files/3D':    { types: MODEL_TYPES, maxBytes: MODEL_MAX },
  'elements/thumbnails':  { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  'templates/files':      { types: [...MODEL_TYPES, 'application/json'], maxBytes: MODEL_MAX },
  'templates/thumbnails': { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  'logos':                { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  'portraits':            { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },   // baker portrait for the storefront "Our story" section
  'storefront/gallery':   { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },   // baker cake photos for the storefront slideshow
  'orders/thumbnails':    { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },
  'orders/photos':        { types: IMAGE_TYPES, maxBytes: IMAGE_MAX },   // baker-uploaded finished-cake photos (public → inline in order-ready email)
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
const ALLOWED_FOLDERS = Object.keys(FOLDER_POLICY);

const EXT_BY_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'model/gltf-binary': 'glb', 'application/octet-stream': 'bin', 'application/json': 'json',
  'font/woff2': 'woff2', 'font/woff': 'woff',
};

// Derive a safe, short extension from the client filename (sanitised), falling back to the (already
// allowlisted) content-type. Only ever letters/digits — the client never controls the key path.
function safeExt(filename, contentType) {
  const m = String(filename || '').match(/\.([A-Za-z0-9]{1,8})$/);
  if (m) return m[1].toLowerCase();
  return EXT_BY_TYPE[contentType] || 'bin';
}

// What the client is allowed to upload. The browser must refuse an oversized file at the moment it is
// PICKED — telling her after a long upload that it was never going to be accepted is not a limit, it is
// an insult — and to do that it needs the number. It reads it from HERE rather than carrying a copy,
// because a copy is a second number that drifts: raise the env and a hardcoded client goes on accepting
// what this route then 413s.
router.get('/storage/limits', requireAuth, (req, res) => {
  res.json({
    imageBytes: IMAGE_MAX,
    modelBytes: MODEL_MAX,
    fontBytes:  FONT_MAX,
  });
});

router.post('/storage/sign-upload', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { folder, filename, contentType, contentLength } = req.body;
    if (!folder || !filename || !contentType) {
      return res.status(400).json({ error: 'folder, filename and contentType are required' });
    }
    const policy = FOLDER_POLICY[folder];
    if (!policy) {
      return res.status(400).json({ error: `Invalid folder. Allowed: ${ALLOWED_FOLDERS.join(', ')}` });
    }
    // SEC-5: reject anything not on the folder's allowlist (blocks text/html, image/svg+xml, …).
    if (!policy.types.includes(String(contentType).toLowerCase())) {
      return res.status(400).json({ error: `Content-type "${contentType}" not allowed for ${folder}. Allowed: ${policy.types.join(', ')}` });
    }
    // SEC-5: the size ceiling. REQUIRED — a request without a length cannot be signed with one, and an
    // unbounded PUT to a bucket we pay for and serve publicly is exactly what this exists to stop. The
    // number is not trusted: it is signed into the URL, so a body of any other length fails at R2.
    const bytes = Number(contentLength);
    if (!Number.isInteger(bytes) || bytes <= 0) {
      return res.status(400).json({ error: 'contentLength (bytes) is required' });
    }
    if (bytes > policy.maxBytes) {
      return res.status(413).json({ error: `File is too large for ${folder} (max ${Math.round(policy.maxBytes / (1024 * 1024))}MB).` });
    }

    // SEC-5: the key is derived SERVER-SIDE with an unguessable random component, so a client can
    // neither overwrite another tenant's object (no collision) nor predict/enumerate keys. The
    // client-supplied filename only contributes a sanitised extension. Callers already use the
    // RETURNED key/publicUrl (never the name they sent), so this is transparent to every caller.
    const key = `${folder}/${randomUUID()}.${safeExt(filename, contentType)}`;
    const url = await getSignedUploadUrl(key, contentType, bytes);
    // publicUrl: the directly-loadable URL for `key`, so a client that needs to render the asset
    // immediately (e.g. a photo-cake frame texture persisted inside design JSON) can store a stable
    // URL without re-deriving the R2 base. Bare `key` is still returned for DB columns the API expands.
    const publicUrl = config.r2.publicUrl ? `${config.r2.publicUrl}/${key}` : null;
    res.json({ url, key, publicUrl });
  } catch (err) {
    serverError(req, res, err);
  }
});

// Normalize a stored image_url/thumbnail_url to a bucket key. Values are stored as bare
// keys but the API serves them expanded to full public URLs, so callers may send either.
function toKey(raw) {
  if (!raw) return null;
  let k = String(raw).trim();
  const base = config.r2.publicUrl?.replace(/\/+$/, '');
  if (base && k.startsWith(base)) k = k.slice(base.length);
  else if (/^https?:\/\//i.test(k)) { try { k = new URL(k).pathname; } catch { /* leave as-is */ } }
  return k.replace(/^\/+/, '');
}

// SEC-2: ADMIN-only. This deletes arbitrary managed-folder objects with no per-tenant ownership
// check, so it must not be reachable by bakers/customers (they could delete another tenant's logo/
// gallery via publicly-discoverable keys). Its only real caller is the admin catalog UI
// (ManageElements). Baker/customer asset deletion goes through owner-scoped endpoints
// (DELETE /baker/storefront-photos/:id, order photo deletes) — never this route.
router.post('/storage/delete', requireAuth, requireAdmin, async (req, res) => {
  try {
    const key = toKey(req.body?.key);
    if (!key) return res.status(400).json({ error: 'key is required' });
    // Only ever delete within managed folders — never an arbitrary bucket object.
    if (!ALLOWED_FOLDERS.some(f => key.startsWith(`${f}/`))) {
      return res.status(400).json({ error: `Refusing to delete outside managed folders: ${key}` });
    }
    await deleteObject(key);
    res.json({ ok: true, key });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
