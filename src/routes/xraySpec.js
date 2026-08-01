import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { assertBakerOwns } from '../lib/tenantScope.js';
import { toPublicUrl } from './elements.js';
import { analyzeCake, suggestBuildGuide } from '../services/openai.js';
import { renderStageImage, orderStagesKey } from '../services/decorationStages.js';
import { matchAnalysis } from '../services/inspirationMatch.js';
import { buildXraySpec } from '../services/xraySpec.js';
import { withAiCredits, AI_ACTION, InsufficientCreditsError } from '../services/aiCredits.js';

const router = Router();

// Bump when the prompt, the matcher weights or the mapper change in a way that could move the
// output. Stamped on every estimate, because most quality movement comes from prompt/mapper
// changes rather than model swaps — and without a version you cannot attribute an accuracy shift
// to the change that caused it (migrations/022_ai_credits_ledger.sql).
const PROMPT_VERSION = 'xray-estimate-v1';
const MODEL = 'gpt-4o';   // what services/openai.js analyzeCake calls today

// Versioned separately from the estimate: the decoration-steps prompt moves on its own, and a
// shared version would attribute a quality shift to whichever changed last.
const STEPS_PROMPT_VERSION = 'xray-decoration-steps-v1';

// ── Shared by both order-level X-Ray routes ───────────────────────────────────
// Load the order, scoped to the caller's bakery, and refuse a DESIGNED one. Both routes exist
// only for photo orders — a designed order's structure is measured and its decorations are
// library elements — so the guard belongs in one place rather than being restated per route.
// Returns { order } or { status, body } for the caller to return verbatim.
async function loadPhotoOrder(req, designedMessage) {
  // SEC-14: the order must belong to the caller's bakery. req.bakerId is server-resolved.
  const order = await assertBakerOwns(req, 'orders', req.params.id, {
    select: 'id, design_snapshot, xray_spec',
  });
  if (!order) return { status: 404, body: { error: 'Order not found' } };
  if (order.design_snapshot) {
    return { status: 409, body: { error: designedMessage, code: 'ORDER_HAS_DESIGN' } };
  }
  return { order };
}

// The primary reference photo IS the order's picture for a manual order (sort_order 0).
// `orders/reference/` is a public R2 folder (routes/storage.js FOLDER_POLICY), so the model
// fetches the image by URL — no re-upload, no base64 round trip through this process.
async function primaryReferencePhoto(orderId) {
  const { data: photos } = await supabase
    .from('order_reference_photos')
    .select('key').eq('order_id', orderId)
    .order('sort_order', { ascending: true }).limit(1);
  const key = photos?.[0]?.key ?? null;
  return { key, url: toPublicUrl(key) };
}

const NO_PHOTO = {
  status: 400,
  body: { error: 'This order has no reference photo to read.', code: 'NO_REFERENCE_PHOTO' },
};

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
    // A designed order already has everything X-Ray needs. Estimating over it would spend a credit
    // to produce a worse copy of data we already have, and would invite someone to overwrite a real
    // design with a guess.
    const loaded = await loadPhotoOrder(req, 'This order already has a design — X-Ray reads it directly.');
    if (!loaded.order) return res.status(loaded.status).json(loaded.body);
    const { order } = loaded;

    // Idempotent by default: an estimate already exists → hand it back, charge nothing. Only an
    // explicit regenerate spends another credit, which is what makes a double-clicked button or a
    // client retry free.
    const regenerate = req.body?.regenerate === true;
    if (order.xray_spec && !regenerate) {
      return res.json({ ok: true, reused: true, estimate: order.xray_spec });
    }

    const photo = await primaryReferencePhoto(order.id);
    if (!photo.url) return res.status(NO_PHOTO.status).json(NO_PHOTO.body);
    const photoUrl = photo.url;

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
      const { snapshot, coverage } = buildXraySpec(analysis, matched);

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
      source_photo_key: photo.key,
      coverage,
    };

    // xray_spec is written, never edited in place. Baker corrections go to
    // xray_spec_edited, and the diff between the two is the accuracy signal that decides
    // every later model/prompt question (migrations/022). A regenerate REPLACES the estimate and
    // clears the corrections with it — they were corrections to a reading that no longer exists.
    const { error: updErr } = await supabase
      .from('orders')
      .update({
        xray_spec:      snapshot,
        xray_spec_meta: meta,
        ...(regenerate ? { xray_spec_edited: null } : {}),
      })
      .eq('id', order.id);
    if (updErr) throw updErr;

    res.json({ ok: true, reused: false, estimate: snapshot, meta });
  } catch (err) {
    // Out of credits is an expected outcome with its own status (402) and a top-up prompt on the
    // other end — not a 500. Everything else goes through the non-leaky shared responder.
    if (err instanceof InsufficientCreditsError) {
      // detail carries canTopUp + resetsOn so the client can say the right thing (a Flame baker
      // must wait; a Blaze baker can top up) without a second round trip for entitlements.
      return res.status(err.status).json({ error: err.message, code: err.code, ...err.detail });
    }
    serverError(req, res, err);
  }
});

