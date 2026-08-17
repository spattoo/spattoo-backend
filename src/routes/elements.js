import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import express from 'express';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { scopeCatalogRead } from '../lib/tenantScope.js';
import { config } from '../config.js';
import { removeBackground } from '../services/removebg.js';
import { jobQueue } from '../jobs/queue.js';
import { reindexElement } from '../services/elementIndex.js';
import { generateWebpThumbnail } from '../services/thumbnails.js';
import { putObject } from '../services/r2.js';
import { elementClosure } from '../lib/promotionBundle.js';
import { rewriteAssetHost } from '../lib/assetKeys.js';
import { buildElementGuide } from '../services/decorationGuide.js';
import { decorationPolicy } from '../services/decorationPolicy.js';

const router = Router();

// Re-exported from lib/publicUrl.js, which is now the one definition. Kept here because several
// modules already import it from this route and moving those imports is churn without benefit —
// what mattered was that there stop being two BODIES of it.
// `export ... from` would re-export without binding it locally, and this file uses it below.
import { toPublicUrl } from '../lib/publicUrl.js';
export { toPublicUrl };

// Every element response resolves the same three R2 keys to public URLs. One helper, so a fourth
// asset column (or a change to how keys resolve) lands in ONE place instead of four call sites.
function withPublicUrls(el) {
  return {
    ...el,
    image_url:     toPublicUrl(el.image_url),
    thumbnail_url: toPublicUrl(el.thumbnail_url),
    thumb_key:     toPublicUrl(el.thumb_key),
  };
}

// asset_class is stored as a compact surrogate smallint (hot-table rule); callers speak the readable
// key. Translate at the API boundary so the DB stays compact and clients stay readable.
const ASSET_CLASS_ID  = { scatter: 1, decor: 2, topper: 3 };
const ASSET_CLASS_KEY = { 1: 'scatter', 2: 'decor', 3: 'topper' };
const OPTIMIZER_VERSION = 1;

// Map the GLB cost stats from a request body into DB columns (asset_class → surrogate, stamp
// optimizer version/time). Returns {} when no stats were sent so non-3D ingest is untouched.
function glbStatColumns(body) {
  if (body.asset_class === undefined && body.tri_count === undefined) return {};
  const cols = { optimizer_version: OPTIMIZER_VERSION, optimized_at: new Date().toISOString() };
  if (body.asset_class       !== undefined) cols.asset_class       = ASSET_CLASS_ID[body.asset_class] ?? null;
  if (body.tri_count         !== undefined) cols.tri_count         = body.tri_count;
  if (body.texture_max_dim   !== undefined) cols.texture_max_dim   = body.texture_max_dim;
  if (body.decoded_mem_kb    !== undefined) cols.decoded_mem_kb    = body.decoded_mem_kb;
  if (body.optimized_size_kb !== undefined) cols.optimized_size_kb = body.optimized_size_kb;
  if (body.over_cap          !== undefined) cols.over_cap          = !!body.over_cap;
  return cols;
}

// Generate (or refresh) the optimised WebP picker thumbnail for an element and
// store its key. Fire-and-forget — never blocks the request, mirrors reindexElement.
// The master thumbnail (thumbnail_url, now itself a WebP) is retained as the source
// and the fallback (thumb_key ?? thumbnail_url).
//
// EXPORTED so the baker-facing create path (routes/uploads.js) runs the SAME post-create work
// rather than growing a second copy that drifts. An element is an element, whoever made it.
export async function ensureThumbKey(id, thumbnailKey) {
  try {
    const webpKey = await generateWebpThumbnail(thumbnailKey);
    if (webpKey) await supabase.from('cake_elements').update({ thumb_key: webpKey }).eq('id', id);
  } catch (e) {
    console.error('thumb_key generation failed:', e.message);
  }
}

// Expand R2 keys nested INSIDE placement_config (the photo-frame window mask, the alternate piping
// GLBs) to public URLs — the same treatment the top-level image_url/thumbnail_url columns get. The
// DB stores bare keys; the designer loads these straight into texture/GLB loaders, which need full
// URLs. Only for the designer-facing /elements responses (admin keeps raw keys for editing).
//
// ONE list, read by BOTH the expander below (which turns these into URLs for the designer) and the
// export bundler (which must copy the objects they name). A nested asset added to one and forgotten
// in the other is an element that promotes to prod with its mask missing — it renders as a frame
// with no window, only for that element type, and nothing says why.
const PLACEMENT_ASSET_PATHS = [
  ['top_alt_glb_url'],
  ['bottom_alt_glb_url'],
  ['photo', 'mask'],
  ['photo', 'overlay'],
];

const atPath = (obj, path) => path.reduce((o, k) => (o == null ? o : o[k]), obj);

/** Every R2 key nested inside a placement_config, in no particular order. Bare keys only — a value
 *  that is already an absolute URL is somebody else's object and is not ours to copy. */
