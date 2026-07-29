import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { requireAuth } from '../middleware/auth.js';
import { resolvePrincipal, requireCapability } from '../middleware/rbac.js';
import { config } from '../config.js';
import { razorpay, razorpayEnabled } from './billing.js';
import {
  getAiCreditBalance, listAiCreditCosts, listCreditPacks, getCreditPack,
} from '../services/aiCredits.js';

const router = Router();

// ── GET /api/baker/ai-credits ─────────────────────────────────────────────────
// The metered-tools balance, plus what that balance is WORTH in each action.
//
// No requireCapability: the two surfaces that need this number are the designer (smart tools) and
// the orders panel (X-Ray from a photo), which sit behind different capabilities — gating on either
// one would blank the meter on the other. A tenant's own credit balance is not privileged
// information inside that tenant, so the guard is "is a baker account", the same shape as
// /baker/dashboard's check.
//
// WHY `actions` IS PART OF THIS RESPONSE — it is not a convenience.
// SUBSCRIPTION_TIERS.md is explicit that bakers see a CONCRETE COUNT ("5 photo→cake designs
// left"), never an abstract credit balance, and credit_costs is DATA precisely so a price can move
// without a deploy. Those two facts together mean the client must never divide by a hardcoded
// price: retune the seed and every client that carries its own copy starts lying. So the server
// does the division and hands over the counts. The raw credit figures ride along for the admin/
// billing surfaces, which legitimately deal in credits.
router.get('/baker/ai-credits', requireAuth, resolvePrincipal, async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const [balance, costs] = await Promise.all([
      getAiCreditBalance(req.bakerId),
      listAiCreditCosts(),
    ]);

    // `spendable` is null on an unlimited plan — so is every count, which is what lets the UI say
    // "included" instead of inventing a countdown it would then have to keep accurate.
    const actions = costs.map(c => ({
      actionKey: c.action_key,
      label:     c.label,
      credits:   c.credits,
      remaining: balance.spendable === null ? null : Math.floor(balance.spendable / c.credits),
      affordable: balance.spendable === null ? true : balance.spendable >= c.credits,
    }));

    // Graduated nudges fire at 70/90/100% of the ALLOWANCE (not of allowance+wallet): the wall the
    // baker is walking towards is the plan's, and someone who has topped up has already answered
    // the upgrade question. Sent as a computed percentage so the thresholds live in one place —
    // here — rather than being re-derived by every client that draws a meter.
    const usedPct = balance.unlimited || !balance.allowance
      ? 0
      : Math.min(100, Math.round((balance.allowanceUsed / balance.allowance) * 100));

    res.json({ ...balance, usedPct, actions });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /api/baker/ai-credits/packs ───────────────────────────────────────────
// The top-up shelf. Returns credits + price so the client can render each pack, and the
// per-action counts so it can render them the way SUBSCRIPTION_TIERS.md requires — "+20 build
// guides · ₹299", not "300 credits · ₹299". Same reasoning as `actions` on the balance route:
// the price is data, so the division belongs on the server.
//
// Prices are GST-EXCLUSIVE, matching how subscription_plans stores them. The checkout screen
// shows the breakup (see billing's gstBreakup in spattoo-core).
router.get('/baker/ai-credits/packs', requireAuth, resolvePrincipal, async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const [packs, costs] = await Promise.all([listCreditPacks(), listAiCreditCosts()]);

    res.json({
      packs: packs.map(p => ({
        packKey:    p.pack_key,
        label:      p.label,
        credits:    p.credits,
        pricePaise: p.price_paise,
        buys: costs.map(c => ({
          actionKey: c.action_key,
          label:     c.label,
          count:     Math.floor(p.credits / c.credits),
        })),
      })),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/baker/ai-credits/purchase ───────────────────────────────────────
// Opens a Razorpay ORDER for a top-up pack. One-time payment, not a subscription — so this
// uses the Orders API rather than the Subscriptions API the plan checkout uses, and needs no
// pre-created Razorpay plan id.
//
// SECURITY: the amount is read from credit_packs by the pack key the client sends. It is NEVER
// taken from the request body. A checkout that trusts a client-supplied amount is a
// free-credits endpoint with extra steps.
//
// This route does NOT credit anything. Credits are minted only by the payment webhook
// (billing.js), because "the payment succeeded" is a claim that has to come from Razorpay, not
// from the browser that just clicked pay. notes.* below is what lets the webhook identify the
// payment as a credit purchase and know which baker and pack it was for.
router.post('/baker/ai-credits/purchase', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'Not a baker account' });
    if (!razorpayEnabled()) {
      return res.status(503).json({ error: 'Payments are temporarily unavailable. Please try again shortly.', code: 'razorpay_unavailable' });
    }

    const packKey = String(req.body?.packKey ?? '').trim();
    if (!packKey) return res.status(400).json({ error: 'packKey is required' });

    const pack = await getCreditPack(packKey);
    if (!pack) return res.status(404).json({ error: 'Unknown or inactive pack' });

    const order = await razorpay().orders.create({
      amount:   pack.price_paise,          // from the DB, never the request
      currency: 'INR',
      receipt:  `credits:${req.bakerId}:${pack.pack_key}`,
      notes: {
        kind:     'ai_credit_pack',        // the webhook branches on this
        baker_id: req.bakerId,
        pack_key: pack.pack_key,
      },
    });

    res.json({
      key_id:     config.razorpay.keyId,
      order_id:   order.id,
      amount:     pack.price_paise,
      currency:   'INR',
      packKey:    pack.pack_key,
      credits:    pack.credits,
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
