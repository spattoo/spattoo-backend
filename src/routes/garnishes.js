import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { putObject, deleteObject } from '../services/r2.js';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { toPublicUrl } from './elements.js';
import { UPLOADED_BY } from '../constants/uploads.js';

const router = Router();

// ── Garnishes — chocolate pieces someone piped in the studio and kept ────────────────────────────
//
// The drawing is the PATHS, not a picture: see supabase/baker_garnishes.sql for why an image would be
// the wrong thing to store, and why the fill patterns are named rather than expanded.
//
// ⚠️ THE SAME TENANCY MODEL AS UPLOADS, deliberately. A garnish is private to the person who drew it,
// scoped inside a bakery, and the two tables answer "whose is this" identically — one fence
// (`baker_id`) and one authorship pair (`created_by_type`, `created_by_id`). Uploads got this wrong
// once, with a single column meaning both "who may see this" and "whose data is this", and a child's
// photo appeared in every other customer's picker. Copying the fixed shape is the point.

// ⚠️ A CEILING, because `payload` is user-generated. The DB has its own 256 KB check; this one exists
// so an oversized piece is refused with a sentence rather than a constraint violation.
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_NAME = 60;

const shape = g => ({
  id:        g.id,
  name:      g.name,
  payload:   g.payload,
  thumbUrl:  g.thumb_key ? toPublicUrl(g.thumb_key) : null,
  createdAt: g.created_at,
});

/* Who is asking, in the same two-part form the table stores. A baker's staff share a tenant, so a
 * garnish drawn by one member of a bakery belongs to the bakery — the same rule uploads uses for a
 * baker's own material. */
const authorOf = req => (req.customerId
  ? { type: UPLOADED_BY.CUSTOMER, id: req.customerId }
  : { type: UPLOADED_BY.BAKER_APPUSER, id: req.user.id });

/* ⚠️ VALIDATE THE SHAPE, not just the size. `payload` is drawn into geometry the moment a cake using
 * it is opened, and a malformed path there is a render crash on somebody else's screen rather than a
 * 400 here. Cheap to check, and the only place it can be checked once for every writer. */
function invalidPayload(p) {
  if (!p || typeof p !== 'object') return 'payload must be an object';
  if (p.v !== 1) return 'unsupported payload version';
  if (!Number.isFinite(p.plate) || p.plate <= 0) return 'payload.plate must be a positive number';
  if (!Number.isFinite(p.rope) || p.rope <= 0) return 'payload.rope must be a positive number';
  if (!Array.isArray(p.strokes) || p.strokes.length === 0) return 'payload.strokes must be a non-empty array';
  for (const s of p.strokes) {
    if (!s || !Array.isArray(s.path) || s.path.length < 2) return 'every stroke needs a path of at least two points';
    for (const pt of s.path) {
      if (!Array.isArray(pt) || pt.length !== 2 || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) {
        return 'every point must be a pair of numbers';
      }
    }
    if (s.fill != null && typeof s.fill !== 'string') return 'stroke.fill must be a pattern name or null';
    /* A shape may carry its OWN chocolate — white inside dark — and absent means "follow the piece".
       Checked as a CSS colour rather than left free: it is written straight into a material, where a
       malformed value is a silent black piece on someone else's cake. */
    if (s.color != null && !/^#[0-9a-f]{3,8}$/i.test(String(s.color))) return 'stroke.color must be a hex colour';
  }
  return null;
}

// ── List mine ────────────────────────────────────────────────────────────────────────────────────
router.get('/garnishes', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });
    const who = authorOf(req);
    const { data, error } = await supabase
      .from('baker_garnishes')
      .select('id, name, payload, thumb_key, created_at')
      .eq('baker_id', req.bakerId)                 // tenant fence, always
      .eq('created_by_type', who.type)
      .eq('created_by_id', who.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    res.json((data ?? []).map(shape));
  } catch (err) { serverError(res, err, 'Failed to list garnishes'); }
});