export function placementConfigAssetKeys(pc) {
  if (!pc || typeof pc !== 'object') return [];
  return PLACEMENT_ASSET_PATHS
    .map(path => atPath(pc, path))
    .filter(v => typeof v === 'string' && v && !/^https?:\/\//i.test(v));
}

function expandPlacementConfig(pc) {
  if (!pc || typeof pc !== 'object') return pc;
  // Deep-ish clone only along the paths that change, so untouched branches stay shared.
  const out = { ...pc };
  for (const path of PLACEMENT_ASSET_PATHS) {
    const value = atPath(pc, path);
    if (!value) continue;
    if (path.length === 1) { out[path[0]] = toPublicUrl(value); continue; }
    const [head, ...rest] = path;
    out[head] = { ...out[head] };
    let node = out[head];
    for (let i = 0; i < rest.length - 1; i++) { node[rest[i]] = { ...node[rest[i]] }; node = node[rest[i]]; }
    node[rest[rest.length - 1]] = toPublicUrl(value);
  }
  return out;
}

router.get('/element-types', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('element_types')
      // baker_uploadable: the designer needs it to know which kinds a user may upload into
      // ("My Decorations"). The list of offered kinds is DATA — never a hardcoded array in the client.
      //
      // default_for_uploads: which type an UN-PROMOTED upload behaves as when placed straight onto a
      // cake (it carries no placement of its own — behaviour is authored at promotion). The designer
      // finds it by FILTERING THIS LIST for the flag: no id, no slug, no constant in the client, so the
      // answer can differ per environment and is changed by flipping a boolean, never a deploy.
      .select('id, slug, name, placement_rules, sort_order, default_allowed_actions, baker_uploadable, default_for_uploads')
      .eq('is_active', true)
      .order('sort_order');

    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Browsing categories (migration 065) ──────────────────────────────────────────────────────────
// The decorations MENU, which is a different question from /element-types: that one says how a
// decoration behaves, this one says what it is. A customer hunting for a lion does not care that
// toppers and picks are placed differently.
//
// `count` is the reason this is not just a SELECT. The menu shows categories BEFORE any element is
// fetched, so it has to know a category is worth opening without opening it — and an empty heading
// that turns out to hold nothing is the one thing a category-first menu must not do. Categories
// with no elements are dropped here rather than in the client, so every surface agrees.
router.get('/element-categories', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { data: cats, error } = await supabase
      .from('element_categories')
      .select('id, slug, name, sort_order')
      .eq('is_active', true)
      .order('sort_order');
    if (error) return serverError(req, res, error);

    // Counted over the SAME scope the element list uses — active, top-level, global + this tenant.
    // A count taken over a wider set would promise elements the next request then filters away.
    //
    // The thumbnails come from this same read. A menu of eleven words is a poor door into a library
    // of pictures — people recognise a lion far faster than they read "Animals" — and one preview
    // per category is ~5 KB, so all eleven cost about an eighth of what the flat list did.
    const { data: rows, error: cErr } = await scopeCatalogRead(
      supabase
        .from('cake_elements')
        .select('category_id, thumbnail_url, thumb_key, sort_order')
        .eq('is_active', true)
        .is('parent_id', null)
        .not('category_id', 'is', null)
        .order('sort_order'),
      req,
    );
    if (cErr) return serverError(req, res, cErr);

    const counts = new Map();
    const preview = new Map();
    for (const r of rows) {
      counts.set(r.category_id, (counts.get(r.category_id) ?? 0) + 1);
      // First by sort_order that actually HAS an image. Deterministic, and it is also the element
      // the admin ordered to the front — so the category shows its best decoration, not whichever
      // row the database happened to return first.
      if (!preview.has(r.category_id) && (r.thumb_key || r.thumbnail_url)) {
        preview.set(r.category_id, toPublicUrl(r.thumb_key || r.thumbnail_url));
      }
    }

    res.json(cats
      .map(c => ({ ...c, count: counts.get(c.id) ?? 0, thumbnail_url: preview.get(c.id) ?? null }))
      .filter(c => c.count > 0));
  } catch (err) {
    serverError(req, res, err);
  }
});

router.get('/admin/element-categories', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    // Unfiltered, unlike the customer list: admin picks from every category including the empty and
    // the retired ones — an element has to be assignable to a category before that category has any.
    const { data, error } = await supabase
      .from('element_categories')
      .select('id, slug, name, sort_order, is_active')
      .order('sort_order');
    if (error) return serverError(req, res, error);

    // Counted GLOBALLY here, not through scopeCatalogRead — this is the catalogue owner's view, and
    // "how many decorations would I strand by retiring this?" is the question the number answers.
    const { data: rows } = await supabase
      .from('cake_elements')
      .select('category_id')
      .eq('is_active', true)
      .is('parent_id', null)
      .not('category_id', 'is', null);

    const counts = (rows ?? []).reduce((m, r) => m.set(r.category_id, (m.get(r.category_id) ?? 0) + 1), new Map());
    res.json(data.map(c => ({ ...c, count: counts.get(c.id) ?? 0 })));
  } catch (err) {
    serverError(req, res, err);
  }
});

