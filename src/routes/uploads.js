import { Router } from 'express';
import express from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { cutOutSubject } from '../services/backgroundRemoval.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { reindexElement } from '../services/elementIndex.js';
import { ensureThumbKey, toPublicUrl } from './elements.js';   // reuse the SAME post-create + URL helpers
import { UPLOADED_BY, promotable } from '../constants/uploads.js';

const router = Router();

// ── Uploads — everything a baker or customer puts into a tenant ──────────────────────────────────
//
// Replaces the old "My Decorations" routes, which wrote uploads into cake_elements. See
// supabase/baker_uploads.sql and spattoo-docs/plans/baker-uploads.md for why that model leaked one
// customer's photo into every other customer's picker, and why this one cannot.
//
// THE INVARIANT, stated once: ownership is derived from the PRINCIPAL, never from the body. A client
// cannot say whose upload this is, cannot widen who sees it, and cannot promote what is not theirs.
//
// AN UPLOAD IS PRIVATE. It does not need promoting to be USED — its owner places it on their own cake
// (a photo-cake frame, or a decoration) straight from My Assets. Promotion is only about RELEASING it
// to the baker's other customers.

// WHO uploaded (authorship) and WHOSE upload it is (ownership) — the two the old model collapsed into
// one column. A customer's upload is theirs. A baker's upload is the bakery's, UNLESS he uploads it
// inside a customer's design/order context, in which case it is hers and he is merely the uploader
// (the photo she sent him over WhatsApp — the exact case that used to leak).
function attributionFor(req, forCustomerId) {
  return req.customerId
    ? {
        uploaded_by_type: UPLOADED_BY.CUSTOMER,
        uploaded_by_id:   req.customerId,
        for_customer_id:  req.customerId,           // her own upload; hers
      }
    : {
        uploaded_by_type: UPLOADED_BY.BAKER_APPUSER,
        uploaded_by_id:   req.user.id,
        for_customer_id:  forCustomerId ?? null,    // his own material, or HERS if he names her
      };
}

// What this principal may see. The ONE place the rule lives — mine, about me, or explicitly shared
// with me. Tenant-wide visibility is NOT in here and cannot be: that is promotion, which lives in
// cake_elements. That absence is the safety property (supabase/baker_uploads.sql).
async function visibleUploadIds(req) {
  const grantee = req.customerId
    ? { type: UPLOADED_BY.CUSTOMER, id: req.customerId }
    : { type: UPLOADED_BY.BAKER_APPUSER, id: req.user.id };
  const { data, error } = await supabase
    .from('baker_upload_shares')
    .select('upload_id')
    .eq('shared_with_type', grantee.type)
    .eq('shared_with_id', grantee.id);
  if (error) throw new Error(error.message);
  return (data ?? []).map(r => r.upload_id);
}

function shape(u) {
  return {
    id:        u.id,
    name:      u.name,
    url:       toPublicUrl(u.storage_key),
    uploadedBy: UPLOADED_BY.NAME_BY_ID[u.uploaded_by_type] ?? String(u.uploaded_by_type),
    forCustomerId: u.for_customer_id,
    createdAt: u.created_at,
  };
}

// ── POST /api/uploads — register an uploaded image ───────────────────────────────────────────────
// The image is already in R2 (signed-URL flow). This is the row that makes it MANAGEABLE: listable in
// My Assets, deletable, and — the part no clause can substitute for — findable when its owner asks for
// erasure. Every upload path calls this: My Assets AND the photo-cake frame popup.
router.post('/uploads', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });

    const { storage_key, name, for_customer_id } = req.body ?? {};
    if (!storage_key) return res.status(400).json({ error: 'storage_key is required' });

    // A baker may attribute an upload to one of HIS OWN customers (the WhatsApp photo). He cannot
    // attribute it to someone else's — checked, because the body is never trusted.
    let forCustomer = null;
    if (!req.customerId && for_customer_id) {
      const { data: c } = await supabase
        .from('customers').select('id').eq('id', for_customer_id).eq('baker_id', req.bakerId).maybeSingle();
      if (!c) return res.status(400).json({ error: 'Unknown customer' });
      forCustomer = c.id;
    }

    const { data, error } = await supabase
      .from('baker_uploads')
      .insert({
        baker_id:    req.bakerId,
        storage_key,
        name:        name?.trim() || null,
        ...attributionFor(req, forCustomer),     // ← server-derived. NEVER from the body.
      })
      .select('id, name, storage_key, uploaded_by_type, for_customer_id, created_at')
      .single();
    if (error) return serverError(req, res, error);

    res.status(201).json(shape(data));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/uploads — My Assets ─────────────────────────────────────────────────────────────────
