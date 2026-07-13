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

const router = Router();

// EXPORTED so the baker-facing routes (routes/uploads.js) expand keys the SAME way — one place
// decides how a stored key becomes a loadable URL.
export function toPublicUrl(key) {
  if (!key) return null;
  if (/^https?:\/\//i.test(key)) return key;   // already a full URL — don't double-prefix
  return `${config.r2.publicUrl}/${key}`;
}

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
function expandPlacementConfig(pc) {
  if (!pc || typeof pc !== 'object') return pc;
  const out = { ...pc };
  if (out.top_alt_glb_url)    out.top_alt_glb_url    = toPublicUrl(out.top_alt_glb_url);
  if (out.bottom_alt_glb_url) out.bottom_alt_glb_url = toPublicUrl(out.bottom_alt_glb_url);
  if (out.photo?.mask || out.photo?.overlay) {
    out.photo = { ...out.photo };
    if (out.photo.mask)    out.photo.mask    = toPublicUrl(out.photo.mask);
    if (out.photo.overlay) out.photo.overlay = toPublicUrl(out.photo.overlay);
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

router.get('/admin/element-types', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('element_types')
      .select('id, slug, name, description, placement_rules, sort_order, is_active')
      .order('sort_order');

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
      .select('id, slug, name, description, placement_rules, sort_order, is_active')
      .single();

    if (error) return serverError(req, res, error);
    res.status(201).json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

router.patch('/admin/element-types/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, slug, description, placement_rules, sort_order, is_active } = req.body;

    const { data, error } = await supabase
      .from('element_types')
      .update({ ...(name != null && { name }), ...(slug != null && { slug }), ...(description !== undefined && { description }), ...(placement_rules != null && { placement_rules }), ...(sort_order != null && { sort_order }), ...(is_active != null && { is_active }) })
      .eq('id', id)
      .select('id, slug, name, description, placement_rules, sort_order, is_active')
      .single();

    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

router.get('/elements', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { element_type_id, parents_only } = req.query;

    const ELEM_FIELDS = 'id, name, description, image_url, thumbnail_url, thumb_key, element_type_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order';

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

// Accepts raw image bytes, strips background, returns PNG bytes
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
const ADMIN_ELEM_FIELDS = 'id, name, description, image_url, thumbnail_url, thumb_key, element_type_id, parent_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order, is_active, baker_id, file_size, asset_class, tri_count, texture_max_dim, decoded_mem_kb, optimized_size_kb, over_cap';

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
    const { name, description, image_url, thumbnail_url, element_type_id, parent_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order, is_active, file_size } = req.body;

    const updates = {};
    if (name            != null)      updates.name             = name;
    if (description     !== undefined) updates.description     = description;
    if (image_url       !== undefined) updates.image_url        = image_url;
    if (thumbnail_url   !== undefined) updates.thumbnail_url    = thumbnail_url;
    if (element_type_id != null)      updates.element_type_id  = element_type_id;
    if (parent_id       !== undefined) updates.parent_id        = parent_id;
    if (allowed_zones   != null)      updates.allowed_zones    = allowed_zones;
    if (placement_config!= null)      updates.placement_config = placement_config;
    if (allowed_actions != null)      updates.allowed_actions  = allowed_actions;
    if (default_color   !== undefined) updates.default_color    = default_color;
    if (sort_order      != null)      updates.sort_order       = sort_order;
    if (is_active       != null)      updates.is_active        = is_active;
    // Sent alongside a new image_url when an asset is replaced; null clears a stale size.
    if (file_size       !== undefined) updates.file_size        = file_size;
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

router.post('/admin/elements', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { name, description, image_url, thumbnail_url, element_type_id, parent_id, allowed_zones, placement_config, allowed_actions, default_color, sort_order, file_size } = req.body;
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
        parent_id:        parent_id ?? null,
        allowed_zones,
        placement_config: placement_config ?? {},
        allowed_actions:  allowed_actions  ?? { resize: true, duplicate: true, color: false, delete: true },
        default_color:    default_color ?? null,
        sort_order:       sort_order ?? 0,
        file_size:        file_size ?? null,
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
