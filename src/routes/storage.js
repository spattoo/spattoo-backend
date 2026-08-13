import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { deleteObject } from '../services/r2.js';
import { signUpload, IMAGE_MAX, MODEL_MAX, FONT_MAX, ALLOWED_FOLDERS } from '../lib/signUpload.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability, requireAdmin } from '../middleware/rbac.js';
import { config } from '../config.js';

const router = Router();

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

// ── POST /api/storage/sign-upload ─────────────────────────────────────────────
// The AUTHENTICATED upload path: a baker app-user or admin writing to any managed folder. WHO may
// write lives here; WHAT is a legal object lives in lib/signUpload.js, shared with the storefront's
// reference-photo route, which admits a different set of people to exactly one folder.
router.post('/storage/sign-upload', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { folder, filename, contentType, contentLength } = req.body;
    const { error, status, ...signed } = await signUpload({ folder, filename, contentType, contentLength });
    if (error) return res.status(status).json({ error });
    // publicUrl: the directly-loadable URL for `key`, so a client that needs to render the asset
    // immediately (e.g. a photo-cake frame texture persisted inside design JSON) can store a stable
    // URL without re-deriving the R2 base. Bare `key` is still returned for DB columns the API expands.
    res.json(signed);
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
