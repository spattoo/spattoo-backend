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

export default router;
