import { Router } from 'express';
import express from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { cutOutSubject } from '../services/backgroundRemoval.js';
import { getObjectBuffer, putObject, deleteObject } from '../services/r2.js';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import { recordAttestation, attestationMissing, publishError } from '../services/contentAttestation.js';
import { ATTESTATION_TARGET_TYPE } from '../constants/legalDocuments.js';
import { requireCapability } from '../middleware/rbac.js';
import { reindexElement } from '../services/elementIndex.js';
import { ensureThumbKey, toPublicUrl } from './elements.js';   // reuse the SAME post-create + URL helpers
import { UPLOADED_BY, promotable } from '../constants/uploads.js';
import { withAiCredits, AI_ACTION, InsufficientCreditsError } from '../services/aiCredits.js';
import { config } from '../config.js';

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

// `promoted` = this image is CURRENTLY in the baker's library (an active element links back to it).
// The UI needs it to offer "show in my decorations" vs "remove from decorations", and it must reflect
// the LIVE state, not "was it ever promoted" — an unlinked upload can be promoted again.
function shape(u, promotedIds = new Set()) {
  return {
    id:        u.id,
    name:      u.name,
    url:       toPublicUrl(u.storage_key),
    // The background-removed version, used when the image is a DECORATION. NULL until first decoration
    // use; the original (`url`) is always the uncut upload, for the photo-cake frame path.
    cutoutUrl: u.cutout_key ? toPublicUrl(u.cutout_key) : null,
    uploadedBy: UPLOADED_BY.NAME_BY_ID[u.uploaded_by_type] ?? String(u.uploaded_by_type),
    forCustomerId: u.for_customer_id,
    promoted:  promotedIds.has(u.id),
    createdAt: u.created_at,
  };
}

// ── ensureCutout — derive the background-removed version ONCE, cache it, keep the original ────────
// The single chokepoint for "make this image usable as a decoration". Idempotent: the first decoration
// use of an image cuts it; every use after reuses cutout_key, so cutOutSubject (a metered/compute cost)
// runs at most once per upload, ever.
//
// NON-DESTRUCTIVE, unlike the old remove-bg it replaces: storage_key (the original as uploaded) is left
// untouched, because the same upload may still be chosen as a photo-cake FRAME photo, which must NOT be
// cut. The cutout is a SEPARATE cached object, not an overwrite.
//
// `upload` must carry id, storage_key and cutout_key. Returns the cutout key.
async function ensureCutout(upload) {
  if (upload.cutout_key) return upload.cutout_key;

  const cut    = await cutOutSubject(await getObjectBuffer(upload.storage_key));
  const cutKey = `elements/files/2D/${randomUUID()}.png`;
  await putObject(cutKey, cut, 'image/png');

  // Claim the slot only if still empty — two concurrent first-uses (e.g. the studio opening while a
  // direct placement fires) would otherwise both write. The loser reconciles: it drops its now-orphan
  // object and adopts the winner's key, so the row never points at two objects and neither leaks a ref.
  const { data, error } = await supabase
    .from('baker_uploads')
    .update({ cutout_key: cutKey })
    .eq('id', upload.id)
    .is('cutout_key', null)
    .select('cutout_key');
  if (error) throw new Error(error.message);

  if (data?.length) return cutKey;

  const { data: won } = await supabase
    .from('baker_uploads').select('cutout_key').eq('id', upload.id).maybeSingle();
  deleteObject(cutKey).catch(e => console.error('ensureCutout: orphan not swept:', e.message));
  return won?.cutout_key ?? cutKey;
}

// Which of these uploads are live in the library. ONE query for the whole page, not one per row.
async function promotedAmong(uploadIds) {
  if (!uploadIds.length) return new Set();
  const { data, error } = await supabase
    .from('cake_elements')
    .select('source_upload_id')
    .in('source_upload_id', uploadIds)
    .eq('is_active', true);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map(r => r.source_upload_id));
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

    res.status(201).json(shape(data));   // fresh row: never promoted
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
      .select('id, name, storage_key, cutout_key, uploaded_by_type, for_customer_id, created_at')
      .eq('baker_id', req.bakerId)            // tenant fence, always
      .is('deleted_at', null)
      .or(`${mine}${aboutMe}${shared}`)
      .order('created_at', { ascending: false });
    if (error) return serverError(req, res, error);

    const promoted = await promotedAmong((data ?? []).map(u => u.id));
    res.json((data ?? []).map(u => shape(u, promoted)));
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

