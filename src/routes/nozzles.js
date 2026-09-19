import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { toPublicUrl } from '../lib/publicUrl.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';

const router = Router();

const FIELDS =
  'id, brand, number, name, category, description, sample_image_url, image_key, image_approved, '
  + 'image_approved_at, image_approved_by, is_common, sort_order, is_active, created_at, updated_at';

// The one folder a nozzle picture may live in. Anything else is refused — see imagePatch.
const IMAGE_FOLDER = 'nozzles/images/';

// Every nozzle response expands the picture's R2 key to a URL. The key is kept as well as the URL:
// the admin screen sends the key back on the next save, and a client that only ever wanted to show
// the picture should not have to know what a bucket is. One helper, so a second asset column later
// lands in ONE place rather than at four call sites (same reason elements.js has withPublicUrls).
const withImageUrl = (row) => (row ? { ...row, image_url: toPublicUrl(row.image_key) } : row);

/* The picture, and what happens to its approval.
 *
 * Returns { patch } to merge, or { error } for a 400. Kept out of buildPayload because it is not a
 * field copy — it is a rule: `undefined` (absent from the body) and `null` (explicitly cleared) are
 * different requests, and BOTH of them move the approval.
 *
 * ⚠️ Only a key under our own folder is stored. `image_key` is expanded with toPublicUrl on read,
 * and toPublicUrl passes an absolute URL straight through — so accepting free text here is exactly
 * how a third-party image ends up rendered inside our catalogue. (routes/elements.js guards
 * thumb_key the same way, and for the same reason.)
 *
 * ⚠️ A NEW picture is never an approved picture. The tick says a human looked at THIS image and
 * could see the tip; carrying it across a swap would make it vouch for something nobody opened.
 */
function imagePatch(body) {
  const key = body?.image_key;
  if (key === undefined) return { patch: {} };
  const cleared = { image_approved: false, image_approved_at: null, image_approved_by: null };
  if (key === null || String(key).trim() === '') return { patch: { image_key: null, ...cleared } };
  if (typeof key === 'string' && key.startsWith(IMAGE_FOLDER)) return { patch: { image_key: key, ...cleared } };
  return { error: `image_key must be a key under ${IMAGE_FOLDER}` };
}

// Build an insert/update payload from a request body, trimming strings.
function buildPayload(body, { partial = false } = {}) {
  const out = {};
  const setText = (key, val) => {
    if (val === undefined) return;
    out[key] = val == null || String(val).trim() === '' ? null : String(val).trim();
  };

  if (!partial || body.brand !== undefined) out.brand = String(body.brand ?? '').trim();
  if (!partial || body.number !== undefined) out.number = String(body.number ?? '').trim();
  if (!partial || body.category !== undefined) out.category = String(body.category ?? '').trim();
  setText('name', body.name);
  setText('description', body.description);
  setText('sample_image_url', body.sample_image_url);
  if (body.sort_order !== undefined) out.sort_order = Number(body.sort_order) || 0;
  if (body.is_active !== undefined) out.is_active = !!body.is_active;
  if (body.is_common !== undefined) out.is_common = !!body.is_common;
  return out;
}

// ── Read (any authenticated user — admin authoring + future baker learning screen) ──

// GET /api/nozzles?category=open_star&active=true
router.get('/nozzles', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    let q = supabase.from('nozzles').select(FIELDS);
    if (req.query.category) q = q.eq('category', String(req.query.category));
    if (req.query.active === 'true') q = q.eq('is_active', true);
    const { data, error } = await q
      .order('category', { ascending: true })
      .order('is_common', { ascending: false })
      .order('sort_order', { ascending: true })
      .order('brand', { ascending: true });

    if (error) return serverError(req, res, error);
    res.json((data ?? []).map(withImageUrl));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Admin CRUD ──────────────────────────────────────────────────────────────

// POST /api/admin/nozzles
router.post('/admin/nozzles', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const payload = buildPayload(req.body);
    if (!payload.brand) return res.status(400).json({ error: 'brand is required' });
    if (!payload.number) return res.status(400).json({ error: 'number is required' });
    if (!payload.category) return res.status(400).json({ error: 'category is required' });

    // A row may be created with a picture already attached (the bulk importer does not, but nothing
    // stops a single create from doing it). It arrives unapproved either way — the column defaults
    // to false and imagePatch spells it out rather than relying on the default.
    const img = imagePatch(req.body);
    if (img.error) return res.status(400).json({ error: img.error });
    Object.assign(payload, img.patch);

    const { data, error } = await supabase.from('nozzles').insert(payload).select(FIELDS).single();
    if (error) {
      const status = error.code === '23505' ? 409 : 500; // unique(brand, number)
      return res.status(status).json({ error: error.message });
    }
    res.status(201).json(withImageUrl(data));
  } catch (err) {
    serverError(req, res, err);
  }
});