// ── PATCH /api/orders/:id/design-estimate ─────────────────────────────────────
// The baker's corrections. Writes xray_spec_edited and NEVER touches xray_spec —
// that separation is the whole point of having two columns, and it costs no credits because no
// model runs: the corrected snapshot flows through the same deterministic X-Ray pipeline.
router.patch('/orders/:id/design-estimate', requireAuth, requireCapability('order:manage'), async (req, res) => {
  try {
    const order = await assertBakerOwns(req, 'orders', req.params.id, { select: 'id, xray_spec' });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.xray_spec) {
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
      .update({ xray_spec_edited: { ...edited, source: 'photo' } })
      .eq('id', order.id);
    if (error) throw error;

    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});


// The decoration's box in the reference photo, from whichever half of the spec holds the design.
// Written by buildXraySpec onto each sticker as `seen.bbox`; null when the model would not commit,
// which is common and must not be treated as an error.
function findDecorationBbox(spec, key) {
  const design = spec?.design ?? spec;      // pre-029 rows are a bare design_snapshot
  const all = [...(design?.stickers ?? []), ...(design?.decorations ?? [])];
  return all.find(d => d?.id === key)?.seen?.bbox ?? null;
}

// ── POST /api/orders/:id/xray/decoration-steps ────────────────────────────────
// How do I make THIS decoration — for a decoration that exists only in the customer's photo.
//
// The designed-order equivalent lives on the element (element_craft_guide): there the decoration
// IS a library element, the answer is the same every time it is used, and one baker's generation
// amortises across everyone. A photo decoration has no element, and forcing one on it is what
// produced a detailed, faithful guide to a fondant doll for a cake that had a bow: matching scores
// zone, type and colour at 0.60 combined against a 0.35 floor, so a pink fondant topper certifies
// as any other pink fondant topper without the model recognising the object at all.
//
// So this reads the ORIGINAL PHOTO and names which decoration to look at, and stores the answer on
// the order. Nothing is matched, so nothing can be mismatched.
router.post('/orders/:id/xray/decoration-steps', requireAuth, requireCapability('order:manage'), async (req, res) => {
  try {
    // A designed order's decorations are library elements and take the element path, where the
    // answer is shared and paid for once rather than per order.
    const loaded = await loadPhotoOrder(req, 'This order has a design — its decorations are library elements.');
    if (!loaded.order) return res.status(loaded.status).json(loaded.body);
    const { order } = loaded;

    if (!order.xray_spec) {
      return res.status(409).json({ error: 'Run X-Ray on this order first.', code: 'NO_XRAY_SPEC' });
    }

    // `key` identifies the decoration within this order's spec; `label` is what to look for in the
    // photo. Both come from the spec the client is already rendering, so the client never invents
    // a decoration the report does not show.
    const key   = String(req.body?.key   ?? '').trim();
    const label = String(req.body?.label ?? '').trim();
    if (!key || !label) return res.status(400).json({ error: 'key and label are required' });
    if (key.length > 120 || label.length > 200) return res.status(400).json({ error: 'key or label too long' });

    // Already generated → hand it back, charge nothing.
    const existing = order.xray_spec?.decorations?.[key];
    if (existing) return res.json({ ok: true, reused: true, key, steps: existing });

    // Where this decoration is in the photo, so the stage grid can be conditioned on the real
    // thing rather than on the whole cake. Absent is fine — the grid falls back to the full photo,
    // which is worse but not wrong, and the model is told what to look for either way.
    const bbox = findDecorationBbox(order.xray_spec, key);

    const photo = await primaryReferencePhoto(order.id);
    if (!photo.url) return res.status(NO_PHOTO.status).json(NO_PHOTO.body);

    const out = await withAiCredits(
      {
        bakerId: req.bakerId,
        action:  AI_ACTION.ELEMENT_BUILD_GUIDE,
        orderId: order.id,
        idempotencyKey: `xray-steps:${order.id}:${key}`,
      },
      async () => {
        // `focus` puts the model in whole-cake mode: read this ONE decoration and ignore the rest.
        // Without it, given a busy cake, it describes whichever object is most prominent.
        const { guide, usage, model } = await suggestBuildGuide({
          imageUrl: photo.url, name: label, focus: label,
        });
        // No steps = "this is piped or printed, not modelled by hand". A real answer — the piping
        // section already tells them how — but not one worth a credit.
        if (!guide || !Array.isArray(guide.steps) || guide.steps.length === 0) {
          return { keep: false, note: 'not a modelled decoration', value: { guide, model } };
        }

        // The stage grid. Best-effort ON PURPOSE: the words are the product and the pictures are
        // the improvement, so an image failure must not throw away steps the baker is about to be
        // charged for. A guide with no picture is a worse guide; a 500 after a successful text
        // generation is a wasted credit.
        const stages = await renderStageImage({
          sourceKey: photo.key,
          bbox,                                      // the photo is a whole cake — crop to this one
          objectKey: orderStagesKey(order.id, key),
          title: guide.title || label,
          steps: guide.steps,
        }).catch(err => {
          console.warn('[xray] stage image failed, steps kept:', err?.message);
          return null;
        });

        return {
          value: { guide, model, stagesKey: stages?.key ?? null },
          provider: 'openai', model, promptVersion: STEPS_PROMPT_VERSION,
          // BOTH calls. The image is the expensive half and the whole question of whether this
          // fits inside the current price is settled by measuring it, not by estimating it.
          calls: [{ model, usage }, ...(stages ? [{ model: stages.model, usage: stages.usage, image: stages.image }] : [])],
        };
      },
    );

    if (out.discarded) {
      if (out.discardedValue?.guide) {
        return res.json({ ok: true, notModelled: true, steps: out.discardedValue.guide, charged: false });
      }
      return res.status(422).json({ error: "We couldn't read that decoration.", code: 'STEPS_FAILED' });
    }
    if (!out.value?.guide) {
      return res.status(422).json({ error: "We couldn't read that decoration.", code: 'STEPS_FAILED' });
    }

    const value = {
      guide:          out.value.guide,
      // R2 KEY, never a URL — the public base is deployment config and would rot every stored row.
      stages_key:     out.value.stagesKey ?? null,
      label,
      model:          out.value.model ?? null,
      prompt_version: STEPS_PROMPT_VERSION,
      // Which picture this was read from. The order's photo can be replaced, and steps describing
      // a cake nobody is making now look no different from correct ones.
      source_photo_key: photo.key,
      generated_at:   new Date().toISOString(),
    };
    // Merged in SQL, row-locked: two decorations generated at once must not clobber each other.
    const { error: mergeErr } = await supabase.rpc('xray_add_decoration_steps', {
      p_order_id: order.id, p_key: key, p_value: value,
    });
    if (mergeErr) throw mergeErr;

    res.json({ ok: true, reused: false, key, steps: value });
  } catch (err) {
    if (err instanceof InsufficientCreditsError) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...err.detail });
    }
    serverError(req, res, err);
  }
});

export default router;