// ── PATCH /api/uploads/:id — rename ──────────────────────────────────────────────────────────────
// The name is how a person finds their own picture again, and it arrives as whatever the file was
// called: "Screenshot 2026-07-14 at 10.42.59 AM". That is not a name, it is a timestamp.
//
// Only the NAME is patchable, and deliberately so: this is not a general "update the row" route. The
// storage key, the attribution and the tenant are all server-derived (the invariant at the top of this
// file), and a PATCH that accepted arbitrary columns would be the one place a client could talk its way
// past them.
//
// Same scoping as delete — the tenant fence always, and a customer may touch only her own. A rename
// does NOT reach the promoted copy: the library element carries the name the baker gave it AT
// promotion, and silently re-titling a decoration his customers are already using would be a change to
// their picker made by a act he thought was private housekeeping.
const MAX_UPLOAD_NAME = 60;

router.patch('/uploads/:id', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });

    const name = String(req.body?.name ?? '').trim().slice(0, MAX_UPLOAD_NAME);
    if (!name) return res.status(400).json({ error: 'Give it a name.' });

    let q = supabase
      .from('baker_uploads')
      .update({ name })
      .eq('id', req.params.id)
      .eq('baker_id', req.bakerId)          // never another tenant's
      .is('deleted_at', null);
    if (req.customerId) q = q.eq('uploaded_by_id', req.customerId);   // customers: their own only

    const { data, error } = await q.select('id, name, storage_key, cutout_key, uploaded_by_type, for_customer_id, created_at');
    if (error) return serverError(req, res, error);
    if (!data?.length) return res.status(404).json({ error: 'Not found' });

    const promoted = await promotedAmong([data[0].id]);
    res.json(shape(data[0], promoted));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/uploads/:id/promote — release an image into the baker's library ────────────────────
// This is the ONLY way an image becomes visible to a baker's other customers. It COPIES into
// cake_elements and links back (source_upload_id), so unlink never breaks a cake already designed with
// it, and erasure can still reach the copy.
//
// ATTESTED. Promotion is a PUBLICATION: the image lands in the picker every customer of this bakery
// designs from. It is not world-visible (that is the storefront), but it is republication to an
// audience the baker does not know individually — and it is the act in this product most likely to
// carry someone else's IP, because the thing a baker wants to reuse across cakes is exactly the
// cartoon character or the brand logo. When a rights holder sends a notice naming that image, we must
// be able to say who released it, when, and against which words. So the baker ticks, and we record it
// (content_attestations, target_type = decoration).
//
// This is a THIRD gate, alongside ToS acceptance at onboarding and the storefront publish — and it is
// the only per-item one, which the original design argued against on the grounds that a habituated
// tick is weak evidence. That argument holds for "Save as Template" (a baker saves constantly, to his
// own library, seen only by customers he invited). It does not hold here: promoting is rare,
// deliberate, and it hands the image to people he has never met. A tick that is asked for rarely, at
// the moment of exposure, is exactly the considered affirmation the record is for.
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
      .select('id, name, storage_key, cutout_key, uploaded_by_type, for_customer_id')
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

    if (attestationMissing(req.body)) {
      return res.status(400).json({
        error: 'Confirm you have the right to share this decoration with your customers.',
        code: 'ATTESTATION_REQUIRED',
      });
    }

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

    // Evidence BEFORE exposure — the same ordering as the storefront publish. If the attestation write
    // fails, no element is created and the image stays private, so nothing ever reaches a customer's
    // picker without a record of who released it. (This is also why no rollback is needed: the Supabase
    // REST client has no cross-table transaction, so the only safe order is evidence first.)
    await recordAttestation({
      subjectId:  req.user.id,
      bakerId:    req.bakerId,
      targetType: ATTESTATION_TARGET_TYPE.DECORATION,
      targetId:   upload.id,        // the IMAGE is what a notice will name — not the element copy
      ip:         req.ip,
      userAgent:  req.headers['user-agent'] ?? null,
    });

    // The library copy is a DECORATION — it must carry the cutout, never the uncut original. Derive it
    // now if this image has not been cut yet (idempotent; the studio will usually have done it already
    // when it opened). This is also what makes a promote-after-the-fact consistent: there is no separate
    // path that could leave the element pointing at an uncut image.
    const imageUrl = await ensureCutout(upload);
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
    // publishError, not serverError: if the attestation WORDING is unpublished there is nothing to
    // point the record at, and we refuse to expose the image rather than release it without evidence.
    // That is our gap, not the baker's — 503 with a "try again shortly", never a 4xx blaming his tick.
    publishError(req, res, err);
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

