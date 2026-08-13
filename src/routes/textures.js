import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';

const router = Router();

const FIELDS = 'id, key, label, algorithm, config, is_active, sort_order, updated_at';

// Validate + normalize a texture `config`. Today it carries the param SCHEMA the designer/calibrator
// read: config.params = [{ key, label, min, max, step, default, user }]. Unknown keys are dropped so
// the stored shape stays predictable. Returns { ok, value } | { ok:false, error }.
function normalizeConfig(input) {
  const config = input && typeof input === 'object' ? input : {};
  const rawParams = config.params;
  if (rawParams != null && !Array.isArray(rawParams)) {
    return { ok: false, error: 'config.params must be an array' };
  }
  const params = [];
  for (const p of rawParams ?? []) {
    if (!p || typeof p !== 'object') return { ok: false, error: 'each param must be an object' };
    const key = String(p.key ?? '').trim();
    if (!key) return { ok: false, error: 'each param needs a key' };
    const num = (v, d) => (v != null && !Number.isNaN(Number(v)) ? Number(v) : d);
    params.push({
      key,
      label: String(p.label ?? key).trim(),
      min: num(p.min, 0),
      max: num(p.max, 1),
      step: num(p.step, 0.01),
      default: num(p.default, 0),
      user: !!p.user,
    });
  }
  return { ok: true, value: { ...config, params } };
}

// ── Read (any authenticated user — the designer overlays these onto its seed) ───
// GET /api/textures — active textures, ordered.
router.get('/textures', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_textures')
      .select(FIELDS)
      .eq('is_active', true)
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────
// GET /api/admin/textures — all (incl. inactive) for the calibrator list.
router.get('/admin/textures', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_textures')
      .select(FIELDS)
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// POST /api/admin/textures — create. Body: { key, label, algorithm, config, sort_order? }
router.post('/admin/textures', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { key, label, algorithm, sort_order } = req.body;
    if (!key?.trim() || !label?.trim() || !algorithm?.trim()) {
      return res.status(400).json({ error: 'key, label and algorithm are required' });
    }
    const cfg = normalizeConfig(req.body.config);
    if (!cfg.ok) return res.status(400).json({ error: cfg.error });

    const { data, error } = await supabase
      .from('cake_textures')
      .insert({
        key: key.trim(),
        label: label.trim(),
        algorithm: algorithm.trim(),
        config: cfg.value,
        sort_order: Number.isFinite(sort_order) ? sort_order : 0,
        is_active: true,
      })
      .select(FIELDS)
      .single();

    if (error) {
      const status = error.code === '23505' ? 409 : 500; // 23505 = unique key violation
      return res.status(status).json({ error: error.message });
    }
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// PATCH /api/admin/textures/:id — selective update.
router.patch('/admin/textures/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const updates = { updated_at: new Date().toISOString() };
    const { key, label, algorithm, is_active, sort_order } = req.body;
    if (key != null) updates.key = String(key).trim();
    if (label != null) updates.label = String(label).trim();
    if (algorithm != null) updates.algorithm = String(algorithm).trim();
    if (is_active != null) updates.is_active = !!is_active;
    if (sort_order != null && Number.isFinite(sort_order)) updates.sort_order = sort_order;
    if (req.body.config != null) {
      const cfg = normalizeConfig(req.body.config);
      if (!cfg.ok) return res.status(400).json({ error: cfg.error });
      updates.config = cfg.value;
    }

    const { data, error } = await supabase
      .from('cake_textures')
      .update(updates)
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

export default router;