router.get('/admin/element-types', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('element_types')
      .select('id, slug, name, description, placement_rules, sort_order, is_active, baker_uploadable, default_for_uploads')
      .order('sort_order');

    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// Slug from the name, so the admin types one thing. A category is created mid-task — you are
// filing a new decoration and there is no home for it — and asking for a slug at that moment is a
// second decision about a field nobody sees.
const slugify = (s) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

router.post('/admin/element-categories', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { name, sort_order } = req.body ?? {};
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

    const slug = slugify(name);
    if (!slug) return res.status(400).json({ error: 'name must contain letters or numbers' });

    // Default to the END of the menu rather than 0. A new category landing at the top — above
    // Animals, which holds twelve decorations — would quietly reorder the customer's menu as a side
    // effect of filing one element. Order is a deliberate choice, so it is made deliberately.
    let order = sort_order;
    if (order == null) {
      const { data: last } = await supabase
        .from('element_categories').select('sort_order').order('sort_order', { ascending: false }).limit(1).maybeSingle();
      order = (last?.sort_order ?? 0) + 10;
    }

    const { data, error } = await supabase
      .from('element_categories')
      .insert({ name: name.trim(), slug, sort_order: order, is_active: true })
      .select('id, slug, name, sort_order, is_active')
      .single();

    // 23505 = the slug already exists. "Animals" and "animals" collide, and a raw Postgres error
    // reads as a crash rather than "you already have that one".
    if (error?.code === '23505') return res.status(409).json({ error: `A category called "${name.trim()}" already exists.` });
    if (error) return serverError(req, res, error);
    res.status(201).json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// Rename, reorder, retire. The SLUG is deliberately not editable: nothing user-facing reads it, and
// changing it would break any link or saved filter that does.
router.patch('/admin/element-categories/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { name, sort_order, is_active } = req.body ?? {};
    const patch = {};
    if (name != null)        patch.name       = String(name).trim();
    if (sort_order != null)  patch.sort_order = sort_order;
    // Retiring hides the category from the customer menu; the elements in it keep their category_id
    // and come straight back if it is re-activated. Deleting is not offered here for that reason —
    // the FK is ON DELETE SET NULL, so a delete would silently strip the category off every element
    // it held, and there would be no way back.
    if (is_active != null)   patch.is_active  = is_active;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' });

    const { data, error } = await supabase
      .from('element_categories').update(patch).eq('id', req.params.id)
      .select('id, slug, name, sort_order, is_active').single();
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

router.post('/admin/element-types', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { name, slug, description, placement_rules, sort_order } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'name and slug are required' });

    const { data, error } = await supabase
      .from('element_types')
      .insert({ name, slug, description: description ?? null, placement_rules: placement_rules ?? {}, sort_order: sort_order ?? 0, is_active: true })
      .select('id, slug, name, description, placement_rules, sort_order, is_active, baker_uploadable, default_for_uploads')
      .single();

    if (error) return serverError(req, res, error);
    res.status(201).json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// baker_uploadable + default_for_uploads are AUTHORED HERE, not set by hand in the DB. They are master
// data (which kinds a user may upload; which kind an un-promoted upload behaves as when placed on a
// cake), and master data is authored in admin → API → DB.
//
// default_for_uploads is EXACTLY-ONE, enforced by a unique partial index. So turning it on is a MOVE,
// not a set: clear the incumbent first, or the insert trips the constraint and the admin sees a raw
// 23505. Doing it here — rather than asking the UI to untick the old one first — is what makes the
// invariant true no matter who calls the route.
router.patch('/admin/element-types/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, description, placement_rules, sort_order, is_active, baker_uploadable, default_for_uploads } = req.body;

    if (default_for_uploads === true) {
      const { error: clearErr } = await supabase
        .from('element_types')
        .update({ default_for_uploads: false })
        .eq('default_for_uploads', true)
        .neq('id', id);
      if (clearErr) return serverError(req, res, clearErr);
    }

    const { data, error } = await supabase
      .from('element_types')
      .update({ ...(name != null && { name }), ...(slug != null && { slug }), ...(description !== undefined && { description }), ...(placement_rules != null && { placement_rules }), ...(sort_order != null && { sort_order }), ...(is_active != null && { is_active }), ...(baker_uploadable != null && { baker_uploadable }), ...(default_for_uploads != null && { default_for_uploads }) })
      .eq('id', id)
      .select('id, slug, name, description, placement_rules, sort_order, is_active, baker_uploadable, default_for_uploads')
      .single();

    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

router.get('/elements', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { element_type_id, category_id, parents_only } = req.query;

    const ELEM_FIELDS = 'id, name, description, image_url, thumbnail_url, thumb_key, element_type_id, category_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order';

    if (parents_only === 'true') {
      // SEC-7: global elements + the caller's own tenant only (never another baker's private lib).
      let query = scopeCatalogRead(
        supabase
          .from('cake_elements')
          .select(ELEM_FIELDS)
          .eq('is_active', true)
          .is('parent_id', null)
          .order('sort_order'),
        req,
      );

      if (element_type_id) query = query.eq('element_type_id', element_type_id);
      // Migration 065 — the decorations menu asks for ONE category at a time, which is the whole
      // point: 86 elements and 430 KB of thumbnails become a dozen and 60 KB.
      if (category_id) query = query.eq('category_id', category_id);

      const { data, error } = await query;
      if (error) return serverError(req, res, error);
      return res.json(data.map(el => ({
        ...withPublicUrls(el),
        placement_config: expandPlacementConfig(el.placement_config),
      })));
    }

    // SEC-7: global elements + the caller's own tenant only (never another baker's private lib).
    // This is the LIBRARY: admin-authored elements plus whatever the baker has PROMOTED into their own.
    // A user's uploads are NOT here — they live in baker_uploads, private, and are read from
    // GET /api/uploads (see supabase/baker_uploads.sql for why they were moved out).
    let query = scopeCatalogRead(
      supabase
        .from('cake_elements')
        .select(`${ELEM_FIELDS}, baker_id, parent_id`)
        .eq('is_active', true)
        .order('sort_order'),
      req,
    );

    if (element_type_id) query = query.eq('element_type_id', element_type_id);
    if (category_id)     query = query.eq('category_id', category_id);

    const { data, error } = await query;
    if (error) return serverError(req, res, error);

    res.json(data.map(el => ({
      ...withPublicUrls(el),
      placement_config: expandPlacementConfig(el.placement_config),
    })));
  } catch (err) {
    serverError(req, res, err);
  }
});

// Accepts raw image bytes, strips background, returns PNG bytes.
//
// NOT metered, unlike the baker-facing /api/elements/remove-bg (migration 036). This is
// catalog:admin — us building the Spattoo catalogue — and a baker's credits must never pay for our
// own authoring. Same rule as the decoration guides that ship with a library element.
router.post(
  '/admin/remove-bg',
  requireAuth,
  requireCapability('catalog:admin'),
  express.raw({ type: '*/*', limit: '10mb' }),
  async (req, res) => {
    try {
      const pngBuffer = await removeBackground(req.body);
      res.set('Content-Type', 'image/png');
      res.send(pngBuffer);
    } catch (err) {
      serverError(req, res, err);
    }
  }
);

// The admin element projection — shared by the list and the by-id read so the two can never drift
// (a column added for the list is instantly available to whatever opens a single element).
// EXPLICIT column list, so a new column is invisible to admin until it is named here — which is
// exactly how `medium` appeared to not save at all: the PATCH stored it, the read never returned
// it, and the form reloaded blank. Add new admin-editable columns HERE as well as to the writer.
// created_at is here for the admin list's "added today / 7 days / 30 days" filter. Its absence was
// invisible in the worst way: the filter simply matched nothing, which reads as "you added nothing
// today" rather than "this column never arrived". A hand-maintained field list drops columns
// silently — the reason the export below uses select('*') instead.
const ADMIN_ELEM_FIELDS = 'id, created_at, name, description, image_url, thumbnail_url, thumb_key, element_type_id, category_id, parent_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order, is_active, baker_id, file_size, asset_class, tri_count, texture_max_dim, decoded_mem_kb, optimized_size_kb, over_cap, medium';

// asset_class is a compact surrogate in the DB; admin clients speak the readable key (schema-scale rule).
const toAdminElement = el => ({ ...withPublicUrls(el), asset_class: ASSET_CLASS_KEY[el.asset_class] ?? null });

router.get('/admin/elements', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_elements')
      .select(ADMIN_ELEM_FIELDS)
      .is('baker_id', null)
      .order('sort_order');

    if (error) return serverError(req, res, error);
    res.json(data.map(toAdminElement));
  } catch (err) {
    serverError(req, res, err);
  }
});

