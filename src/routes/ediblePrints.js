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
 * `identifyElements` returns a `material` per decoration, so this reads its answer rather than
 * asking a second question. Fondant, buttercream and chocolate are modelled or piped and belong to
 * the build guide, not to a printer.
 *
 * ⚠️ CONFIDENT ONLY. Anything the model did not clearly call a printed material arrives UNTICKED,
 * because a wrong tick costs the baker real credits on a fondant fence. Being asked about two
 * things is a fair question; having to untick five is a feature nobody trusts twice.
 *
 * ⚠️ `edible_print`, NOT `edible_paper`. The first version of this checked for a value the prompt
 * could not return — its material enum was buttercream|fondant|acrylic|sugar|chocolate|other, with
 * no printed option at all. So a printed goose came back `fondant` and never ticked, and only a
 * plaque guessed as `acrylic` ever did. A heuristic keyed on a value nothing produces is a heuristic
 * that never fires. The enum now carries `edible_print`, matching what `cake_elements.medium` has
 * always allowed.
 *
 * `acrylic` stays because a flat acrylic sign IS reproducible as a print, and a baker who wants it
 * printed instead of bought should be offered it. */
const PRINTED_MATERIALS = new Set(['edible_print', 'acrylic']);
const looksPrinted = (el) => PRINTED_MATERIALS.has(String(el?.material ?? '').toLowerCase());

/* ⚠️ A LICENSED FLAG WARNS; IT DOES NOT BLOCK. That was measured, not assumed.
 *
 * The first version refused outright. On the real goose cake that stopped a plain baby-shower goose:
 * first flagged as "generic goose design" (the model contradicting itself in the same sentence),
 * then, after the prompt improved, as "Little Goose illustration" — reading the cake's OWN WORDING,
 * "Our little goose is on the way", as if it were a title. Neither is a licensed property, and a
 * baker could not argue with either.
 *
 * The identify prompt tolerates over-flagging on purpose, and says why: "a generic decoration
 * wrongly flagged is a worse outcome than a licensed one slipping through, BECAUSE A HUMAN REVIEWS
 * THESE ANYWAY." That holds where it was written — admin extraction, where a person ticks each
 * candidate. Turning the same flag into a hard block removed the human it relies on.
 *
 * ⚠️ AND THE FLAG WAS DEMONSTRABLY WRONG. That goose was itself generated by ChatGPT for the
 * reference photo — there is no property to license — and we regenerated it twice, on both models,
 * with no refusal at all. The backstop below is not a hope; it is what already happened.
 *
 * And the costs are lopsided:
 *   FALSE POSITIVE  the baker cannot make a decoration they are entitled to make. Permanent.
 *   FALSE NEGATIVE  the image model refuses at its OUTPUT stage, generateDecorationImage throws,
 *                   and withAiCredits releases the hold. THE BAKER LOSES NOTHING; we absorb a few
 *                   rupees of provider cost.
 *
 * So the model stays the backstop — it still refuses real IP, and refusing costs the baker nothing —
 * while the baker, who knows whether it is Peppa Pig or their own goose, makes the call. The warning
 * is shown, and the row stays UNTICKED so it is never an accident. */
const ipWarning = (el) =>
  el?.licensed_ip === true
    ? `Looks like it might be licensed${el.ip_note ? ` — ${el.ip_note}` : ''}. If it is, the image service will refuse it and you will not be charged.`
    : null;

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
        // Ticked only when it is a print AND nothing flagged it. A warning is never pre-ticked.
        looksPrinted: looksPrinted(el) && el.licensed_ip !== true,
        ipWarning: ipWarning(el),
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

    const { sourceKey, bbox, prompt, label } = req.body ?? {};
    if (!sourceKey) return res.status(400).json({ error: 'sourceKey is required' });
    if (!prompt)    return res.status(400).json({ error: 'prompt is required' });
    /* No IP refusal here — see ipWarning above. The image model refuses genuine licensed work at its
     * own output stage, and a refusal releases the hold, so the baker pays nothing for the attempt.
     * A server-side block would only add false positives on top of a backstop that already works. */

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
