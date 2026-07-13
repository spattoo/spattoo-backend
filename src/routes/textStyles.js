import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';

const router = Router();

const FIELDS = 'id, key, label, algorithm, config, is_active, sort_order, updated_at';
const ALGORITHMS = ['scribble', 'flat', 'fondant'];   // the data↔code seam — must match textSlots.js ALGORITHMS

// Validate + normalize a text style `config` — the look of an editable placeholder. Unknown keys are
// dropped so the stored shape stays predictable (same contract as cake_textures.normalizeConfig).
function normalizeConfig(input) {
  const c = input && typeof input === 'object' ? input : {};
  const num = (v, d) => (v != null && !Number.isNaN(Number(v)) ? Number(v) : d);
  const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d);

  const font = c.font && typeof c.font === 'object' ? c.font : {};
  if (font.url != null && typeof font.url !== 'string') return { ok: false, error: 'config.font.url must be a string' };

  const hatch = c.hatch && typeof c.hatch === 'object' ? c.hatch : {};
  const outline = c.outline && typeof c.outline === 'object' ? c.outline : {};
  const fondant = c.fondant && typeof c.fondant === 'object' ? c.fondant : {};

  return {
    ok: true,
    value: {
      font: {
        family: str(font.family, 'sans-serif'),
        url: str(font.url, null),
        weight: num(font.weight, 800),
      },
      fill: str(c.fill, '#5A3410'),
      hatch: {
        color: str(hatch.color, '#F3E3C8'),
        angle: num(hatch.angle, -35),
        gap: num(hatch.gap, 0.055),
        width: num(hatch.width, 0.014),
      },
      outline: {
        color: str(outline.color, '#3F230A'),
        width: num(outline.width, 0.05),
        wobble: num(outline.wobble, 0.35),
      },
      // 'fondant' only — the puffy-icing shading. Stored for every style (harmless to the other
      // algorithms, which ignore it) so switching Look never loses what was already tuned.
      fondant: {
        light: num(fondant.light, 135),
        bevel: num(fondant.bevel, 0.5),      // a fraction of the STROKE's thickness, not of glyph height
        gloss: num(fondant.gloss, 0.55),
        ao: num(fondant.ao, 0.45),
        shadow_blur: num(fondant.shadow_blur, 0.08),
        shadow_dy: num(fondant.shadow_dy, 0.04),
        shadow_alpha: num(fondant.shadow_alpha, 0.35),
      },
      tracking: num(c.tracking, 0),
      fit: num(c.fit, 0.92),
    },
  };
}

// ── Read (any authenticated designer user — it renders the placeholder values) ─
// GET /api/text-styles — active styles, ordered.
router.get('/text-styles', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('text_styles')
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
// GET /api/admin/text-styles — all (incl. inactive) for the studio's picker.
router.get('/admin/text-styles', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('text_styles')
      .select(FIELDS)
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// POST /api/admin/text-styles — create. Body: { key, label, algorithm?, config, sort_order? }
router.post('/admin/text-styles', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { key, label, sort_order } = req.body;
    if (!key?.trim() || !label?.trim()) {
      return res.status(400).json({ error: 'key and label are required' });
    }
    const algorithm = (req.body.algorithm ?? 'scribble').trim();
    if (!ALGORITHMS.includes(algorithm)) {
      return res.status(400).json({ error: `algorithm must be one of: ${ALGORITHMS.join(', ')}` });
    }
    const cfg = normalizeConfig(req.body.config);
    if (!cfg.ok) return res.status(400).json({ error: cfg.error });

    const { data, error } = await supabase
      .from('text_styles')
      .insert({
        key: key.trim(),
        label: label.trim(),
        algorithm,
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

// PATCH /api/admin/text-styles/:id — selective update.
router.patch('/admin/text-styles/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const updates = { updated_at: new Date().toISOString() };
    const { key, label, algorithm, is_active, sort_order } = req.body;
    if (key != null) updates.key = String(key).trim();
    if (label != null) updates.label = String(label).trim();
    if (algorithm != null) {
      const a = String(algorithm).trim();
      if (!ALGORITHMS.includes(a)) {
        return res.status(400).json({ error: `algorithm must be one of: ${ALGORITHMS.join(', ')}` });
      }
      updates.algorithm = a;
    }
    if (is_active != null) updates.is_active = !!is_active;
    if (sort_order != null && Number.isFinite(sort_order)) updates.sort_order = sort_order;
    if (req.body.config != null) {
      const cfg = normalizeConfig(req.body.config);
      if (!cfg.ok) return res.status(400).json({ error: cfg.error });
      updates.config = cfg.value;
    }

    const { data, error } = await supabase
      .from('text_styles')
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
