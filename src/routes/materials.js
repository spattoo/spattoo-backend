import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';

const router = Router();

const FIELDS = 'id, key, label, config, is_active, sort_order, updated_at';

// Allowed decoration-finish (config.surface) keys — map 1:1 to MeshPhysicalMaterial. Unknown keys are
// dropped so a stray field can't reach the renderer. Kept in sync with DECOR_MATERIALS surface in
// spattoo-core/src/designer/materials.js.
const SURFACE_KEYS = new Set([
  'roughness', 'metalness', 'sheen', 'sheenColor', 'sheenRoughness',
  'clearcoat', 'clearcoatRoughness', 'envMapIntensity', 'anisotropy', 'anisotropyRotation',
]);
const APPLIES_TO = new Set(['body', 'element']);   // where a material may be used

// Validate + normalize a material `config`. It carries: the ordered style list the designer reads
// (config.styles = cake_textures keys; `smooth` is the implicit always-first default, dropped if present);
// config.applies_to (['body']|['element']|both — which context the material may be used in); and
// config.surface (the MeshPhysical decoration finish a GLB decoration wears). Unknown surface keys are
// dropped and numbers coerced so the stored shape stays predictable. Returns { ok, value } | { ok:false, error }.
function normalizeConfig(input) {
  const config = input && typeof input === 'object' ? input : {};
  const raw = config.styles;
  if (raw != null && !Array.isArray(raw)) {
    return { ok: false, error: 'config.styles must be an array' };
  }
  const seen = new Set();
  const styles = [];
  for (const s of raw ?? []) {
    const key = String(s ?? '').trim();
    if (!key || key === 'smooth' || seen.has(key)) continue;   // smooth is implicit; no dupes/blanks
    seen.add(key);
    styles.push(key);
  }
  const value = { ...config, styles };

  // applies_to: contexts the material may be used in — deduped, gated to the known set.
  if (config.applies_to != null) {
    if (!Array.isArray(config.applies_to)) return { ok: false, error: 'config.applies_to must be an array' };
    const ctx = [...new Set(config.applies_to.map(c => String(c ?? '').trim()))].filter(c => APPLIES_TO.has(c));
    if (config.applies_to.length && !ctx.length) return { ok: false, error: "config.applies_to must contain 'body' and/or 'element'" };
    value.applies_to = ctx;
  }

  // surface: the MeshPhysical decoration finish — drop unknown keys, coerce numbers (sheenColor stays a string).
  if (config.surface != null) {
    if (typeof config.surface !== 'object' || Array.isArray(config.surface)) return { ok: false, error: 'config.surface must be an object' };
    const surface = {};
    for (const [k, v] of Object.entries(config.surface)) {
      if (!SURFACE_KEYS.has(k)) continue;
      if (k === 'sheenColor') { surface[k] = String(v); continue; }
      const n = Number(v);
      if (Number.isFinite(n)) surface[k] = n;
    }
    value.surface = surface;
  }

  return { ok: true, value };
}

// ── Read (any authenticated designer user — overlays these onto the in-code seed) ──
// GET /api/materials — active materials, ordered.
router.get('/materials', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('materials')
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
// GET /api/admin/materials — all (incl. inactive) for the editor.
router.get('/admin/materials', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('materials')
      .select(FIELDS)
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// POST /api/admin/materials — create. Body: { key, label, config, sort_order? }
router.post('/admin/materials', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { key, label, sort_order } = req.body;
    if (!key?.trim() || !label?.trim()) {
      return res.status(400).json({ error: 'key and label are required' });
    }
    const cfg = normalizeConfig(req.body.config);
    if (!cfg.ok) return res.status(400).json({ error: cfg.error });

    const { data, error } = await supabase
      .from('materials')
      .insert({
        key: key.trim(),
        label: label.trim(),
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

// PATCH /api/admin/materials/:id — selective update (the editor mainly PATCHes config.styles).
router.patch('/admin/materials/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const updates = { updated_at: new Date().toISOString() };
    const { key, label, is_active, sort_order } = req.body;
    if (key != null) updates.key = String(key).trim();
    if (label != null) updates.label = String(label).trim();
    if (is_active != null) updates.is_active = !!is_active;
    if (sort_order != null && Number.isFinite(sort_order)) updates.sort_order = sort_order;
    if (req.body.config != null) {
      const cfg = normalizeConfig(req.body.config);
      if (!cfg.ok) return res.status(400).json({ error: cfg.error });
      updates.config = cfg.value;
    }

    const { data, error } = await supabase
      .from('materials')
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