// ── Keep one ─────────────────────────────────────────────────────────────────────────────────────
router.post('/garnishes', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });
    const { name, payload, thumbBase64 } = req.body ?? {};

    const bad = invalidPayload(payload);
    if (bad) return res.status(400).json({ error: bad });
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
      return res.status(413).json({ error: 'That piece is too detailed to save. Try a simpler fill.' });
    }

    /* ⚠️ THE THUMBNAIL MUST NOT BE ABLE TO COST THE DRAWING. It is drawn client-side from the same
       paths, so a failure here means a tile is missing — not that the piece the baker just spent five
       minutes on is gone. Stored first so a successful row always points at a real object, and its
       failure is swallowed rather than propagated. */
    let thumbKey = null;
    if (typeof thumbBase64 === 'string' && thumbBase64.length) {
      try {
        const png = Buffer.from(thumbBase64.replace(/^data:image\/png;base64,/, ''), 'base64');
        thumbKey = `garnishes/thumbs/${randomUUID()}.png`;
        await putObject(thumbKey, png, 'image/png');
      } catch (e) {
        console.error('Garnish thumbnail failed; saving without one', e);
        thumbKey = null;
      }
    }

    const who = authorOf(req);
    const { data, error } = await supabase
      .from('baker_garnishes')
      .insert({
        baker_id: req.bakerId,
        created_by_type: who.type,
        created_by_id: who.id,
        for_customer_id: req.customerId ?? null,
        name: String(name ?? '').trim().slice(0, MAX_NAME) || 'Chocolate piece',
        payload,
        thumb_key: thumbKey,
      })
      .select('id, name, payload, thumb_key, created_at')
      .single();
    if (error) {
      // The row did not land, so the object we just wrote has nothing pointing at it.
      if (thumbKey) await deleteObject(thumbKey).catch(() => {});
      throw new Error(error.message);
    }
    res.status(201).json(shape(data));
  } catch (err) { serverError(res, err, 'Failed to save the garnish'); }
});

// ── Put one away ─────────────────────────────────────────────────────────────────────────────────
/* ⚠️ SOFT DELETE, and the object stays. A design carries its OWN copy of the paths, so removing a
 * garnish from the library must never change a cake already made with it — and a hard delete would
 * leave no trail for moderation or erasure, which are the two reasons a row is ever removed. */
router.delete('/garnishes/:id', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });
    const who = authorOf(req);
    const { data, error } = await supabase
      .from('baker_garnishes')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('baker_id', req.bakerId)                 // tenant fence
      .eq('created_by_type', who.type)             // and only your own
      .eq('created_by_id', who.id)
      .is('deleted_at', null)
      .select('id');
    if (error) throw new Error(error.message);
    if (!data?.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) { serverError(res, err, 'Failed to remove the garnish'); }
});

// ── Every bakery's pieces, for an author choosing what to publish ────────────────────────────────
//
// ⚠️ NO TENANT FENCE, WHICH IS WHY IT IS `catalog:admin`. Every other list in this file is fenced to
// the caller's own bakery and their own authorship, because a baker may only ever see their own work.
// This one deliberately crosses that line — an author curating the catalogue has to be able to look
// at what bakers have drawn — so it is gated on the capability that already means "you administer
// the catalogue", and it must never be reachable with `element:manage`.
//
// `published` says whether this piece is ALREADY in the catalogue, so the screen can show it rather
// than letting an author publish the same drawing twice and wonder why there are two.
router.get('/admin/garnishes', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('baker_garnishes')
      .select('id, baker_id, name, payload, thumb_key, created_at')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    /* A published copy is DETACHED (see the publish route), so there is no foreign key to follow.
       Matching on the stored drawing is what is left, and it is exact: the payload is the piece. */
    const { data: published } = await supabase
      .from('cake_elements')
      .select('id, placement_config')
      .eq('medium', 'chocolate')
      .is('baker_id', null)
      .is('deleted_at', null);
    const seen = new Set((published ?? [])
      .map(e => e.placement_config?.garnish && JSON.stringify(e.placement_config.garnish))
      .filter(Boolean));

    res.json((data ?? []).map(g => ({
      ...shape(g),
      bakerId: g.baker_id,
      published: seen.has(JSON.stringify(g.payload)),
    })));
  } catch (err) { serverError(res, err, 'Failed to list garnishes'); }
});

