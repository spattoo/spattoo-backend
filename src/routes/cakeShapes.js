import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { toPublicUrl } from './elements.js';

const router = Router();

const FIELDS = 'id, key, label, family, config, tiers, thumbnail_key, is_active, sort_order, updated_at';

// The designer caps a cake at 4 tiers (useCakeDesign.addTier), so a shape that starts you with more
// would seed a cake you cannot rebuild. Clamped here rather than trusted from the client.
const MAX_TIERS = 4;

// The DB stores an R2 KEY; a caller wants something it can put in an <img src>. Same contract as every
// element/template response — resolved on the way out, in ONE place, so a caller never has to know where
// the bucket lives. (toPublicUrl is reused, not re-derived: a second copy of the prefix rule is a second
// thing to get wrong when the bucket moves.)
const withThumb = (row) => ({ ...row, thumbnail_key: toPublicUrl(row.thumbnail_key) });

// The data↔code seam — must match OUTLINE_FAMILIES in spattoo-core's geometry/shapes.js, plus the two
// ANALYTIC families (circle, rounded_rect) that keep their own math in surface.js. A family is a curve
// somebody had to write; its CONFIG is data. So a new PROPORTION is a row, and only a genuinely new
// curve is a deploy.
const FAMILIES = ['circle', 'rounded_rect', 'heart', 'butterfly', 'polygon', 'oval'];

// Keys that existing designs already store. Renaming or deactivating one would silently re-shape every
// cake that uses it (an unknown key degrades to round in the designer), so they are protected here
// rather than by convention.
const RESERVED = ['round', 'rect'];

// Per-family tunables. Unknown keys are dropped so the stored jsonb shape stays predictable — the same
// contract as cake_textures.normalizeConfig / text_styles.normalizeConfig.
function normalizeConfig(family, input) {
  const c = input && typeof input === 'object' ? input : {};
  const num = (v, d, lo, hi) => {
    const n = v != null && !Number.isNaN(Number(v)) ? Number(v) : d;
    return Math.max(lo, Math.min(hi, n));
  };
  switch (family) {
    case 'heart':
      return {
        plump: num(c.plump, 1, 0.4, 2),
        cleft: num(c.cleft, 1, 0.2, 2.5),
        tip: num(c.tip, 0.12, 0, 0.35),      // the radius on the heart's point — a knife edge is not a cake
      };
    case 'butterfly':
      return { wing: num(c.wing, 1, 0.4, 2) };
    case 'polygon':
      return { sides: Math.round(num(c.sides, 6, 3, 16)), rotation: num(c.rotation, 0, -180, 180) };
    case 'rounded_rect':
      return c.square ? { square: true } : {};
    default:
      return {};                                  // circle, oval — sized entirely by the tier
  }
}

// The STACK a shape starts a cake with: [{width, depth, height}, …] in world units. `[]` means "one
// tier at the designer's default size" — the behaviour of every row that predates this column, so an
// empty stack is a valid, meaningful answer and not a missing value.
//
// A tier here carries no footprint of its own: every tier of a shape IS that shape (a two-tier heart is
// the heart outline stacked twice). Unknown keys are dropped, the same contract as normalizeConfig, so
// the stored jsonb stays predictable — and so an optional per-tier `shape` can be added later without a
// migration having to clean up whatever a client once posted.
function normalizeTiers(input) {
  if (!Array.isArray(input)) return [];
  const num = (v, d, lo, hi) => {
    const n = v != null && !Number.isNaN(Number(v)) ? Number(v) : d;
    return Math.max(lo, Math.min(hi, n));
  };
  return input.slice(0, MAX_TIERS).map(t => {
    const o = t && typeof t === 'object' ? t : {};
    return {
      width:  num(o.width,  2.4,  0.4, 8),
      depth:  num(o.depth,  2.4,  0.4, 8),
      height: num(o.height, 1.45, 0.2, 4),
    };
  });
}