// POST /api/admin/nozzles/bulk
// Create many at once from the admin bulk-paste importer.
// Body: { nozzles: [ { brand, number, name, category, description, is_common, sort_order } ] }
// Per-row validation; valid rows are upserted ignoring (brand, number) duplicates.
// Returns { created, skipped, errors: [{ row, reason }] }.
router.post('/admin/nozzles/bulk', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const rows = req.body?.nozzles;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'nozzles must be a non-empty array' });
    }

    const valid = [];
    const errors = [];
    rows.forEach((row, i) => {
      const p = buildPayload(row);
      if (!p.brand)    return errors.push({ row: i, reason: 'brand is required' });
      if (!p.number)   return errors.push({ row: i, reason: 'number is required' });
      if (!p.category) return errors.push({ row: i, reason: 'category is required' });
      valid.push(p);
    });

    let created = 0;
    if (valid.length) {
      // ignoreDuplicates → existing (brand, number) rows are left untouched, not errored.
      const { data, error } = await supabase
        .from('nozzles')
        .upsert(valid, { onConflict: 'brand,number', ignoreDuplicates: true })
        .select('id');
      if (error) return serverError(req, res, error);
      created = data?.length ?? 0;
    }

    res.json({ created, skipped: valid.length - created, errors });
  } catch (err) {
    serverError(req, res, err);
  }
});

// PATCH /api/admin/nozzles/:id
router.patch('/admin/nozzles/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const payload = buildPayload(req.body, { partial: true });
    payload.updated_at = new Date().toISOString();

    const img = imagePatch(req.body);
    if (img.error) return res.status(400).json({ error: img.error });
    Object.assign(payload, img.patch);

    /* Approving is its own request, and it is only meaningful against a picture.
     *
     * Skipped when the same body also carries an image: imagePatch has already cleared the approval,
     * and a body that swaps the picture AND ticks the box is asking to approve something it has just
     * replaced — the reviewer cannot have seen it.
     *
     * The read is on the approve path only, so an ordinary field edit stays one round trip. Without
     * it, a row with no picture could be marked approved, and "approved" would stop meaning
     * "someone looked at the tip" and start meaning nothing at all.
     */
    if (req.body?.image_approved !== undefined && req.body?.image_key === undefined) {
      const on = !!req.body.image_approved;
      if (on) {
        const { data: current, error: readErr } = await supabase
          .from('nozzles').select('image_key').eq('id', req.params.id).single();
        if (readErr) return serverError(req, res, readErr);
        if (!current?.image_key) return res.status(400).json({ error: 'There is no picture to approve.' });
      }
      payload.image_approved    = on;
      payload.image_approved_at = on ? new Date().toISOString() : null;
      // The Supabase auth user id — the only identity an admin request carries. Admins are not
      // baker app-users, so there is no baker id here and no foreign key on the column.
      payload.image_approved_by = on ? (req.user?.id ?? null) : null;
    }

    const { data, error } = await supabase
      .from('nozzles')
      .update(payload)
      .eq('id', req.params.id)
      .select(FIELDS)
      .single();

    if (error) {
      const status = error.code === '23505' ? 409 : 500;
      return res.status(status).json({ error: error.message });
    }
    res.json(withImageUrl(data));
  } catch (err) {
    serverError(req, res, err);
  }
});

// DELETE /api/admin/nozzles/:id
router.delete('/admin/nozzles/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { error } = await supabase.from('nozzles').delete().eq('id', req.params.id);
    if (error) return serverError(req, res, error);
    res.json({ deleted: req.params.id });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
