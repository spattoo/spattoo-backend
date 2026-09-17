import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';

const router = Router();

const FIELDS =
  'id, brand, number, name, category, description, sample_image_url, is_common, sort_order, is_active, created_at, updated_at';

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
    res.json(data);
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

    const { data, error } = await supabase.from('nozzles').insert(payload).select(FIELDS).single();
    if (error) {
      const status = error.code === '23505' ? 409 : 500; // unique(brand, number)
      return res.status(status).json({ error: error.message });
    }
    res.status(201).json(data);
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
    res.json(data);
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
