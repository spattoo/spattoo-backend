import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth, attachBakerContext } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { scopeCatalogRead } from '../lib/tenantScope.js';
import { config } from '../config.js';
import { jobQueue } from '../jobs/queue.js';
import { templatesForBaker, allTemplates } from '../lib/templateList.js';
// toPublicUrl is declared locally further down — not imported, or the two collide and the API
// fails to boot (check:boot catches it, which is how this was found).
import { templateClosure } from '../lib/promotionBundle.js';

const router = Router();

function toPublicUrl(key) {
  if (!key) return null;
  return `${config.r2.publicUrl}/${key}`;
}

const TEMPLATE_FIELDS = 'id, name, shape, tier_count, type, offering, baker_id, parent_template_id, design, thumbnail_url, sort_order, is_active';
const TEMPLATE_FILTER_JOIN = 'template_tags(tags(slug)), cake_template_attrs(min_weight_kg, min_age, max_age)';

function withTagsAndAttrs({ template_tags, cake_template_attrs, ...t }) {
  const rawAttrs = cake_template_attrs;
  const attrs = Array.isArray(rawAttrs) ? (rawAttrs[0] ?? null) : (rawAttrs ?? null);
  return {
    ...t,
    tag_slugs: (template_tags ?? []).map(r => r.tags?.slug).filter(Boolean),
    attrs,
  };
}