// Read ONE global element. Exists so an authoring surface (e.g. the Relief Sticker Studio, opened from
// Manage Elements with ?element=<id>) fetches the row it edits instead of pulling the whole library —
// the library grows without bound, and each row carries a placement_config that can embed an inline
// flatMask data-URI, so the list payload is the wrong thing to hang a single-element read off.
// `.is('baker_id', null)` mirrors the list: this is the GLOBAL catalog, never a baker's private lib.
// ── Export a selection of elements as a portable bundle ──────────────────────────────────────────
// plans/element-preview-and-publish.md. Elements are authored on dev and promoted to prod; this is
// the dev half. The bundle is plain JSON — readable, diffable, and small.
//
// ── IDS ARE CARRIED, NEVER REGENERATED ──────────────────────────────────────────────────────────
// Every row goes out verbatim, id included. `cake_elements.id` is a uuid, so prod can hold the same
// value, and that is what makes the whole thing work: `parent_id` is a self-FK, element_tags and
// element_craft_guide are keyed on the element id, and template/shape DESIGNS embed elementId inside
// their jsonb. Preserve the ids and every one of those keeps pointing at the right thing, with no
// remapping anywhere. Regenerate one and the design references break SILENTLY — the cake still
// renders, but clustering stops working and move/resize caps quietly fall back to defaults.
//
// ── EXPORTING N ELEMENTS IS NEVER N ROWS ────────────────────────────────────────────────────────
// The closure travels too: element types (element_type_id is a FK — the insert fails in prod without
// it), parent elements (parent_id), tags, the element_tags joins, and craft guides.
//
// ── ASSETS ARE URLs, NOT BYTES ──────────────────────────────────────────────────────────────────
// The bundle names each object by its KEY plus a public URL to fetch it from. Import downloads and
// re-uploads under the SAME key, so the row needs no rewriting — the DB stores bare keys and each
// environment composes its own URL via toPublicUrl. Base64 would inflate a GLB by a third for no
// gain, and a zip would need a dependency on both sides.
//
// This makes a bundle TRANSIENT: it points at dev's bucket, so export and import within a sensible
// window rather than filing it away for months.
router.get('/admin/elements/export', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const ids = String(req.query.ids || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'ids is required (comma-separated)' });

    const c = await elementClosure(ids);
    if (!c.elements.length) return res.status(404).json({ error: 'No global elements matched those ids' });

    res.json({
      format: 'spattoo-element-bundle',
      version: 1,
      exported_at: new Date().toISOString(),
      // Recorded so an import can say WHERE a bundle came from — and notice one aimed at itself.
      source: { r2_public_url: config.r2.publicUrl },
      // Insert order. Types and tags first: elements and joins reference them.
      element_types:       c.element_types,
      tags:                c.tags,
      elements:            c.elements,
      element_tags:        c.element_tags,
      element_craft_guide: c.element_craft_guide,
      assets: [...c.keys].map(key => ({ key, url: toPublicUrl(key) })),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Import a bundle ──────────────────────────────────────────────────────────────────────────────
// The prod half of the promotion. Takes what /admin/elements/export produced and writes it here.
//
// `?dryRun=true` reports what WOULD happen and writes nothing — which is the mode to use first,
// because the interesting number is how many prod rows an import is about to overwrite.
//
// ── EVERY ROW KEEPS ITS ID ──────────────────────────────────────────────────────────────────────
// Upsert on the primary key. That makes a re-import an UPDATE of the same element rather than a
// twin, and it is why template and shape designs — which embed elementId inside their jsonb — keep
// resolving after promotion. A row arriving without an id is refused rather than inserted: letting
// the database mint one produces an element that looks right and is silently a different element.
//
// ── SHARED VOCABULARY IS THE SHARP EDGE ─────────────────────────────────────────────────────────
// element_types and tags are vocabulary, not per-element data. If this environment already holds a
// tag whose slug matches an incoming one under a DIFFERENT id, then: the tag insert violates
// tags.slug UNIQUE, and the bundle's element_tags rows point at a tag_id that does not exist here.
// Neither is recoverable by guessing — matching on slug silently rebinds the elements, matching on
// id duplicates the vocabulary. So it stops and reports, and a human decides.
// Body size is the GLOBAL express.json({ limit: '5mb' }) in server.js — a per-route parser here
// would be a no-op, since body-parser skips a request whose body is already parsed. 5mb is ample:
// a bundle carries rows and asset URLs, never asset bytes.
router.post('/admin/elements/import', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const bundle = req.body;
    const dryRun = String(req.query.dryRun || '') === 'true';

    if (bundle?.format !== 'spattoo-element-bundle') return res.status(400).json({ error: 'Not an element bundle' });
    if (bundle.version !== 1) return res.status(400).json({ error: `Unsupported bundle version ${bundle.version}` });

    const elements     = bundle.elements            ?? [];
    const types        = bundle.element_types       ?? [];
    const tags         = bundle.tags                ?? [];
    const elementTags  = bundle.element_tags        ?? [];
    const craftGuides  = bundle.element_craft_guide ?? [];
    const assets       = bundle.assets              ?? [];
    // Present only in a template bundle. Absent ones read as empty, so an element bundle exported
    // before templates existed still imports unchanged.
    const templates    = bundle.cake_templates      ?? [];
    const templateTags = bundle.template_tags       ?? [];
    const templateAttrs= bundle.cake_template_attrs ?? [];
    if (!elements.length && !templates.length) return res.status(400).json({ error: 'Bundle contains nothing to import' });

    // A row with no id would be minted a new one — see above. Refuse the whole bundle.
    const idless = [
      ...elements.filter(r => !r.id).map(() => 'element'),
      ...types.filter(r => !r.id).map(() => 'element_type'),
      ...tags.filter(r => !r.id).map(() => 'tag'),
      ...templates.filter(r => !r.id).map(() => 'template'),
    ];
    if (idless.length) return res.status(400).json({ error: `Bundle has ${idless.length} row(s) with no id — refusing rather than generating one` });

    // ── Vocabulary collisions, before anything is written ──────────────────────────────────────
    const collisions = [];
    for (const [table, rows] of [['element_types', types], ['tags', tags]]) {
      const slugs = rows.map(r => r.slug).filter(Boolean);
      if (!slugs.length) continue;
      const { data, error } = await supabase.from(table).select('id, slug').in('slug', slugs);
      if (error) return serverError(req, res, error);
      for (const here of data ?? []) {
        const incoming = rows.find(r => r.slug === here.slug);
        if (incoming && incoming.id !== here.id) {
          collisions.push({ table, slug: here.slug, here: here.id, incoming: incoming.id });
        }
      }
    }
    if (collisions.length) {
      return res.status(409).json({
        error: 'Same slug, different id — this environment already has that vocabulary under another id. ' +
               'Reconcile by hand: matching on slug would silently rebind, matching on id would duplicate.',
        collisions,
      });
    }

    // ── What already exists here (create vs update) ────────────────────────────────────────────
    const existing = async (table, col, values) => {
      if (!values.length) return new Set();
      const { data, error } = await supabase.from(table).select(col).in(col, values);
      if (error) throw error;
      return new Set((data ?? []).map(r => r[col]));
    };
    const haveElements = await existing('cake_elements', 'id', elements.map(e => e.id));
    const haveTypes    = await existing('element_types', 'id', types.map(t => t.id));
    const haveTags     = await existing('tags',          'id', tags.map(t => t.id));
    const haveTemplates = await existing('cake_templates', 'id', templates.map(t => t.id));

    const plan = {
      element_types:       { create: types.filter(t => !haveTypes.has(t.id)).length,       update: types.filter(t => haveTypes.has(t.id)).length },
      tags:                { create: tags.filter(t => !haveTags.has(t.id)).length,         update: tags.filter(t => haveTags.has(t.id)).length },
      elements:            { create: elements.filter(e => !haveElements.has(e.id)).length, update: elements.filter(e => haveElements.has(e.id)).length },
      cake_templates:      { create: templates.filter(t => !haveTemplates.has(t.id)).length, update: templates.filter(t => haveTemplates.has(t.id)).length },
      element_tags:        { rows: elementTags.length },
      element_craft_guide: { rows: craftGuides.length },
      assets:              { count: assets.length },
      same_environment:    bundle.source?.r2_public_url === config.r2.publicUrl,
    };
    if (dryRun) return res.json({ dryRun: true, plan, collisions: [] });

    // ── Assets first: a row pointing at an object that is not there yet renders broken ─────────
    const assetErrors = [];
    for (const a of assets) {
      try {
        const r = await fetch(a.url);
        if (!r.ok) throw new Error(`fetch ${r.status}`);
        const buf = Buffer.from(await r.arrayBuffer());
        await putObject(a.key, buf, r.headers.get('content-type') || 'application/octet-stream');
      } catch (e) {
        assetErrors.push({ key: a.key, error: e.message });
      }
    }

    // ── Rows, in dependency order ──────────────────────────────────────────────────────────────
    // Parents before children: parent_id is a self-FK, and a single upsert array gives no ordering
    // guarantee, so a child inserted first would fail against a parent that is still on its way.
    const parents  = elements.filter(e => !e.parent_id);
    const children = elements.filter(e => e.parent_id);
    // Templates come last and their parents before their children, for the same reason elements do:
    // parent_template_id is a self-FK, and a single upsert array gives no ordering guarantee.
    const tplParents  = templates.filter(t => !t.parent_template_id);
    const tplChildren = templates.filter(t => t.parent_template_id);
    const steps = [
      ['element_types',       types],
      ['tags',                tags],
      ['cake_elements',       parents],
      ['cake_elements',       children],
      ['element_tags',        elementTags],
      ['element_craft_guide', craftGuides],
      ['cake_templates',      tplParents],
      ['cake_templates',      tplChildren],
      ['template_tags',       templateTags],
      ['cake_template_attrs', templateAttrs],
    ];
    // Absolute URLs → THIS environment's host. cake_templates.design stores fully-qualified URLs
    // rather than bare keys (nothing expands a design on the way out — toPublicUrl is applied to
    // thumbnail_url only), so a bundle imported verbatim would leave every template here fetching
    // its textures from the environment it was exported FROM. The object was copied under the same
    // key, so only the host in front of it moves. Same rewrite the rollout script does.
    const fromBase = bundle.source?.r2_public_url;
    for (const [table, rows] of steps) {
      if (!rows.length) continue;
      const { error } = await supabase.from(table).upsert(rewriteAssetHost(rows, fromBase, config.r2.publicUrl));
      if (error) return res.status(500).json({ error: `${table}: ${error.message}`, plan, assetErrors });
    }

    res.json({ ok: true, plan, assetErrors });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── The same element, shaped the way the DESIGNER receives it ─────────────────────────────────────
// For the admin preview (spattoo-core ElementPreview), which renders through the designer's own
// addSticker + CakePreview and therefore needs the designer's own inputs.
//
// A separate route rather than a flag on the one above, because the two shapes are genuinely
// different and both are needed: the editor form must see RAW R2 keys to write them back, and the
// renderer must see PUBLIC URLs to load them. Serve the raw shape to the renderer and a photo-frame
// element previews with no mask — silently, and only for that one element type, which is exactly the
// kind of not-quite-right preview that would teach an admin to distrust the screen.
//
// Unlike the baker-facing GET this does NOT filter on is_active: previewing an element before it is
// live is the entire point.
router.get('/admin/elements/:id/preview', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_elements')
      .select(ADMIN_ELEM_FIELDS)
      .eq('id', req.params.id)
      .is('baker_id', null)
      .maybeSingle();

    if (error) return serverError(req, res, error);
    if (!data) return res.status(404).json({ error: 'Element not found' });
    // withPublicUrls for the top-level image/thumbnail columns, expandPlacementConfig for the keys
    // nested inside it — the same pair the designer-facing list applies (`:203`, `:227`), called
    // rather than reimplemented so the two cannot drift.
    res.json({
      ...withPublicUrls(data),
      placement_config: expandPlacementConfig(data.placement_config),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

router.get('/admin/elements/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_elements')
      .select(ADMIN_ELEM_FIELDS)
      .eq('id', req.params.id)
      .is('baker_id', null)
      .maybeSingle();

    if (error) return serverError(req, res, error);
    if (!data) return res.status(404).json({ error: 'Element not found' });
    res.json(toAdminElement(data));
  } catch (err) {
    serverError(req, res, err);
  }
});

router.patch('/admin/elements/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, image_url, thumbnail_url, element_type_id, category_id, parent_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order, is_active, file_size, medium } = req.body;

    const updates = {};
    if (name            != null)      updates.name             = name;
    if (description     !== undefined) updates.description     = description;
    if (image_url       !== undefined) updates.image_url        = image_url;
    if (thumbnail_url   !== undefined) updates.thumbnail_url    = thumbnail_url;
    if (element_type_id != null)      updates.element_type_id  = element_type_id;
    // Browsing category (migration 065). `!== undefined`, not `!= null`, so an explicit null CLEARS
    // it — an element pulled out of a category is a real edit, and the alternative would be that a
    // wrong category can be changed but never removed.
    if (category_id     !== undefined) updates.category_id      = category_id;
    if (parent_id       !== undefined) updates.parent_id        = parent_id;
    if (allowed_zones   != null)      updates.allowed_zones    = allowed_zones;
    if (placement_config!= null)      updates.placement_config = placement_config;
    if (allowed_actions != null)      updates.allowed_actions  = allowed_actions;
    if (default_color   !== undefined) updates.default_color    = default_color;
    if (sort_order      != null)      updates.sort_order       = sort_order;
    if (is_active       != null)      updates.is_active        = is_active;
    // Sent alongside a new image_url when an asset is replaced; null clears a stale size.
    if (file_size       !== undefined) updates.file_size        = file_size;
    // Material (migration 032). Editable after publish because it is often only settled once
    // someone looks at the real decoration — and changing it changes what X-Ray offers, so it
    // must not be write-once at create.
    if (medium          !== undefined) updates.medium           = medium || null;
    // GLB cost stats (re-sent when a 3D asset is replaced via the Studio review).
    Object.assign(updates, glbStatColumns(req.body));

    const { data, error } = await supabase
      .from('cake_elements')
      .update(updates)
      .eq('id', id)
      .select('id')
      .single();

    if (error) return serverError(req, res, error);
    res.json(data);
    // Re-index when something that affects the search text/embedding changed. Fire-and-forget.
    if (['name', 'description', 'thumbnail_url', 'image_url'].some(k => k in updates))
      reindexElement(id).catch(e => console.error('reindex(update) failed:', e.message));
    // Regenerate the optimised WebP thumbnail when the raw thumbnail changed. Fire-and-forget.
    if ('thumbnail_url' in updates) ensureThumbKey(id, updates.thumbnail_url);
  } catch (err) {
    serverError(req, res, err);
  }
});

// Pre-build the modelling guide for a decoration we are publishing.
//
// AFTER the response and fire-and-forget: a slow or failed model call must not make publishing an
// element slow or fail. The guide enhances the catalogue; it is not part of the element being
// valid, and the baker-facing route can still generate one on demand if this never ran.
//
// Re-reads the row rather than trusting the request body, because the policy needs the element's
// TYPE — and because thumb_key is written by a separate fire-and-forget job. image_url is often a
// .glb or .svg that the vision endpoint rejects outright, so the raster is what makes this work at
// all for exactly the elements that need it most.
async function ensureDecorationGuide(elementId) {
  try {
    const { data: el } = await supabase
      .from('cake_elements')
      .select('id, name, description, image_url, thumbnail_url, thumb_key, medium, element_types(name)')
      .eq('id', elementId).maybeSingle();
    if (!el) return;

    // Element type first, medium only for the flat placeables where an image genuinely cannot say
    // fondant from printed sheet from acrylic (services/decorationPolicy.js).
    const policy = decorationPolicy(el);
    if (!policy.modelling) return;

    const out = await buildElementGuide(el, { ownerBakerId: null });   // ours, never a baker's
    if (out.status !== 'ok') console.log(`[element-guide] ${elementId}: ${out.status}`);
  } catch (e) {
    console.error(`[element-guide] ${elementId} failed:`, e.message);
  }
}

router.post('/admin/elements', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { name, description, image_url, thumbnail_url, element_type_id, category_id, parent_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order, file_size, medium } = req.body;
    if (!name || !element_type_id) {
      return res.status(400).json({ error: 'name and element_type_id are required' });
    }

    const { data, error } = await supabase
      .from('cake_elements')
      .insert({
        name,
        description:      description ?? '',
        image_url,
        thumbnail_url,
        element_type_id,
        // NOT required, unlike element_type_id. A decoration without a type cannot be placed at
        // all; one without a category simply has no home in the browsing menu yet, and forcing the
        // choice at create time would only produce a habit of picking the first option.
        category_id:      category_id ?? null,
        parent_id:        parent_id ?? null,
        allowed_zones,
        placement_config: placement_config ?? {},
        allowed_actions:  allowed_actions  ?? { resize: true, duplicate: true, color: false, delete: true },
        default_color:    default_color ?? null,
        sort_order:       sort_order ?? 0,
        file_size:        file_size ?? null,
        // WHAT IT IS MADE OF. Technique already lives in element_types (Cream Piping vs Palette
        // knife art), so this is material only — see migration 032. A HINT for what we pre-build,
        // never a restriction on what a baker may do with the decoration.
        medium:           medium ?? null,
        ...glbStatColumns(req.body),
        baker_id:         null,
        is_active:        true,
      })
      .select('id')
      .single();

    if (error) return serverError(req, res, error);

    res.status(201).json({ id: data.id });
    // Index for inspiration matching (fills an empty description + embeds). Fire-and-forget.
    reindexElement(data.id).catch(e => console.error('reindex(create) failed:', e.message));
    // Generate the optimised WebP picker thumbnail (raw PNG stays as the source). Fire-and-forget.
    ensureThumbKey(data.id, thumbnail_url);
    // A catalogue decoration should ARRIVE with its guide, so that no baker is ever the one who
    // triggers it. Ours to pay for and therefore unmetered.
    ensureDecorationGuide(data.id);
  } catch (err) {
    serverError(req, res, err);
  }
});