// ── Publish one to the GLOBAL catalogue ──────────────────────────────────────────────────────────
//
// ⚠️ THE WIDEST BLAST RADIUS IN THE PRODUCT, and the gate is sized for that. A baker promoting an
// upload puts it in ONE bakery's picker; this puts a piece in front of EVERY bakery and every one of
// their customers. So it is `catalog:admin` — the author gate that guards element types and
// categories — and never `element:manage`, which every baker holds.
//
// ⚠️ THE PATHS ARE THE ELEMENT, not a picture of one. A published garnish carries its strokes in
// `placement_config`, so it arrives in the catalogue able to be re-coloured, re-filled and — the
// reason any of this was built — to produce its own X-ray build guide. An image could do none of
// that, which is the whole argument in supabase/baker_garnishes.sql.
//
// ⚠️ THE COPY IS DETACHED, deliberately, and this is the one decision here that cannot be undone
// later. `baker_uploads` links its promoted copy back (`source_upload_id`) so erasure can reach it;
// a garnish does not, because the audiences differ. An upload is one bakery's own image and its
// owner may need it withdrawn; a published garnish is catalogue furniture that other bakeries have
// designed cakes with, and letting the author's later "delete" reach into those is worse than the
// storage it saves. Withdrawing one is `is_active = false` on the element, by an author.
router.post('/garnishes/:id/publish', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { element_type_id, category_id, name, description } = req.body ?? {};
    if (!element_type_id) return res.status(400).json({ error: 'element_type_id is required' });

    /* ⚠️ NO TENANT FENCE HERE, and that is the point of the capability check above: an author works
       across bakeries. Every other route in this file is fenced to `req.bakerId` because a baker may
       only ever touch their own; this one is reached by a role that does not belong to a bakery. */
    const { data: g, error } = await supabase
      .from('baker_garnishes')
      .select('id, name, payload, thumb_key')
      .eq('id', req.params.id)
      .is('deleted_at', null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!g) return res.status(404).json({ error: 'Not found' });

    const bad = invalidPayload(g.payload);
    if (bad) return res.status(400).json({ error: `That piece cannot be published: ${bad}` });

    const { data: el, error: insErr } = await supabase
      .from('cake_elements')
      .insert({
        name: String(name ?? g.name ?? 'Chocolate garnish').trim().slice(0, MAX_NAME),
        description: description ?? '',
        element_type_id,
        category_id: category_id ?? null,
        /* ⚠️ THE BARE KEY, NOT A URL. The DB stores keys and `lib/publicUrl.js` expands them on the
           way out — every other element row does this. Storing the expanded URL here would have been
           double-expanded on read, and worse, invisible to the export walk, which recognises our
           objects by their KEY prefix: the element would promote to prod carrying a dev URL that
           prod's bucket never received a copy of. */
        thumbnail_url: g.thumb_key ?? null,
        // The drawing itself. `garnish` is read by the designer to rebuild the piece.
        placement_config: { garnish: g.payload },
        allowed_zones: ['top_surface', 'board'],
        allowed_actions: { resize: true, duplicate: true, color: true, delete: true },
        medium: 'chocolate',
        baker_id: null,              // global — this is what "catalogue" means
        is_active: true,
      })
      .select('id')
      .single();
    if (insErr) throw new Error(insErr.message);

    res.status(201).json({ id: el.id });
  } catch (err) { serverError(res, err, 'Failed to publish the garnish'); }
});

export default router;
