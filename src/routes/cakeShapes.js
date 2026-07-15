import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { toPublicUrl } from './elements.js';

const router = Router();

const FIELDS = 'id, key, label, design, thumbnail_key, is_active, sort_order, updated_at';

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
const FAMILIES = ['circle', 'rounded_rect', 'heart', 'butterfly', 'polygon', 'oval', 'number'];

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
    case 'number':
      // A cake shaped like the typed digits — the digits are the config (a recipe, not an asset).
      return { digits: (String(c.digits ?? '').replace(/[^0-9]/g, '').slice(0, 4)) || '1' };
    default:
      return {};                                  // circle, oval — sized entirely by the tier
  }
}

const num = (v, d, lo, hi) => {
  const n = v != null && !Number.isNaN(Number(v)) ? Number(v) : d;
  return Math.max(lo, Math.min(hi, n));
};

// A shape now stores a self-contained `design` — the SAME shape a cake_templates.design has (see
// spattoo-core designSnapshot.js), so "New cake → this shape" loads it exactly as a template does, and
// the two systems unify. Geometry is self-describing PER TIER: each tier names its own `shapeFamily`
// (an outline generator) + `shapeConfig` (that family's proportions), so a cake can mix shapes per tier
// and renders identically forever regardless of later catalog edits.
//
// We validate the geometry-critical fields (family ∈ FAMILIES, its config, tier count ≤ MAX_TIERS,
// sizes clamped) and PRESERVE everything else on the tier (colour, piping, future wall treatments) by
// spreading it through — so a new core tier field reaches a starter without a route change. Top-level
// keys are the known design contract; unknown top-level junk is dropped, keeping the jsonb predictable.
function normalizeShapeDesign(input) {
  const d = input && typeof input === 'object' ? input : {};
  const tiersIn = Array.isArray(d.tiers) ? d.tiers.slice(0, MAX_TIERS) : [];
  const tiers = tiersIn.map(t => {
    const o = t && typeof t === 'object' ? t : {};
    const family = FAMILIES.includes(o.shapeFamily) ? o.shapeFamily : 'circle';
    const tier = {
      ...o,                                              // preserve colour, piping, gradient/dust/foil, …
      shape:       o.shape ? String(o.shape) : 'round',
      shapeFamily: family,
      shapeConfig: normalizeConfig(family, o.shapeConfig),
      height:      num(o.height, 1.45, 0.2, 4),
    };
    // A round tier is sized by RADIUS; every other footprint by width/depth. Ensure the one the family
    // uses is present and clamped (the studio speaks width/depth for all, so translate for circle).
    if (family === 'circle') {
      tier.radius = num(o.radius ?? (o.width != null ? o.width / 2 : undefined), 0.35, 0.2, 4);
    } else {
      tier.width = num(o.width, 2.16, 0.4, 8);
      tier.depth = num(o.depth, 1.56, 0.4, 8);
    }
    return tier;
  });
  return {
    tiers: tiers.length ? tiers
      : [{ shape: 'round', shapeFamily: 'circle', shapeConfig: {}, height: 1.45, color: '#f5b8c8', radius: 0.35, topPipings: [], bottomPipings: [] }],
    texts:    Array.isArray(d.texts)    ? d.texts    : [],
    ages:     Array.isArray(d.ages)     ? d.ages     : [],
    stickers: Array.isArray(d.stickers) ? d.stickers : [],
    writing:  d.writing ?? null,
    piping:   Array.isArray(d.piping)   ? d.piping   : [],
  };
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

// POST /api/admin/cake-shapes — create. Body: { key, label, design, thumbnail_key?, sort_order? }
router.post('/admin/cake-shapes', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { key, label, sort_order } = req.body;
    if (!key?.trim() || !label?.trim()) {
      return res.status(400).json({ error: 'key and label are required' });
    }

    const { data, error } = await supabase
      .from('cake_shapes')
      .insert({
        key: key.trim(),
        label: label.trim(),
        design: normalizeShapeDesign(req.body.design),
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
      .select('key')
      .eq('id', req.params.id)
      .single();
    if (readErr) return res.status(404).json({ error: 'shape not found' });

    const updates = { updated_at: new Date().toISOString() };
    const { key, label, is_active, sort_order } = req.body;

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
    if (is_active != null) updates.is_active = !!is_active;
    if (sort_order != null && Number.isFinite(sort_order)) updates.sort_order = sort_order;
    if (req.body.design != null) updates.design = normalizeShapeDesign(req.body.design);
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