router.post('/admin/elements/suggest', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { imageBase64, mimeType, elementType } = req.body;
    if (!imageBase64 || !mimeType) return res.status(400).json({ error: 'imageBase64 and mimeType are required' });

    // Fetch existing names for collision detection
    const { data: existing } = await supabase
      .from('cake_elements')
      .select('name')
      .is('baker_id', null);
    const existingNames = new Set((existing ?? []).map(e => e.name.toLowerCase()));

    const prompt = `You are naming cake decoration elements for a professional bakery platform.
Analyse this element image and suggest names and search keywords.

Element type context: ${elementType || 'cake decoration'}

Rules for names:
- Title Case, maximum 3 words
- Lead with the most distinctive visual feature (shape, style, or texture) — not the type
- Be specific enough that two similar shapes get different names (e.g. "Open Star Swirl" vs "Closed Shell Curl")
- Do NOT use generic words like "Design", "Style", "Type", "Element", "Pattern"
- Think like a professional cake decorator naming a piping tip result

Rules for description (search keywords):
- Comma-separated keywords only — no sentences
- 8 to 12 keywords covering: shape, technique, style, nozzle/tip type, occasions, alternative names bakers use
- Think about every way a baker might search for this element
- Examples: "scroll piping, royal scroll, vintage scroll, baroque flourish, lambeth scroll, wedding cake, ornamental border, buttercream swirl"

Return ONLY valid JSON, no explanation:
{
  "names": ["<most specific name>", "<alternative name>", "<third option>"],
  "description": "<comma-separated search keywords>"
}`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.openai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: 'low' } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('OpenAI suggest error:', errText);
      throw new Error(`OpenAI error: ${errText}`);
    }
    const data = await response.json();
    const raw  = data.choices[0].message.content.trim();
    const json = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
    const { names, description } = JSON.parse(json);

    // Apply roman numeral suffix for any name that already exists
    const suffixed = names.map(name => {
      const base = name.trim();
      if (!existingNames.has(base.toLowerCase())) return base;
      const numerals = ['II', 'III', 'IV', 'V'];
      for (const n of numerals) {
        const candidate = `${base} ${n}`;
        if (!existingNames.has(candidate.toLowerCase())) return candidate;
      }
      return base;
    });

    res.json({ names: suffixed, description });
  } catch (err) {
    console.error('suggest error:', err.message, err.stack);
    serverError(req, res, err);
  }
});

export default router;
