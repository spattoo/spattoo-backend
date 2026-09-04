import { Router } from 'express';
import { randomUUID } from 'crypto';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { assertBakerOwns } from '../lib/tenantScope.js';
import { toPublicUrl } from './elements.js';
import { identifyElements, generateDecorationImage } from '../services/openai.js';
import { composeReference, cropRegion } from '../services/imageCrop.js';
import { getObjectBuffer, putObject } from '../services/r2.js';
import { withAiCredits, AI_ACTION, InsufficientCreditsError } from '../services/aiCredits.js';
import { UPLOADED_BY } from '../constants/uploads.js';

const router = Router();

/* ── Edible prints, read off a reference photo and generated for the baker ───────────────────────
 *
 * A customer sends a photo of a cake with a printed goose and a printed plaque on it. Today the
 * baker leaves Spattoo, asks ChatGPT for a goose, prints it and finds out at the bench whether it
 * was any good. These two routes are the alternative — see
 * spattoo-docs/plans/edible-prints-from-a-reference-photo.md.
 *
 * ── WHY TWO ROUTES AND NOT ONE ─────────────────────────────────────────────────────────────────
 * Identifying WHICH decorations are prints is the ambiguous half; generating them is the expensive
 * half. On the goose cake the duck and the plaque are prints, the fence and flowers are fondant,
 * and `decorationPolicy.js` already records that a picture ALONE cannot tell those apart — that
 * ambiguity is the entire reason the `medium` column exists.
 *
 * One button that generated everything it thought it saw would spend a baker's credits on a fondant
 * fence. So: identify (free), the baker ticks what is really a print, then generate (metered, one
 * press at a time). The confirmation is what makes the spend fair AND what makes the output right.
 *
 * ── WHY IDENTIFY IS FREE ───────────────────────────────────────────────────────────────────────
 * It is a second read of a photo the order has already paid to read (`photo_to_xray_estimate`, 15
 * credits). Billing twice to look at one photograph is how a fair meter starts feeling grabby, and
 * a free identify is also what lets X-Ray offer the button on every order without the offer itself
 * having cost anything.
 */

// The primary reference photo IS the order's picture for a manual order (sort_order 0). Same
// resolution xraySpec.js uses; `orders/reference/` is a public R2 folder so the model fetches by URL.
async function primaryReferencePhoto(orderId) {
  const { data: photos } = await supabase
    .from('order_reference_photos')
    .select('key').eq('order_id', orderId)
    .order('sort_order', { ascending: true }).limit(1);
  const key = photos?.[0]?.key ?? null;
  return { key, url: toPublicUrl(key) };
}

/* Which of the decorations the model saw are EDIBLE PRINTS.
 *
 * `identifyElements` already returns a `material` per decoration and already flags licensed IP, so
 * this reads its answer rather than asking a second question. `edible_paper` and `acrylic` are both
 * flat printed/cut pieces as far as an icing sheet is concerned; fondant, buttercream and chocolate
 * are modelled or piped and belong to the build guide, not to a printer.
 *
 * ⚠️ CONFIDENT ONLY. Anything the model did not clearly call a printed material arrives UNTICKED,
 * because a wrong tick costs the baker real credits on a fondant fence. Being asked about two
 * things is a fair question; having to untick five is a feature nobody trusts twice.
 */
const PRINTED_MATERIALS = new Set(['edible_paper', 'acrylic']);
const looksPrinted = (el) => PRINTED_MATERIALS.has(String(el?.material ?? '').toLowerCase());

