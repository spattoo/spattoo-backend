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

// Single source of truth: each managed folder → the content-types we'll sign for it. ALLOWED_FOLDERS
// is derived from this so the folder list and the type policy can never drift apart (DRY).
const FOLDER_CONTENT_TYPES = {
  'elements/files/2D':    IMAGE_TYPES,
  'elements/files/3D':    MODEL_TYPES,
  'elements/thumbnails':  IMAGE_TYPES,
  'templates/files':      [...MODEL_TYPES, 'application/json'],
  'templates/thumbnails': IMAGE_TYPES,
  'logos':                IMAGE_TYPES,
  'portraits':            IMAGE_TYPES,   // baker portrait for the storefront "Our story" section
  'storefront/gallery':   IMAGE_TYPES,   // baker cake photos for the storefront slideshow
  'orders/thumbnails':    IMAGE_TYPES,
  'orders/photos':        IMAGE_TYPES,   // baker-uploaded finished-cake photos (public → inline in order-ready email)
  'customer/photos':      IMAGE_TYPES,   // customer-uploaded photo for a photo-cake frame (public → designer textures it)
  'meshy/source':         IMAGE_TYPES,   // uploaded 2D image for the image→3D wizard (public so Meshy can fetch it)
  'meshy/outputs':        MODEL_TYPES,   // our copy of the Meshy-generated GLB (written server-side via putObject)
  // "Extract Elements": the uploaded cake photo we identify decorations in. Public so GPT-4o vision
  // can fetch it by URL. Crops + regenerated outputs are written SERVER-side via putObject (no signed
  // upload needed for those), but they share this folder tree — see routes/elementExtract.js.
  'elements/candidates':  IMAGE_TYPES,
};
const ALLOWED_FOLDERS = Object.keys(FOLDER_CONTENT_TYPES);

const EXT_BY_TYPE = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'model/gltf-binary': 'glb', 'application/octet-stream': 'bin', 'application/json': 'json',
};

// Derive a safe, short extension from the client filename (sanitised), falling back to the (already
// allowlisted) content-type. Only ever letters/digits — the client never controls the key path.
function safeExt(filename, contentType) {
  const m = String(filename || '').match(/\.([A-Za-z0-9]{1,8})$/);
  if (m) return m[1].toLowerCase();
  return EXT_BY_TYPE[contentType] || 'bin';
}

router.post('/storage/sign-upload', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { folder, filename, contentType } = req.body;
    if (!folder || !filename || !contentType) {
      return res.status(400).json({ error: 'folder, filename and contentType are required' });
    }
    const allowedTypes = FOLDER_CONTENT_TYPES[folder];
    if (!allowedTypes) {
      return res.status(400).json({ error: `Invalid folder. Allowed: ${ALLOWED_FOLDERS.join(', ')}` });
    }
    // SEC-5: reject anything not on the folder's allowlist (blocks text/html, image/svg+xml, …).
    if (!allowedTypes.includes(String(contentType).toLowerCase())) {
      return res.status(400).json({ error: `Content-type "${contentType}" not allowed for ${folder}. Allowed: ${allowedTypes.join(', ')}` });
    }

    // SEC-5: the key is derived SERVER-SIDE with an unguessable random component, so a client can
    // neither overwrite another tenant's object (no collision) nor predict/enumerate keys. The
    // client-supplied filename only contributes a sanitised extension. Callers already use the
    // RETURNED key/publicUrl (never the name they sent), so this is transparent to every caller.
    const key = `${folder}/${randomUUID()}.${safeExt(filename, contentType)}`;
    const url = await getSignedUploadUrl(key, contentType);
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