// ── POST /api/uploads/:id/cutout — ensure the decoration cutout exists ───────────────────────────
// "Prepare this image to be a decoration." Called when an upload ENTERS a decoration context — the
// promote studio opening, or a direct decoration placement — so the preview, the zone tiles and the
// cake all show the subject cut out, not a photo with a white box around it.
//
// There is NO manual "remove background" button any more. A cutout of a decoration is not an optional
// treatment the user requests: an uncut decoration is simply broken, and only the decoration path needs
// it. So it happens implicitly, exactly when it is needed, and NOT on the photo-cake frame path — a
// birthday photo keeps its background.
//
// Idempotent and NON-DESTRUCTIVE (ensureCutout): the original upload is never touched, the cut is
// computed at most once, and this route is safe to call every time the studio opens.
router.post('/uploads/:id/cutout', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });

    let q = supabase
      .from('baker_uploads')
      .select('id, name, storage_key, cutout_key, uploaded_by_type, uploaded_by_id, for_customer_id, created_at')
      .eq('id', req.params.id).eq('baker_id', req.bakerId).is('deleted_at', null);
    if (req.customerId) q = q.eq('uploaded_by_id', req.customerId);   // customers: their own only
    const { data: upload, error: upErr } = await q.maybeSingle();
    if (upErr) return serverError(req, res, upErr);
    if (!upload) return res.status(404).json({ error: 'Not found' });

    const cutKey   = await ensureCutout(upload);
    const promoted = await promotedAmong([upload.id]);
    res.json(shape({ ...upload, cutout_key: cutKey }, promoted));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/elements/remove-bg — cut the background out of an upload ───────────────────────────
// The baker-facing sibling of the admin-only /api/admin/remove-bg. Same job, different principal, and
// gated by element:manage so it can't be used as a free background-removal API by anyone with a login.
// (Kept on its existing path: it is a pure image operation, unrelated to where the row lands.)
//
// METERED (migration 036). The only user-triggered action we paid a per-image fee for and did not
// charge for — and the upload button sits in front of every baker, so the volume is theirs to set
// and ours to pay. The monthly allowance is the free tier: a baker reaches real money only after
// spending credits their subscription already gave them.
//
// NOT metered by a daily cap, deliberately: a cap's only escape is tomorrow, and it lands hardest on
// the baker with an urgent order. Credits run out too, but topping up is an action they control.
router.post(
  '/elements/remove-bg',
  requireAuth,
  requireCapability('element:manage'),
  express.raw({ type: '*/*', limit: '10mb' }),
  async (req, res) => {
    try {
      if (!req.body?.length) return res.status(400).json({ error: 'Send the image bytes as the body' });
      // Metering needs a baker to charge. Same guard the other baker-scoped routes here use.
      if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });

      const out = await withAiCredits(
        { bakerId: req.bakerId, action: AI_ACTION.BACKGROUND_REMOVAL },
        async () => {
          const png = await cutOutSubject(req.body);
          // A cut-out that came back empty is a failed call, not a result. Discarding releases the
          // hold, so the baker is not charged for an image we cannot give them.
          if (!png?.length) return { keep: false, note: 'empty cutout' };
          // provider/model are the vendor, so the margin dashboard can tell a remove.bg image from
          // a self-hosted one once spattoo-bgremover is live and the per-image fee disappears.
          return { value: png, provider: config.bgRemoval.provider };
        },
      );
      if (!out.value) return res.status(422).json({ error: 'Could not cut out that image.', code: 'CUTOUT_FAILED' });

      res.set('Content-Type', 'image/png').send(out.value);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return res.status(err.status).json({ error: err.message, code: err.code, ...err.detail });
      }
      serverError(req, res, err);
    }
  },
);

export default router;