// ── Read (any authenticated designer user — the designer needs the catalog to render a tier) ──
// GET /api/cake-shapes — active shapes, ordered.
router.get('/cake-shapes', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_shapes')
      .select(FIELDS)
      .eq('is_active', true)
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json((data ?? []).map(withThumb));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────
// GET /api/admin/cake-shapes — all (incl. inactive) for the studio's picker.
router.get('/admin/cake-shapes', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_shapes')
      .select(FIELDS)
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json((data ?? []).map(withThumb));
  } catch (err) {
    serverError(req, res, err);
  }
});

// POST /api/admin/cake-shapes — create. Body: { key, label, family, config?, sort_order? }
router.post('/admin/cake-shapes', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { key, label, sort_order } = req.body;
    if (!key?.trim() || !label?.trim()) {
      return res.status(400).json({ error: 'key and label are required' });
    }
    const family = String(req.body.family ?? '').trim();
    if (!FAMILIES.includes(family)) {
      return res.status(400).json({ error: `family must be one of: ${FAMILIES.join(', ')}` });
    }

    const { data, error } = await supabase
      .from('cake_shapes')
      .insert({
        key: key.trim(),
        label: label.trim(),
        family,
        config: normalizeConfig(family, req.body.config),
        tiers: normalizeTiers(req.body.tiers),
        thumbnail_key: req.body.thumbnail_key ? String(req.body.thumbnail_key).trim() : null,
        sort_order: Number.isFinite(sort_order) ? sort_order : 0,
        is_active: true,
      })
      .select(FIELDS)
      .single();

    if (error) {
      const status = error.code === '23505' ? 409 : 500;   // 23505 = unique key violation
      return res.status(status).json({ error: error.message });
    }
    res.json(withThumb(data));
  } catch (err) {
    serverError(req, res, err);
  }
});

// PATCH /api/admin/cake-shapes/:id — selective update.
router.patch('/admin/cake-shapes/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data: existing, error: readErr } = await supabase
      .from('cake_shapes')
      .select('key, family')
      .eq('id', req.params.id)
      .single();
    if (readErr) return res.status(404).json({ error: 'shape not found' });

    const updates = { updated_at: new Date().toISOString() };
    const { key, label, family, is_active, sort_order } = req.body;

    // `round`/`rect` are what existing designs store. Re-keying or retiring one would silently reshape
    // every cake using it, so it is refused outright rather than warned about.
    const reserved = RESERVED.includes(existing.key);
    if (reserved && key != null && String(key).trim() !== existing.key) {
      return res.status(409).json({ error: `"${existing.key}" is referenced by existing designs and cannot be re-keyed` });
    }
    if (reserved && is_active === false) {
      return res.status(409).json({ error: `"${existing.key}" is referenced by existing designs and cannot be deactivated` });
    }

    if (key != null) updates.key = String(key).trim();
    if (label != null) updates.label = String(label).trim();
    if (family != null) {
      const f = String(family).trim();
      if (!FAMILIES.includes(f)) {
        return res.status(400).json({ error: `family must be one of: ${FAMILIES.join(', ')}` });
      }
      updates.family = f;
    }
    if (is_active != null) updates.is_active = !!is_active;
    if (sort_order != null && Number.isFinite(sort_order)) updates.sort_order = sort_order;
    if (req.body.config != null) {
      updates.config = normalizeConfig(updates.family ?? existing.family, req.body.config);
    }
    if (req.body.tiers != null) updates.tiers = normalizeTiers(req.body.tiers);
    if (req.body.thumbnail_key != null) updates.thumbnail_key = String(req.body.thumbnail_key).trim() || null;

    const { data, error } = await supabase
      .from('cake_shapes')
      .update(updates)
      .eq('id', req.params.id)
      .select(FIELDS)
      .single();

    if (error) {
      const status = error.code === '23505' ? 409 : 500;
      return res.status(status).json({ error: error.message });
    }
    res.json(withThumb(data));
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
