import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { assertBakerOwns } from '../lib/tenantScope.js';
import { toPublicUrl } from './elements.js';
import { analyzeCake } from '../services/openai.js';
import { matchAnalysis } from '../services/inspirationMatch.js';
import { buildDesignEstimate } from '../services/designEstimate.js';
import { withAiCredits, AI_ACTION, InsufficientCreditsError } from '../services/aiCredits.js';

const router = Router();

// Bump when the prompt, the matcher weights or the mapper change in a way that could move the
// output. Stamped on every estimate, because most quality movement comes from prompt/mapper
// changes rather than model swaps — and without a version you cannot attribute an accuracy shift
// to the change that caused it (migrations/022_ai_credits_ledger.sql).
const PROMPT_VERSION = 'xray-estimate-v1';
const MODEL = 'gpt-4o';   // what services/openai.js analyzeCake calls today

// ── POST /api/orders/:id/design-estimate ──────────────────────────────────────
// Read a manual order's reference photo and produce a design_snapshot-shaped estimate, so the
// EXISTING X-Ray pipeline can run over an order that never touched the 3D designer.
//
// The model's job is to fill in the missing structure, NOT to write the build guide. Tin sizes
// still come from computeTinPlan, colour recipes from gelLibrary, nozzles from the curated craft
// guides — all unchanged, all downstream of this. See AI_CREDITS_PLAN.md §1.2.
//
// Metered: one credit debit per estimate KEPT. A failed model call, an unusable result, or an
// order that already has an estimate all cost nothing — withAiCredits releases the hold on every
// path that isn't a committed success.
router.post('/orders/:id/design-estimate', requireAuth, requireCapability('order:manage'), async (req, res) => {
  try {
    // SEC-14: the order must belong to the caller's bakery. req.bakerId is server-resolved.
    const order = await assertBakerOwns(req, 'orders', req.params.id, {
      select: 'id, design_snapshot, design_estimate',
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // A designed order already has everything X-Ray needs. Estimating over it would spend a credit
    // to produce a worse copy of data we already have, and would invite someone to overwrite a real
    // design with a guess.
    if (order.design_snapshot) {
      return res.status(409).json({
        error: 'This order already has a design — X-Ray reads it directly.',
        code:  'ORDER_HAS_DESIGN',
      });
    }

    // Idempotent by default: an estimate already exists → hand it back, charge nothing. Only an
    // explicit regenerate spends another credit, which is what makes a double-clicked button or a
    // client retry free.
    const regenerate = req.body?.regenerate === true;
    if (order.design_estimate && !regenerate) {
      return res.json({ ok: true, reused: true, estimate: order.design_estimate });
    }

    // The primary reference photo IS the order's picture for a manual order (sort_order 0).
    const { data: photos } = await supabase
      .from('order_reference_photos')
      .select('key').eq('order_id', order.id)
      .order('sort_order', { ascending: true }).limit(1);
    const photoUrl = toPublicUrl(photos?.[0]?.key);
    if (!photoUrl) {
      return res.status(400).json({
        error: 'This order has no reference photo to read.',
        code:  'NO_REFERENCE_PHOTO',
      });
    }

    // `orders/reference/` is a public R2 folder (routes/storage.js FOLDER_POLICY), so the model
    // fetches the image by URL — no re-upload, no base64 round trip through this process.
    const generate = async () => {
      const { analysis, usage, model } = await analyzeCake(photoUrl);

      // A response with no tiers is not a cake we can build a sheet from. keep:false releases the
      // hold — the baker is not charged for a photo the model could not read, which is the beta
      // fairness rule ("don't charge failed/regenerated attempts") made mechanical.
      //
      // Note the vision call has already been PAID FOR at this point. Releasing the hold means WE
      // absorb it, which is the intended bargain during beta and is also why the released-row rate
      // is worth watching: it is the retry_rate that loads landed cost.
      if (!analysis || !Array.isArray(analysis.tiers) || !analysis.tiers.length) {
        return { keep: false, note: 'analysis returned no tiers' };
      }

      const matched = await matchAnalysis(analysis);
      const { snapshot, coverage } = buildDesignEstimate(analysis, matched);

      return {
        value: { snapshot, coverage },
        provider: 'openai',
        // The model the API actually served (dated), not the one we asked for — so the ledger
        // records what ran. MODEL below is only the fallback for the meta blob.
        model: model ?? MODEL,
        promptVersion: PROMPT_VERSION,
        // EVERY provider call this action made: the vision call, plus one embedding per decoration
        // from matchAnalysis. Summed in the ledger rather than here, because the pricing table is
        // aiCredits.js's business. Counting only the vision call would understate the action by
        // however many decorations the cake has — small, but the guardrail's whole value is that
        // it is measured rather than assumed.
        calls: [{ model, usage }, ...(matched.calls ?? [])],
      };
    };

    const result = await withAiCredits(
      {
        bakerId: req.bakerId,
        action:  AI_ACTION.PHOTO_TO_XRAY_ESTIMATE,
        orderId: order.id,
        // Scoped to the order, so a retried request is free — but a deliberate regenerate gets a
        // fresh key and is charged, which is the honest behaviour for a second generation.
        idempotencyKey: regenerate ? null : `xray-estimate:${order.id}`,
      },
      generate,
    );

    let produced = result.value;

    // A REPLAYED key with nothing stored means an earlier attempt was CHARGED and then lost its
    // result — a crash between the commit and the write below. The early return above catches the
    // normal case (estimate present → reuse, free); this catches the torn one. The baker has
    // already paid for exactly this estimate, so re-run it WITHOUT a second reservation. Charging
    // twice for one estimate, or returning "we couldn't read that photo" for a photo we read fine,
    // are both worse than absorbing one provider call.
    if (result.replay && !produced) {
      console.warn('[design-estimate] replayed reservation with no stored estimate — regenerating free', order.id);
      produced = (await generate())?.value ?? null;
    }

    if (!produced) {
      return res.status(422).json({
        error: "We couldn't read a cake from that photo. Try a clearer, straight-on shot.",
        code:  'ESTIMATE_FAILED',
      });
    }

    const { snapshot, coverage } = produced;
    const meta = {
      provider:       'openai',
      model:          MODEL,
      prompt_version: PROMPT_VERSION,
      created_at:     new Date().toISOString(),
      credit_transaction_id: result.reservation?.transactionId ?? null,
      source_photo_key: photos?.[0]?.key ?? null,
      coverage,
    };

    // design_estimate is written, never edited in place. Baker corrections go to
    // design_estimate_edited, and the diff between the two is the accuracy signal that decides
    // every later model/prompt question (migrations/022). A regenerate REPLACES the estimate and
    // clears the corrections with it — they were corrections to a reading that no longer exists.
    const { error: updErr } = await supabase
      .from('orders')
      .update({
        design_estimate:      snapshot,
        design_estimate_meta: meta,
        ...(regenerate ? { design_estimate_edited: null } : {}),
      })
      .eq('id', order.id);
    if (updErr) throw updErr;

    res.json({ ok: true, reused: false, estimate: snapshot, meta });
  } catch (err) {
    // Out of credits is an expected outcome with its own status (402) and a top-up prompt on the
    // other end — not a 500. Everything else goes through the non-leaky shared responder.
    if (err instanceof InsufficientCreditsError) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...err.detail });
    }
    serverError(req, res, err);
  }
});

// ── PATCH /api/orders/:id/design-estimate ─────────────────────────────────────
// The baker's corrections. Writes design_estimate_edited and NEVER touches design_estimate —
// that separation is the whole point of having two columns, and it costs no credits because no
// model runs: the corrected snapshot flows through the same deterministic X-Ray pipeline.
router.patch('/orders/:id/design-estimate', requireAuth, requireCapability('order:manage'), async (req, res) => {
  try {
    const order = await assertBakerOwns(req, 'orders', req.params.id, { select: 'id, design_estimate' });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.design_estimate) {
      return res.status(409).json({ error: 'This order has no estimate to correct.', code: 'NO_ESTIMATE' });
    }

    const edited = req.body?.estimate;
    if (!edited || typeof edited !== 'object' || !Array.isArray(edited.tiers)) {
      return res.status(400).json({ error: 'estimate (with a tiers array) is required' });
    }

    // Corrections stay marked as an estimate. A baker adjusting a tier colour has not turned a
    // reading of a photo into a measured design, and the printed sheet must go on saying so.
    const { error } = await supabase
      .from('orders')
      .update({ design_estimate_edited: { ...edited, source: 'ai_estimate' } })
      .eq('id', order.id);
    if (error) throw error;

    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
