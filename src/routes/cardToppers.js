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

// ── Card toppers — compositions someone made in the card topper studio and kept ─────────────────
//
// What is stored is the OBJECT LIST, not the cut contours and not a picture: see
// supabase/baker_card_toppers.sql for the argument, which is the one baker_garnishes.sql makes about
// fills.
//
// ⚠️ THE SAME TENANCY MODEL AS UPLOADS AND GARNISHES, deliberately. One fence (`baker_id`) and one
// authorship pair (`created_by_type`, `created_by_id`). Uploads got this wrong once, with a single
// column meaning both "who may see this" and "whose data is this", and a child's photo appeared in
// every other customer's picker. Copying the fixed shape is the point.

// ⚠️ A CEILING, because `payload` is user-generated. The DB has its own 64 KB check; this one exists
// so an oversized piece is refused with a sentence rather than a constraint violation.
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_NAME = 60;
// Generous, and here only so a runaway client cannot post a million-object array for the loop below
// to walk. Nobody composes a topper out of fifty pieces.
const MAX_OBJECTS = 50;

const shape = t => ({
  id:        t.id,
  name:      t.name,
  payload:   t.payload,
  thumbUrl:  t.thumb_key ? toPublicUrl(t.thumb_key) : null,
  createdAt: t.created_at,
});

/* Who is asking, in the same two-part form the table stores. A baker's staff share a tenant, so a
 * topper composed by one member of a bakery belongs to the bakery. */
const authorOf = req => (req.customerId
  ? { type: UPLOADED_BY.CUSTOMER, id: req.customerId }
  : { type: UPLOADED_BY.BAKER_APPUSER, id: req.user.id });

const isHex = v => /^#[0-9a-f]{3,8}$/i.test(String(v));

/* ⚠️ VALIDATE THE SHAPE, not just the size. `payload` is cut into geometry the moment a cake using it
 * is opened, and a malformed object there is a render crash on somebody else's screen rather than a
 * 400 here. Cheap to check, and the only place it can be checked once for every writer.
 *
 * ⚠️ IT CHECKS TYPES, NOT VOCABULARY. `family` and `face` are validated as short slugs rather than
 * against a list of the shapes and fonts that exist today — a new shape in the studio is config, and
 * it must not need a backend deploy to become saveable (rule 2). An unknown one is the client's
 * problem to fall back on, and it already does. */
function invalidPayload(p) {
  if (!p || typeof p !== 'object') return 'payload must be an object';
  if (p.v !== 1) return 'unsupported payload version';
  if (!Array.isArray(p.objects) || p.objects.length === 0) return 'payload.objects must be a non-empty array';
  if (p.objects.length > MAX_OBJECTS) return 'that is more pieces than a topper can hold';

  /* The stick belongs to the whole topper, not to a piece on it — a card has one stick however many
     words are cut into it. Absent means no stick, which is every topper saved before they existed.
     `bury` is a FRACTION of the stick, so it cannot be a length that outgrows one. */
  if (p.stick != null) {
    if (typeof p.stick !== 'object') return 'payload.stick must be an object';
    if (typeof p.stick.on !== 'boolean') return 'stick.on must be true or false';
    if (p.stick.bury != null && (!Number.isFinite(p.stick.bury) || p.stick.bury < 0 || p.stick.bury > 1)) {
      return 'stick.bury must be a fraction between 0 and 1';
    }
  }

  for (const o of p.objects) {
    if (!o || typeof o !== 'object') return 'every object must be an object';
    if (o.kind !== 'text' && o.kind !== 'shape') return 'every object must be text or a shape';
    if (!Number.isFinite(o.size) || o.size <= 0) return 'every object needs a positive size';
    for (const k of ['x', 'y']) {
      if (o[k] != null && !Number.isFinite(o[k])) return `object.${k} must be a number`;
    }
    /* Written straight into a material, where a malformed value is a silent black piece on someone
       else's cake — the same reason a garnish's stroke colour is checked here. */
    if (o.colour != null && !isHex(o.colour)) return 'object.colour must be a hex colour';
    if (o.offsetColour != null && !isHex(o.offsetColour)) return 'object.offsetColour must be a hex colour';
    // An offset is a fraction of the piece's own size; negative would eat into it.
    if (o.offset != null && (!Number.isFinite(o.offset) || o.offset < 0)) return 'object.offset must be zero or more';

    if (o.kind === 'text') {
      if (typeof o.text !== 'string' || !o.text.trim()) return 'a text object needs words';
      if (o.text.length > 40) return 'that is a lot of words for one topper';
      if (o.face != null && !/^[\w.-]{1,60}$/.test(String(o.face))) return 'object.face must be a face name';
    } else if (o.family != null && !/^[\w-]{1,40}$/.test(String(o.family))) {
      return 'object.family must be a shape name';
    }
  }
  return null;
}