router.get('/templates', requireAuth, requireCapability('design:create'), attachBakerContext, async (req, res) => {
  try {
    const { type } = req.query;

    if (req.bakerId) {
      // Global + their own, minus the globals they have switched off. The rule lives in
      // lib/templateList.js because the public storefront needs the same answer for an anonymous
      // visitor, and a second copy of it would drift the first time either learned something.
      return res.json(await templatesForBaker(req.bakerId, { type }));
    }

    // Admin: optionally scope to a baker's view via ?baker_id=X.
    // SEC-10: coerce to an integer before it reaches a PostgREST filter — a raw string param would
    // inject `.or()` syntax. Invalid or absent → unfiltered, and admin sees everything.
    const scopedId = Number.parseInt(req.query.baker_id, 10);
    res.json(await allTemplates({ type, bakerId: Number.isInteger(scopedId) ? scopedId : null }));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Export templates as a portable bundle ────────────────────────────────────────────────────────
// The template half of dev → prod promotion (plans/element-preview-and-publish.md). Produces the
// SAME bundle format the element export does, with the template rows added — so one import route
// receives both, and a template bundle is a superset rather than a second thing to maintain.
//
// ── THE ELEMENTS TRAVEL WITH IT ─────────────────────────────────────────────────────────────────
// A design embeds elementId on its stickers and the element id on its piping layers. A template
// whose elements are missing still RENDERS — the design carries its own copy of everything needed
// to draw — but the designer is deliberately tolerant of an absent catalogue row, so move/resize
// caps quietly revert to defaults and clustering stops working. It would look right and behave
// differently, silently. So the elements go too, resolved by the same closure the element export
// uses.
//
// ── ASSETS COME FROM THE DESIGN ─────────────────────────────────────────────────────────────────
// Not from the elements it references today. The design names R2 keys directly, so a template built
// before an element's image was replaced still points at the older object — which is the correct
// object for that template, and one a walk through today's elements would miss.
router.get('/admin/templates/export', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'ids is required (comma-separated)' });

    const c = await templateClosure(ids);
    if (!c) return res.status(404).json({ error: 'No global templates matched those ids' });

    res.json({
      format: 'spattoo-element-bundle',
      version: 1,
      exported_at: new Date().toISOString(),
      source: { r2_public_url: config.r2.publicUrl },
      // Insert order: vocabulary, then elements, then the templates that reference them.
      element_types:       c.element_types,
      // templateClosure spreads elementClosure, so the categories are already in `c` — they were
      // simply never named here, and a key absent from this object never reaches the importer. The
      // elements would have arrived carrying `category_slug` with no vocabulary to resolve it
      // against, so any category prod happened to lack would have silently dropped.
      element_categories:  c.element_categories,
      tags:                c.tags,
      elements:            c.elements,
      element_tags:        c.element_tags,
      element_craft_guide: c.element_craft_guide,
      cake_templates:      c.cake_templates,
      template_tags:       c.template_tags,
      cake_template_attrs: c.cake_template_attrs,
      assets: [...c.keys].map(key => ({ key, url: toPublicUrl(key) })),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

router.get('/admin/templates', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_templates')
      .select(`${TEMPLATE_FIELDS}, ${TEMPLATE_FILTER_JOIN}`)
      .order('sort_order');

    if (error) return serverError(req, res, error);
    res.json(data.map(t => withTagsAndAttrs({ ...t, thumbnail_url: toPublicUrl(t.thumbnail_url) })));
  } catch (err) {
    serverError(req, res, err);
  }
});

router.get('/templates/:id', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    // SEC-7: scope by tenant — a baker/customer may read only GLOBAL templates or their own.
    // Without this, any design:create caller could read another baker's private template by id.
    const { data, error } = await scopeCatalogRead(
      supabase
        .from('cake_templates')
        .select(`${TEMPLATE_FIELDS}, ${TEMPLATE_FILTER_JOIN}`)
        .eq('id', req.params.id),
      req,
    ).single();

    if (error) return res.status(404).json({ error: 'Template not found' });
    res.json(withTagsAndAttrs({ ...data, thumbnail_url: toPublicUrl(data.thumbnail_url) }));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/baker/templates ─────────────────────────────────────────────────
// A baker saves one of their own designs as a template ("Save as Template" in the designer).
//
// This route EXISTS because the designer used to insert into cake_templates DIRECTLY from the
// browser, resolving baker_id CLIENT-side — a tenancy hole: the caller chose which baker it was
// writing for. Here baker_id is SERVER-RESOLVED from the token and can't be spoofed.
//
// NO rights attestation here, deliberately. A template is the baker's DESIGN LIBRARY (this is how
// they save any design), and it is only ever seen by that baker's own invited customers — never by
// the open web. The single attestation gate is the storefront Publish button, which is the one
// moment content becomes world-visible (see supabase/content_attestations.sql). A checkbox on every
// design save would fire constantly, and a tick clicked fifty times is reflex, not evidence.
router.post('/baker/templates', requireAuth, requireCapability('template:manage'), attachBakerContext, async (req, res) => {
  try {
    if (!req.bakerId) return res.status(404).json({ error: 'No baker account found' });

    const { name, shape, tier_count, offering, design, thumbnail_url,
            min_weight_kg, min_age, max_age, occasion_tag_ids } = req.body ?? {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    if (!design || typeof design !== 'object') return res.status(400).json({ error: 'design is required' });

    const { data, error } = await supabase
      .from('cake_templates')
      .insert({
        name:          name.trim(),
        shape:         shape ?? 'round',
        tier_count:    tier_count ?? 1,
        type:          'basic',
        offering:      offering ?? 'standard',
        baker_id:      req.bakerId,          // server-resolved — never from the client
        design,
        thumbnail_url: thumbnail_url ?? null,
        sort_order:    0,
        is_active:     true,
      })
      .select('id')
      .single();
    if (error) return serverError(req, res, error);

    // Optional attrs + occasion tags — same shape the designer wrote directly before.
    const hasAttrs = min_weight_kg != null || min_age != null || max_age != null;
    if (hasAttrs) {
      const { error: attrsErr } = await supabase.from('cake_template_attrs').upsert({
        template_id:   data.id,
        min_weight_kg: min_weight_kg ?? null,
        min_age:       min_age ?? null,
        max_age:       max_age ?? null,
      }, { onConflict: 'template_id' });
      if (attrsErr) return serverError(req, res, attrsErr);
    }

    if (Array.isArray(occasion_tag_ids) && occasion_tag_ids.length) {
      const { error: tagErr } = await supabase
        .from('template_tags')
        .insert(occasion_tag_ids.map(tag_id => ({ template_id: data.id, tag_id })));
      if (tagErr) return serverError(req, res, tagErr);
    }

    if (thumbnail_url) {
      jobQueue.add('auto_tag', { entityType: 'template', entityId: data.id, thumbnailKey: thumbnail_url, name }).catch(() => {});
    }

    res.status(201).json({ id: data.id });
  } catch (err) {
    serverError(req, res, err);
  }
});

router.post('/admin/templates', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { name, shape, tier_count, type, offering, baker_id, parent_template_id, design, thumbnail_url, sort_order } = req.body;
    if (!name || !design) {
      return res.status(400).json({ error: 'name and design are required' });
    }

    const { data, error } = await supabase
      .from('cake_templates')
      .insert({
        name,
        shape:              shape ?? 'round',
        tier_count:         tier_count ?? 1,
        type:               type ?? 'basic',
        offering:           offering ?? 'standard',
        baker_id:           baker_id ?? null,
        parent_template_id: parent_template_id ?? null,
        design,
        thumbnail_url:      thumbnail_url ?? null,
        sort_order:         sort_order ?? 0,
        is_active:          true,
      })
      .select('id')
      .single();

    if (error) return serverError(req, res, error);

    if (thumbnail_url) {
      jobQueue.add('auto_tag', { entityType: 'template', entityId: data.id, thumbnailKey: thumbnail_url, name }).catch(() => {});
    }

    res.status(201).json({ id: data.id });
  } catch (err) {
    serverError(req, res, err);
  }
});

router.patch('/admin/templates/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const allowed = ['name', 'shape', 'tier_count', 'type', 'offering', 'design', 'thumbnail_url', 'sort_order', 'is_active'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));

    const { error } = await supabase
      .from('cake_templates')
      .update(updates)
      .eq('id', req.params.id);

    if (error) return serverError(req, res, error);
    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

router.delete('/admin/templates/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { error } = await supabase
      .from('cake_templates')
      .delete()
      .eq('id', req.params.id);

    if (error) return serverError(req, res, error);
    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