// ── POST /api/orders/:id/edible-prints/identify ──────────────────────────────────────────────────
// Free. Returns every decoration found, each marked with whether it looks like a print, so the
// baker sees what was considered and not only what we guessed.
router.post('/orders/:id/edible-prints/identify',
  requireAuth, requireCapability('order:manage'), async (req, res) => {
  try {
    // SEC-14: the order must belong to the caller's bakery. req.bakerId is server-resolved, never
    // taken from the client.
    const order = await assertBakerOwns(req, 'orders', req.params.id, { select: 'id' });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const photo = await primaryReferencePhoto(order.id);
    if (!photo.url) {
      return res.status(400).json({
        error: 'This order has no reference photo to read.', code: 'NO_REFERENCE_PHOTO' });
    }

    const { elements } = await identifyElements(photo.url);
    if (!Array.isArray(elements) || !elements.length) {
      return res.json({ ok: true, sourceKey: photo.key, prints: [] });
    }

    res.json({
      ok: true,
      sourceKey: photo.key,
      prints: elements.map((el, i) => ({
        // Index, not a stored row: identify is free and repeatable, so there is nothing to persist
        // and nothing to clean up. The client hands the whole candidate back to /generate.
        index:    i,
        label:    el.label ?? 'decoration',
        material: el.material ?? null,
        prompt:   el.prompt ?? null,
        bbox:     el.bbox ?? null,
        looksPrinted: looksPrinted(el),
        /* ⚠️ Licensed characters are dead on arrival and must be said so HERE, before anything is
         * spent. The image model moderates at the OUTPUT stage — it generates, bills, and THEN
         * refuses — so a Peppa Pig plaque discovered at generate time is a credit already gone.
         * Half the baby and kids cakes in this market are licensed characters. */
        blocked:  el.licensed_ip === true,
        blockedReason: el.licensed_ip === true
          ? `Licensed character or brand${el.ip_note ? ` — ${el.ip_note}` : ''}. This cannot be generated.`
          : null,
      })),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/orders/:id/edible-prints/generate ──────────────────────────────────────────────────
// Metered. ONE image per press — admin's Extract Elements may ask for variants because Spattoo pays
// there; here the baker pays, so a press is one image and the price means one thing.
router.post('/orders/:id/edible-prints/generate',
  requireAuth, requireCapability('order:manage'), async (req, res) => {
  try {
    const order = await assertBakerOwns(req, 'orders', req.params.id, { select: 'id' });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Customers never generate. `element:manage` gates the uploads this writes to, and a customer
    // holding an order:manage capability would otherwise reach it through their own order.
    if (req.customerId) return res.status(403).json({ error: 'Not available' });

    const { sourceKey, bbox, prompt, label, licensed } = req.body ?? {};
    if (!sourceKey) return res.status(400).json({ error: 'sourceKey is required' });
    if (!prompt)    return res.status(400).json({ error: 'prompt is required' });
    if (licensed === true) {
      return res.status(422).json({
        error: 'Licensed characters and brands cannot be generated.', code: 'LICENSED_IP' });
    }

    /* ⚠️ The photo must belong to THIS order. Without this a baker could pass any key they knew and
     * spend their own credits reading someone else's photograph — the credit is theirs, but the
     * image is not, and the tenant fence has to hold on the DATA and not only on the wallet. */
    const { data: owned } = await supabase
      .from('order_reference_photos').select('key').eq('order_id', order.id).eq('key', sourceKey).maybeSingle();
    if (!owned) return res.status(400).json({ error: 'That photo is not on this order.' });

    let result;
    try {
      result = await withAiCredits(
        { bakerId: req.bakerId, action: AI_ACTION.EDIBLE_PRINT_GENERATE, orderId: order.id,
          note: label ? `edible print: ${label}` : 'edible print' },
        async () => {
          /* REFERENCE mode, never `fresh`. A baker handing us a photo is not asking for "a plaque",
           * they are asking for THAT plaque, in that shape, so it can be printed and stuck back on.
           * Measured: fresh produced handsome plaques bearing no relation to the cake. Same two
           * steps extractImage.js uses — crop, then compose into a properly framed reference. */
          const source = await getObjectBuffer(sourceKey);
          const crop   = await cropRegion(source, bbox);
          const { buffer: reference, size } = await composeReference(crop);

          const [png] = await generateDecorationImage(reference, prompt, size, 'print', 'reference', 1);
          if (!png) throw new Error('The image service returned nothing.');

          /* ⚠️ Stored as a BAKER upload, with `for_customer_id` null.
           *
           * Inheriting the source photo's ownership would put this in the CUSTOMER's picker, scope
           * it to her, destroy the reuse the feature exists for, and quietly recreate the exact
           * situation POST /uploads/:id/promote refuses — a customer's content becoming furniture
           * in other people's pickers, which ToS 6.2 does not license. The baker performed this
           * action, for her cake; the asset is the bakery's. */
          const key = `uploads/${req.bakerId}/${randomUUID()}.png`;
          await putObject(key, png, 'image/png');

          const { data: row, error } = await supabase.from('baker_uploads').insert({
            baker_id:         req.bakerId,
            uploaded_by_type: UPLOADED_BY.BAKER_APPUSER,
            uploaded_by_id:   req.user?.id ?? null,
            for_customer_id:  null,
            storage_key:      key,
            name:             label || 'Edible print',
          }).select('id, name, storage_key, cutout_key, created_at').single();
          if (error) throw error;

          return { keep: true, value: row };
        },
      );
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return res.status(err.status).json({ error: err.message, code: err.code, ...err.detail });
      }
      throw err;
    }

    // A replayed reservation means this exact press already succeeded — say so rather than charging
    // again or pretending it failed.
    if (result.replay) return res.json({ ok: true, replay: true });

    res.json({ ok: true, upload: result.value, cost: result.reservation?.cost ?? null });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