// ── List mine ────────────────────────────────────────────────────────────────────────────────────
router.get('/card-toppers', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });
    const who = authorOf(req);
    const { data, error } = await supabase
      .from('baker_card_toppers')
      .select('id, name, payload, thumb_key, created_at')
      .eq('baker_id', req.bakerId)                 // tenant fence, always
      .eq('created_by_type', who.type)
      .eq('created_by_id', who.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);
    res.json((data ?? []).map(shape));
  } catch (err) { serverError(res, err, 'Failed to list card toppers'); }
});

// ── Keep one ─────────────────────────────────────────────────────────────────────────────────────
router.post('/card-toppers', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });
    const { name, payload, thumbBase64 } = req.body ?? {};

    const bad = invalidPayload(payload);
    if (bad) return res.status(400).json({ error: bad });
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES) {
      return res.status(413).json({ error: 'That topper is too big to save.' });
    }

    /* ⚠️ THE THUMBNAIL MUST NOT BE ABLE TO COST THE COMPOSITION. It is drawn client-side from the
       same objects, so a failure here means a tile is missing — not that the piece the baker just
       made is gone. Stored first so a successful row always points at a real object, and its failure
       is swallowed rather than propagated. */
    let thumbKey = null;
    if (typeof thumbBase64 === 'string' && thumbBase64.length) {
      try {
        const png = Buffer.from(thumbBase64.replace(/^data:image\/png;base64,/, ''), 'base64');
        thumbKey = `card-toppers/thumbs/${randomUUID()}.png`;
        await putObject(thumbKey, png, 'image/png');
      } catch (e) {
        console.error('Card topper thumbnail failed; saving without one', e);
        thumbKey = null;
      }
    }

    const who = authorOf(req);
    const { data, error } = await supabase
      .from('baker_card_toppers')
      .insert({
        baker_id: req.bakerId,
        created_by_type: who.type,
        created_by_id: who.id,
        for_customer_id: req.customerId ?? null,
        name: String(name ?? '').trim().slice(0, MAX_NAME) || 'Card topper',
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
  } catch (err) { serverError(res, err, 'Failed to save the card topper'); }
});

// ── Put one away ─────────────────────────────────────────────────────────────────────────────────
/* ⚠️ SOFT DELETE, and the object stays. A design carries its OWN copy of the objects, so removing a
 * topper from the shelf must never change a cake already made with it — and a hard delete would
 * leave no trail for moderation or erasure, which are the two reasons a row is ever removed. */
router.delete('/card-toppers/:id', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });
    const who = authorOf(req);
    const { data, error } = await supabase
      .from('baker_card_toppers')
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
  } catch (err) { serverError(res, err, 'Failed to remove the card topper'); }
});

/* ⚠️ THERE IS DELIBERATELY NO PUBLISH ROUTE HERE, and the garnish has one.
 *
 * A published card topper would carry somebody's NAME — "Mia", "Happy 40th" — into every bakery's
 * picker, which is furniture nobody else can use and, for a child's name, something we should not be
 * spreading at all. Ready-mades for the catalogue are authored in the admin studio, where an author
 * composes generic wording on purpose. If a "publish this one" is ever wanted, it needs an answer to
 * the name question first, not a copy of this file's neighbour. */

export default router;