// Mine, about me, or shared with me. A customer sees her own uploads and nobody else's — not even
// another customer of the same baker. A baker sees his bakery's own material, plus any customer image
// explicitly shared with him (e.g. when her design came in for a quote).
router.get('/uploads', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });

    const sharedIds = await visibleUploadIds(req);
    // Mine: a customer's own rows; for a baker, everything HIS BAKERY uploaded (staff share a tenant —
    // uploaded_by_id is which human, but the material belongs to the bakery).
    const mine = req.customerId
      ? `and(uploaded_by_type.eq.${UPLOADED_BY.CUSTOMER},uploaded_by_id.eq.${req.customerId})`
      : `and(uploaded_by_type.eq.${UPLOADED_BY.BAKER_APPUSER},for_customer_id.is.null)`;
    const aboutMe = req.customerId ? `,for_customer_id.eq.${req.customerId}` : '';
    const shared  = sharedIds.length ? `,id.in.(${sharedIds.join(',')})` : '';

    const { data, error } = await supabase
      .from('baker_uploads')
      .select('id, name, storage_key, uploaded_by_type, for_customer_id, created_at')
      .eq('baker_id', req.bakerId)            // tenant fence, always
      .is('deleted_at', null)
      .or(`${mine}${aboutMe}${shared}`)
      .order('created_at', { ascending: false });
    if (error) return serverError(req, res, error);

    res.json((data ?? []).map(shape));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── DELETE /api/uploads/:id ──────────────────────────────────────────────────────────────────────
// Soft delete. A BAKER may remove anything in his tenant — it is his storage and his moderation problem
// (an image he must not host, he must be able to drop). A CUSTOMER may remove only her own.
//
// Cascades to the LIBRARY: if this upload had been promoted, the promoted element is deactivated too.
// Otherwise a deletion would not delete — the copy would live on in every customer's picker. Doing this
// here, rather than only in the erasure job, means the same rule covers a baker tidying up and a
// customer exercising her rights.
router.delete('/uploads/:id', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });

    let q = supabase
      .from('baker_uploads')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('baker_id', req.bakerId)          // never another tenant's
      .is('deleted_at', null);
    if (req.customerId) q = q.eq('uploaded_by_id', req.customerId);   // customers: their own only

    const { data, error } = await q.select('id');
    if (error) return serverError(req, res, error);
    if (!data?.length) return res.status(404).json({ error: 'Not found' });

    const { error: cascadeErr } = await supabase
      .from('cake_elements')
      .update({ is_active: false })
      .eq('source_upload_id', data[0].id);
    if (cascadeErr) return serverError(req, res, cascadeErr);

    res.json({ ok: true, id: data[0].id });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/uploads/:id/promote — release an image into the baker's library ────────────────────
// This is the ONLY way an image becomes visible to a baker's other customers. It COPIES into
// cake_elements and links back (source_upload_id), so unlink never breaks a cake already designed with
// it, and erasure can still reach the copy.
//
// NOT GATED, and deliberately so: no checkbox, no review. Spattoo is an intermediary (ToS 6.5) and the
// baker has already accepted responsibility for what he publishes (ToS B5.4-B5.6). A tick clicked on
// every promotion is the habituated tick that is worthless as evidence. We RECORD who did it
// (promoted_by/at) and move on.
//
// ONE RULE — a baker may promote only HIS OWN uploads, never a customer's. Not a privacy gate: the
// LICENCE does not exist. ToS 6.2 licenses a customer's Content "solely ... to carry out the actions you
// direct"; her photo becoming furniture in other customers' pickers is not an action she directed.
//
// The baker authors the BEHAVIOUR here (which zones, hug/stand) — this is the first moment those
// questions have an answer, which is why the studio asks them at promotion and not at upload.
router.post('/uploads/:id/promote', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });
    if (req.customerId) return res.status(403).json({ error: 'Not available' });   // bakers release, customers do not

    const { data: upload, error: upErr } = await supabase
      .from('baker_uploads')
      .select('id, name, storage_key, uploaded_by_type, for_customer_id')
      .eq('id', req.params.id).eq('baker_id', req.bakerId).is('deleted_at', null)
      .maybeSingle();
    if (upErr) return serverError(req, res, upErr);
    if (!upload) return res.status(404).json({ error: 'Not found' });

    if (!promotable(upload)) {
      return res.status(403).json({
        error: 'This image was uploaded by a customer, so it cannot be added to your library. Upload your own copy if you have the right to use it.',
        code: 'NOT_YOURS_TO_RELEASE',
      });
    }

    const { element_type_id, allowed_zones, placement_config, name } = req.body ?? {};
    if (!element_type_id) return res.status(400).json({ error: 'element_type_id is required' });

    // Placement is INHERITED from the type's admin-authored template; the baker only NARROWS it. A
    // client cannot widen its own placement by sending extra zones. (Same rule as the old upload path —
    // it just runs at promotion now, where the baker actually chooses.)
    const { data: type, error: typeErr } = await supabase
      .from('element_types')
      .select('id, placement_rules, default_allowed_actions, baker_uploadable')
      .eq('id', element_type_id).maybeSingle();
    if (typeErr) return serverError(req, res, typeErr);
    if (!type?.baker_uploadable) return res.status(400).json({ error: 'That decoration kind cannot be uploaded' });

    const zones = Array.isArray(type.placement_rules?.zones) ? type.placement_rules.zones : [];
    const inheritedModes = type.placement_rules?.placement ?? {};
    const requested = Array.isArray(allowed_zones) ? allowed_zones : zones;
    const allowedZones = zones.filter(z => requested.includes(z));
    if (!allowedZones.length) return res.status(400).json({ error: 'Choose at least one place on the cake' });

    const builtConfig = { ...inheritedModes };
    for (const z of allowedZones) builtConfig[z] = inheritedModes[z] ?? 'hug';
    if (placement_config?.recolor) builtConfig.recolor = placement_config.recolor;   // the caller may add ONLY this
    if (placement_config?.r != null) builtConfig.r = placement_config.r;

    const imageUrl = upload.storage_key;
    const { data: el, error } = await supabase
      .from('cake_elements')
      .insert({
        name:             (name ?? upload.name ?? 'My decoration').trim(),
        description:      '',
        image_url:        imageUrl,
        thumbnail_url:    imageUrl,
        element_type_id,
        allowed_zones:    allowedZones,
        placement_config: builtConfig,
        allowed_actions:  type.default_allowed_actions ?? { resize: true, duplicate: true, color: false, delete: true },
        sort_order:       0,
        is_active:        true,
        baker_id:         req.bakerId,      // the baker's library — NOT global
        source_upload_id: upload.id,        // the link erasure and unlink both follow
        promoted_by:      req.user.id,      // evidence, not permission
        promoted_at:      new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error) return serverError(req, res, error);

    res.status(201).json({ id: el.id, uploadId: upload.id });
    reindexElement(el.id).catch(e => console.error('reindex(promote) failed:', e.message));
    ensureThumbKey(el.id, imageUrl);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── DELETE /api/uploads/:id/promote — unlink from the library ────────────────────────────────────
// The image leaves every customer's picker at once. It stays in My Assets (the upload row is
// untouched), and CAKES ALREADY DESIGNED WITH IT KEEP RENDERING — a design holds the image URL, not a
// foreign key. This is exactly why promotion copies rather than moves.
router.delete('/uploads/:id/promote', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });
    if (req.customerId) return res.status(403).json({ error: 'Not available' });

    const { data, error } = await supabase
      .from('cake_elements')
      .update({ is_active: false })
      .eq('source_upload_id', req.params.id)
      .eq('baker_id', req.bakerId)          // never another tenant's library
      .select('id');
    if (error) return serverError(req, res, error);

    res.json({ ok: true, unlinked: (data ?? []).length });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/elements/remove-bg — cut the background out of an upload ───────────────────────────
// The baker-facing sibling of the admin-only /api/admin/remove-bg. Same job, different principal, and
// gated by element:manage so it can't be used as a free background-removal API by anyone with a login.
// (Kept on its existing path: it is a pure image operation, unrelated to where the row lands.)
router.post(
  '/elements/remove-bg',
  requireAuth,
  requireCapability('element:manage'),
  express.raw({ type: '*/*', limit: '10mb' }),
  async (req, res) => {
    try {
      if (!req.body?.length) return res.status(400).json({ error: 'Send the image bytes as the body' });
      const png = await cutOutSubject(req.body);
      res.set('Content-Type', 'image/png').send(png);
    } catch (err) {
      serverError(req, res, err);
    }
  },
);

export default router;
