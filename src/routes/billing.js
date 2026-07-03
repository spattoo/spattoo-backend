import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { config } from '../config.js';
import { logSubscriptionEvent, deriveSubscription } from './subscriptions.js';
import {
  notifySubscriptionActivated, notifySubscriptionRenewed, notifyPaymentFailed,
  notifySubscriptionCancelled, notifySubscriptionExpired,
} from '../services/notifications.js';
import { getSparkTrialDays } from '../services/entitlements.js';
import { SUBSCRIPTION_STATUS } from '../constants/subscriptionStatuses.js';
import { PAYMENT_STATUS }      from '../constants/paymentStatuses.js';
import { PLAN }                from '../constants/subscriptionPlans.js';
import { planChangeDirection, PLAN_CHANGE } from '../lib/subscriptionChange.js';
import { PERIOD }              from '../constants/billingPeriods.js';
import { CANCELLATION_REASON } from '../constants/cancellationReasons.js';

const router = Router();

// ── Razorpay client + helpers ───────────────────────────────────────────────────
// Lazily construct the SDK so local/dev boot never fails without keys; the helpers
// throw a clear error at call time when Razorpay isn't configured. `razorpayEnabled`
// lets the subscribe route fall back to immediate (no-charge) activation in envs
// without keys, while configured envs go through real Checkout.
function razorpayEnabled() {
  return !!(config.razorpay.keyId && config.razorpay.keySecret);
}
let _razorpay = null;
function razorpay() {
  if (!razorpayEnabled()) throw new Error('Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)');
  if (!_razorpay) _razorpay = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
  return _razorpay;
}

// Create a Razorpay subscription for a plan. The CUSTOMER is captured at Checkout
// (subscriptions.create takes NO customer_id) — we return the subscription id, which
// the frontend hands to Razorpay Checkout for authorisation. total_count = number of
// billing cycles before it auto-completes.
async function razorpayCreateSubscription(planId, totalCount, notes, startAt) {
  const sub = await razorpay().subscriptions.create({
    plan_id:         planId,
    total_count:     totalCount,
    quantity:        1,
    customer_notify: 1,
    notes:           notes ?? {},
    // start_at (Unix seconds) DEFERS the first charge — used for a scheduled downgrade so the
    // parked lower sub is authorized now but not billed until the current period ends.
    ...(startAt ? { start_at: startAt } : {}),
  });
  return { id: sub.id };
}

// Cancel a Razorpay subscription. atCycleEnd=true keeps access until the cycle ends;
// false cancels immediately (used when switching plans).
async function razorpayCancelSubscription(subscriptionId, atCycleEnd) {
  if (!subscriptionId) return { ok: true };
  await razorpay().subscriptions.cancel(subscriptionId, !!atCycleEnd);
  return { ok: true };
}

// Verify a webhook is genuinely from Razorpay: HMAC-SHA256 of the RAW body with the
// webhook secret must equal the X-Razorpay-Signature header. Throws if not (timing-safe).
function razorpayVerifyWebhook(rawBody, signature) {
  const secret = config.razorpay.webhookSecret;
  if (!secret) throw new Error('Razorpay webhook secret not configured');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature ?? ''), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Invalid webhook signature');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Close a baker's current active/pending subscription rows because a new one supersedes them
// (immediate plan switch). Attributes the superseded row so it's auditable. One helper for both
// subscribe branches (Razorpay + no-keys) — the update was identical in both. NOTE: the subscribe
// route is the immediate-switch/upgrade path; the deferred-downgrade flow (resubscribe phase) will
// pass CANCELLATION_REASON.DOWNGRADE.
async function closeSupersededSubscriptions(bakerId, reasonId, today) {
  return supabase.from('baker_subscriptions')
    .update({
      status_id:                 SUBSCRIPTION_STATUS.CANCELLED,
      end_date:                  today,
      cancellation_reason_id:    reasonId,
      cancellation_requested_at: new Date().toISOString(),
    })
    .eq('baker_id', bakerId)
    .in('status_id', [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PENDING]);
}

async function getBakerForUser(userId, fields = 'id, name, email, trial_ends_at') {
  const { data: contact, error: contactErr } = await supabase
    .from('baker_appusers').select('baker_id')
    .eq('auth_user_id', userId).maybeSingle();
  if (contactErr) console.error('getBakerForUser: baker_appusers lookup failed:', contactErr.message, '| userId:', userId);
  if (!contact)   console.error('getBakerForUser: no baker_appusers row for userId:', userId);
  if (!contact) return null;
  const { data: baker, error: bakerErr } = await supabase
    .from('bakers').select(fields).eq('id', contact.baker_id).single();
  if (bakerErr) console.error('getBakerForUser: bakers lookup failed:', bakerErr.message, '| fields:', fields, '| baker_id:', contact.baker_id);
  return baker ?? null;
}

// ── GET /billing/periods ──────────────────────────────────────────────────────
router.get('/billing/periods', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('billing_periods')
      .select('id, name, display_name, months, discount_pct')
      .eq('is_active', true)
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /billing/cancellation-reasons ─────────────────────────────────────────
// Customer-facing churn-survey options (config-driven from the cancellation_reasons master
// table) for the cancel dialog. Only the selectable, active ones — system reasons never show.
router.get('/billing/cancellation-reasons', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cancellation_reasons')
      .select('key, display_name')
      .eq('is_customer_selectable', true)
      .eq('is_active', true)
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /billing/status ───────────────────────────────────────────────────────
router.get('/billing/status', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const sub = await deriveSubscription(baker.id);

    res.json({
      tier:                 sub.plan?.name           ?? null,
      status:               sub.status,
      // Prefer the timezone-correct instant; fall back to the legacy date until backfilled.
      next_billing_at:      sub.current_period_end   ?? sub.end_date ?? null,
      billing_period:       sub.period?.display_name ?? null,
      cancel_at_period_end: sub.cancel_at_period_end ?? false,
      cancellation_requested_at: sub.cancellation_requested_at ?? null,
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /billing/subscribe ───────────────────────────────────────────────────
router.post('/billing/subscribe', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const { tier, billing_period_id } = req.body;
    if (!tier || !billing_period_id) {
      return res.status(400).json({ error: 'tier and billing_period_id are required' });
    }

    const periodName = PERIOD.NAME_BY_ID[billing_period_id];
    if (!periodName) return res.status(400).json({ error: 'Invalid billing period' });
    const planId = PLAN.ID_BY_NAME[tier];
    if (!planId) return res.status(400).json({ error: `Unknown plan: ${tier}` });

    const baker = await getBakerForUser(req.user.id, 'id, name, email, billing_subscription_id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const periodMonths = PERIOD.MONTHS_BY_ID[billing_period_id];
    const today        = new Date().toISOString().slice(0, 10);
    const totalCount   = Math.ceil(120 / periodMonths);   // ~10 years of cycles ("until cancelled")

    // ── Real Razorpay flow ────────────────────────────────────────────────────
    // Create the Razorpay subscription and hand the Checkout handle to the frontend.
    // We do NOT activate the baker here — activation happens on the subscription
    // webhook AFTER the customer authorises payment. A PENDING local row is parked
    // for the webhook to flip to active.
    if (razorpayEnabled()) {
      const razorpayPlanId = process.env[`RAZORPAY_PLAN_${tier.toUpperCase()}_${periodName.toUpperCase()}`];
      if (!razorpayPlanId) {
        return res.status(400).json({ error: `No Razorpay plan configured for ${tier} ${periodName}` });
      }

      // Decide direction vs the baker's current PAID subscription (by tier RANK, not plan_id order).
      const current   = await deriveSubscription(baker.id);
      const curPlanId = current.plan?.id ?? null;
      const onPaid    = current.status === 'active' && curPlanId != null && curPlanId !== PLAN.SPARK;
      const direction = onPaid
        ? planChangeDirection(PLAN.RANK_BY_ID[curPlanId], PLAN.RANK_BY_ID[planId])
        : null;   // null = fresh subscribe from free/none
      if (direction === PLAN_CHANGE.SAME) {
        return res.status(409).json({ error: `You're already on the ${tier} plan.` });
      }

      // If a downgrade is ALREADY scheduled on the current row, this new request supersedes it:
      // cancel the parked lower sub + its PENDING row and clear the schedule before proceeding. (The
      // current sub's Razorpay cancel-at-cycle-end, set at authorize time, is mooted by an upgrade's
      // immediate cancel below, and re-established if this is another downgrade.)
      if (current.id) {
        const { data: cur } = await supabase.from('baker_subscriptions')
          .select('scheduled_subscription_id').eq('id', current.id).maybeSingle();
        if (cur?.scheduled_subscription_id) {
          await razorpayCancelSubscription(cur.scheduled_subscription_id, false)
            .catch(e => console.error('[billing] cancel superseded parked downgrade failed:', e.message));
          await supabase.from('baker_subscriptions')
            .update({ status_id: SUBSCRIPTION_STATUS.CANCELLED, end_date: today })
            .eq('billing_subscription_id', cur.scheduled_subscription_id);
          await supabase.from('baker_subscriptions').update({
            scheduled_plan_id: null, scheduled_effective_at: null, scheduled_subscription_id: null, cancel_at_period_end: false,
          }).eq('id', current.id);
        }
      }

      // ── DOWNGRADE → deferred to cycle end (SUBSCRIPTION_CHANGE_PLAN.md) ─────────
      // Park a LOWER sub with start_at = current_period_end: authorized now (Checkout), first charge
      // at the next cycle. Do NOT cancel the old sub or repoint the baker — they keep the higher tier
      // they paid for until then. The `subscription.authenticated` webhook cancels the old sub AT
      // CYCLE END, and only AFTER this new mandate is authorized (safe sequencing / option 1). The
      // activation webhook (at cycle end) promotes this row. Record the pending change on the current
      // active row so the UI can show "<higher> until <date>, then <lower>".
      if (direction === PLAN_CHANGE.DOWNGRADE) {
        if (!current.current_period_end) {
          return res.status(409).json({ error: 'Your renewal date isn’t known yet — please try again shortly.' });
        }
        const startAt = Math.floor(new Date(current.current_period_end).getTime() / 1000);
        const parked  = await razorpayCreateSubscription(razorpayPlanId, totalCount,
          { baker_id: baker.id, tier, period: periodName, change: 'downgrade' }, startAt);

        const { error: parkErr } = await supabase.from('baker_subscriptions').insert({
          baker_id:                baker.id,
          plan_id:                 planId,
          billing_period_id:       billing_period_id,
          status_id:               SUBSCRIPTION_STATUS.PENDING,
          start_date:              current.current_period_end.slice(0, 10),
          end_date:                null,
          billing_subscription_id: parked.id,
        });
        if (parkErr) {
          await razorpayCancelSubscription(parked.id, false).catch(e => console.error('[billing] rollback parked sub failed:', e.message));
          return serverError(req, res, parkErr);
        }

        // Source of truth that a downgrade is scheduled — on the CURRENT active row.
        await supabase.from('baker_subscriptions').update({
          scheduled_plan_id:         planId,
          scheduled_effective_at:    current.current_period_end,
          scheduled_subscription_id: parked.id,
        }).eq('id', current.id);

        // Baker stays on the current (higher) plan → bakers.billing_subscription_id is untouched.
        return res.json({ key_id: config.razorpay.keyId, subscription_id: parked.id, scheduled: true });
      }

      // ── UPGRADE / FRESH subscribe → immediate (existing behaviour, unchanged) ──
      // Cancel any in-flight Razorpay subscription before starting a new one.
      if (baker.billing_subscription_id) {
        await razorpayCancelSubscription(baker.billing_subscription_id, false)
          .catch(err => console.error('[billing] cancel previous Razorpay sub failed:', err.message));
      }

      const subscription = await razorpayCreateSubscription(razorpayPlanId, totalCount, { baker_id: baker.id, tier, period: periodName });

      // Close prior active/pending local rows; park a PENDING row for this attempt.
      await closeSupersededSubscriptions(baker.id, CANCELLATION_REASON.UPGRADE, today);

      const { error: parkErr } = await supabase.from('baker_subscriptions').insert({
        baker_id:                baker.id,
        plan_id:                 planId,
        billing_period_id:       billing_period_id,
        status_id:               SUBSCRIPTION_STATUS.PENDING,
        start_date:              today,
        end_date:                null,
        billing_subscription_id: subscription.id,
      });
      // Don't fail silently — if the pending row didn't land, the webhook has nothing to
      // activate. Roll back the just-created Razorpay subscription so it doesn't linger as
      // an orphaned active sub (which would keep billing with no local record), then surface.
      if (parkErr) {
        console.error('[billing] park PENDING subscription row failed:', parkErr.message);
        await razorpayCancelSubscription(subscription.id, false)
          .catch(e => console.error('[billing] rollback of orphaned Razorpay sub failed:', e.message));
        return serverError(req, res, parkErr);
      }

      await supabase.from('bakers').update({
        billing_subscription_id: subscription.id,
        subscription_plan_id:    planId,
        subscription_status_id:  SUBSCRIPTION_STATUS.PENDING,
      }).eq('id', baker.id);

      // The activation audit event is logged by the webhook once payment authorises.
      return res.json({ key_id: config.razorpay.keyId, subscription_id: subscription.id });
    }

    // ── No-keys fallback (local/dev ONLY) ─────────────────────────────────────
    // SEC-6: reaching here means Razorpay is NOT configured, so activation would be a
    // FREE grant of whatever tier was requested. That must never happen in prod — if the
    // keys were ever missing/rotated out, any baker could self-grant Blaze/Forge at ₹0.
    // Fail CLOSED behind the same explicit per-environment flag /baker/plan/select uses
    // (ALLOW_FREE_PLAN_SELECT=true — set on the dev API only, never prod). This is purely
    // a dev affordance to exercise billing without keys; real activation goes through the
    // Razorpay branch above. (Selecting the free tier / downgrading to free is unaffected —
    // that goes through /billing/cancel or /baker/plan/select, not this no-charge path.)
    if (process.env.ALLOW_FREE_PLAN_SELECT !== 'true') {
      console.error('[billing] subscribe blocked: Razorpay not configured and ALLOW_FREE_PLAN_SELECT is not set — refusing to activate a paid plan without payment');
      return res.status(503).json({ error: 'Billing is temporarily unavailable. Please try again shortly.' });
    }

    // Activate immediately with no charge so billing is exercisable without keys.
    const current = await deriveSubscription(baker.id);   // prior plan/status for the audit event
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + periodMonths);

    await closeSupersededSubscriptions(baker.id, CANCELLATION_REASON.UPGRADE, today);

    await supabase.from('baker_subscriptions').insert({
      baker_id:          baker.id,
      plan_id:           planId,
      billing_period_id: billing_period_id,
      status_id:         SUBSCRIPTION_STATUS.ACTIVE,
      start_date:        today,
      end_date:          endDate.toISOString().slice(0, 10),
    });

    await supabase.from('bakers').update({
      subscription_plan_id:   planId,
      subscription_status_id: SUBSCRIPTION_STATUS.ACTIVE,
    }).eq('id', baker.id);

    // Plan IDs are the tier rank (spark<flame<blaze<forge) → direction from the id compare.
    const prevPlanId = current.plan ? PLAN.ID_BY_NAME[current.plan.name] : null;
    const event = (current.status !== 'active' || prevPlanId == null) ? 'activated'
      : planId > prevPlanId ? 'upgraded'
      : planId < prevPlanId ? 'downgraded'
      : 'activated';
    await logSubscriptionEvent(baker.id, {
      event, previousTier: current.plan?.name ?? null, newTier: tier,
      previousStatus: current.status, newStatus: 'active', changedBy: 'baker',
    });

    res.json({ ok: true, mock: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /billing/cancel ──────────────────────────────────────────────────────
router.post('/billing/cancel', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id, billing_subscription_id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const current = await deriveSubscription(baker.id);

    // Cancel IMMEDIATELY in Razorpay (atCycleEnd=false). Razorpay's cancel-at-cycle-end is
    // invisible on the subscription entity until the boundary, which is impossible to verify;
    // an immediate cancel flips Razorpay to `cancelled` synchronously (certain + auditable),
    // and the baker's paid access is preserved locally as a GRACE period until
    // current_period_end (see the DB update below + the get_baker_subscription derive rule).
    // AUTHORITATIVE: if Razorpay rejects it we must NOT report success — otherwise the baker
    // thinks they cancelled while Razorpay keeps charging. Surface the failure.
    //
    // FAIL CLOSED (mirrors /billing/subscribe's SEC-6): a baker with a
    // billing_subscription_id has a REAL Razorpay subscription that only Razorpay can
    // stop. If the keys are missing/rotated out, razorpayEnabled() is false and we CANNOT
    // honour the cancel — flipping cancel_at_period_end anyway (the old behaviour) told the
    // baker they'd cancelled while Razorpay kept billing them. Refuse instead of lying.
    // (Bakers WITHOUT a billing_subscription_id — free/spark/dev rows that never created a
    // Razorpay sub — need no provider call and fall straight through to the DB update.)
    if (baker.billing_subscription_id) {
      if (!razorpayEnabled()) {
        console.error('[billing] cancel blocked: baker has a Razorpay subscription but Razorpay is not configured — refusing to report a cancel we cannot send to the provider');
        return res.status(503).json({
          error: 'Billing is temporarily unavailable. Please try again shortly.',
          code:  'razorpay_unavailable',
        });
      }
      try {
        await razorpayCancelSubscription(baker.billing_subscription_id, false);
      } catch (err) {
        console.error('[billing] Razorpay cancel failed:', err.message);
        return res.status(502).json({
          error: 'Could not cancel with the payment provider. Please try again.',
          code:  'razorpay_cancel_failed',
        });
      }
    }

    // Optional churn-survey input from the cancel dialog. Validate the picked reason against the
    // master list (must be customer-selectable + active) so a client can't set a system reason;
    // fall back to the generic customer_requested when omitted/invalid.
    const { reason: reasonKey, note } = req.body ?? {};
    let cancellationReasonId = CANCELLATION_REASON.CUSTOMER_REQUESTED;
    if (reasonKey) {
      const { data: r } = await supabase.from('cancellation_reasons')
        .select('id').eq('key', reasonKey).eq('is_customer_selectable', true).eq('is_active', true).maybeSingle();
      if (r) cancellationReasonId = r.id;
    }

    // Mark the CURRENT subscription row: keep access as a GRACE period (status stays active)
    // until current_period_end, even though Razorpay is already cancelled. cancellation_requested_at
    // records that the cancel was issued (audit + confirmation). The daily reconcile job relabels
    // the row to cancelled once current_period_end passes; access is correct before then via the
    // derive rule (now() < current_period_end). The billing UI reads cancel_at_period_end to show
    // "won't renew" and hide the Cancel button. NOTE: we do NOT touch end_date/current_period_end
    // here — the paid-through boundary is preserved.
    const markQuery = supabase.from('baker_subscriptions')
      .update({
        cancel_at_period_end:      true,
        cancellation_requested_at: new Date().toISOString(),
        cancellation_reason_id:    cancellationReasonId,
        cancellation_note:         note ?? null,
      });
    const { error: markErr } = baker.billing_subscription_id
      ? await markQuery.eq('billing_subscription_id', baker.billing_subscription_id)
      : await markQuery.eq('baker_id', baker.id).eq('status_id', SUBSCRIPTION_STATUS.ACTIVE);
    if (markErr) return serverError(req, res, markErr);

    await logSubscriptionEvent(baker.id, {
      event:          'cancelled',
      previousTier:   current.plan?.name ?? null,
      newTier:        current.plan?.name ?? null,
      previousStatus: current.status,
      newStatus:      'cancelled',
      changedBy:      'baker',
    });

    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /billing/activate-spark ─────────────────────────────────────────────
router.post('/billing/activate-spark', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id, subscription_status_id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });
    if (baker.subscription_status_id === SUBSCRIPTION_STATUS.ACTIVE) {
      return res.status(400).json({ error: 'Already on an active plan' });
    }

    // Spark is ONE-TIME — granted once (at signup), never as a fallback after a paid sub
    // lapses. If this baker has ever had a Spark subscription, they must pick a paid plan.
    const { count: priorSpark } = await supabase.from('baker_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('baker_id', baker.id).eq('plan_id', PLAN.SPARK);
    if ((priorSpark ?? 0) > 0) {
      return res.status(409).json({
        error: 'Your Spark trial has already been used. Choose a paid plan to continue.',
        code:  'SPARK_ALREADY_USED',
      });
    }

    const today     = new Date().toISOString().slice(0, 10);
    const trialDays = await getSparkTrialDays();
    const sparkEnd  = new Date();
    sparkEnd.setDate(sparkEnd.getDate() + trialDays);

    await supabase.from('baker_subscriptions')
      .update({ status_id: SUBSCRIPTION_STATUS.CANCELLED, end_date: today })
      .eq('baker_id', baker.id).in('status_id', [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.PENDING]);

    // Spark trial — time-boxed (NEVER permanent), one-time per baker.
    await supabase.from('baker_subscriptions').insert({
      baker_id:          baker.id,
      plan_id:           PLAN.SPARK,
      billing_period_id: PERIOD.MONTHLY,
      status_id:         SUBSCRIPTION_STATUS.ACTIVE,
      start_date:        today,
      end_date:          sparkEnd.toISOString().slice(0, 10),
    });

    await supabase.from('bakers').update({
      subscription_plan_id:   PLAN.SPARK,
      subscription_status_id: SUBSCRIPTION_STATUS.ACTIVE,
    }).eq('id', baker.id);

    await logSubscriptionEvent(baker.id, {
      event: 'activated', newTier: 'spark', newStatus: 'active', changedBy: 'baker',
    });

    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

// payments.status_id is a compact surrogate; translate it to a readable key at the API
// boundary (PAYMENT_STATUS.NAME_BY_ID) so callers never deal in the magic int.
const MAX_PAYMENTS = 24;

// ── GET /billing/payments ─────────────────────────────────────────────────────
// The baker's own payment records, recent → older. `?limit` (1..24, default 24) lets
// the billing UI fetch only the latest row on first look and the full list on demand,
// so it never transfers rows nobody views. `total` is the baker's exact payment count
// (index-only) so the UI can show "View all (N)" without pulling every row.
router.get('/billing/payments', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || MAX_PAYMENTS, 1), MAX_PAYMENTS);

    const { data, error, count } = await supabase
      .from('payments')
      .select('id, razorpay_payment_id, amount, currency, status_id, charged_at', { count: 'exact' })
      .eq('baker_id', baker.id)
      .order('charged_at', { ascending: false })
      .limit(limit);
    if (error) return serverError(req, res, error);

    const payments = (data ?? []).map(({ status_id, ...p }) => ({
      ...p,
      status: PAYMENT_STATUS.NAME_BY_ID[status_id] ?? 'unknown',
    }));
    res.json({ payments, total: count ?? payments.length });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /billing/webhook ─────────────────────────────────────────────────────
// TODO: this will be called by Razorpay when subscription events occur.
//       Until Razorpay is live this endpoint won't be hit.
router.post('/billing/webhook', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const rawBody   = req.body;

    razorpayVerifyWebhook(rawBody, signature);

    const payload = JSON.parse(rawBody.toString());
    const { event } = payload;
    const sub     = payload?.payload?.subscription?.entity;
    const payment = payload?.payload?.payment?.entity;

    const razorpaySubId = sub?.id ?? payment?.subscription_id ?? null;
    if (!razorpaySubId) return res.json({ ok: true });

    // Match the EXACT local row for this Razorpay subscription by its billing_subscription_id
    // — NOT "the baker's most-recent non-cancelled row", which let a late event for a
    // superseded sub mutate the wrong (current) row.
    const { data: subRow, error: subLookupErr } = await supabase
      .from('baker_subscriptions')
      .select('id, baker_id, plan_id, current_period_end, cancellation_reason_id, cancellation_requested_at')
      .eq('billing_subscription_id', razorpaySubId).maybeSingle();
    if (subLookupErr) throw new Error(`sub lookup failed: ${subLookupErr.message}`);
    if (!subRow) return res.json({ ok: true });
    const bakerId = subRow.baker_id;

    // Only mirror status onto bakers when this IS the baker's current subscription, so a
    // stale event for an old sub can't clobber the live status.
    const { data: bakerRow } = await supabase
      .from('bakers').select('id, name, email, timezone, billing_subscription_id').eq('id', bakerId).maybeSingle();
    const isCurrent = bakerRow?.billing_subscription_id === razorpaySubId;

    // ── Deferred downgrade, step 2: the parked LOWER sub just got its mandate authorized ─────────
    // Only NOW (safe sequencing / option 1) do we schedule the OLD (higher) sub to stop renewing at
    // cycle end. The old row is the ACTIVE one that points at this parked sub via scheduled_subscription_id.
    // If the baker had abandoned Checkout this event never fires → the old sub keeps renewing, untouched.
    if (event === 'subscription.authenticated') {
      const { data: oldRow } = await supabase.from('baker_subscriptions')
        .select('id, billing_subscription_id')
        .eq('scheduled_subscription_id', razorpaySubId).maybeSingle();
      if (oldRow?.billing_subscription_id) {
        await razorpayCancelSubscription(oldRow.billing_subscription_id, true)   // atCycleEnd = true
          .catch(e => console.error('[billing] schedule old-sub cancel-at-cycle-end failed:', e.message));
        // Tag the reason DOWNGRADE now so the cycle-end subscription.cancelled event is recognised as a
        // downgrade handoff (NOT a real cancellation) and suppresses the "subscription cancelled" email.
        await supabase.from('baker_subscriptions')
          .update({ cancel_at_period_end: true, cancellation_reason_id: CANCELLATION_REASON.DOWNGRADE })
          .eq('id', oldRow.id);
      }
      return res.json({ ok: true });
    }

    const STATUS_MAP = {
      'subscription.activated': SUBSCRIPTION_STATUS.ACTIVE,
      'subscription.charged':   SUBSCRIPTION_STATUS.ACTIVE,
      'subscription.resumed':   SUBSCRIPTION_STATUS.ACTIVE,
      'subscription.pending':   SUBSCRIPTION_STATUS.PAST_DUE,   // charge failed; Razorpay retrying (dunning)
      'subscription.paused':    SUBSCRIPTION_STATUS.PAUSED,
      'subscription.halted':    SUBSCRIPTION_STATUS.EXPIRED,    // retries exhausted — lapsed but RECOVERABLE (same row)
      'subscription.cancelled': SUBSCRIPTION_STATUS.CANCELLED,  // terminal (user/admin) — a return is a new subscription
      'subscription.completed': SUBSCRIPTION_STATUS.CANCELLED,
      'payment.failed':         SUBSCRIPTION_STATUS.PAST_DUE,
    };

    const newStatusId = STATUS_MAP[event];
    if (newStatusId !== undefined) {
      const now = new Date();
      const nowMs = now.getTime();
      const nowIso = now.toISOString();
      const subUpdate = { status_id: newStatusId };

      // On a successful (re)charge, stamp the authoritative paid-through boundary from Razorpay
      // as an INSTANT (timezone-correct — the source of truth for access). Also advance the
      // legacy end_date (kept for display until the frontend reads current_period_end directly).
      // This is also the recovery path: a halted/expired (non-cancelled) row reactivates here →
      // status active + boundary forward, on the SAME row.
      if (event === 'subscription.charged') {
        if (sub?.current_start) subUpdate.current_period_start = new Date(sub.current_start * 1000).toISOString();
        if (sub?.current_end) {
          subUpdate.current_period_end = new Date(sub.current_end * 1000).toISOString();
          subUpdate.end_date           = new Date(sub.current_end * 1000).toISOString().slice(0, 10);
        }
      }

      // Cancellation grace-guard. We cancel Razorpay IMMEDIATELY, so subscription.cancelled fires
      // right away — do NOT end access mid-cycle. While still within the paid-through boundary,
      // preserve access (leave status active) and just flag "won't renew" (also covers a cancel
      // initiated from the Razorpay dashboard). Access flips off via the derive rule at the
      // boundary; the daily reconcile job relabels the row to cancelled. Only relabel here if the
      // boundary is already past or unknown.
      if (newStatusId === SUBSCRIPTION_STATUS.CANCELLED) {   // subscription.cancelled / .completed
        // Attribute the cancellation ONLY when no app-initiated path already did (fill-when-null),
        // so a cancel from the Razorpay dashboard / support is captured too. subscription.completed
        // (term reached) is distinct from an external cancel.
        if (subRow.cancellation_reason_id == null) {
          subUpdate.cancellation_reason_id = event === 'subscription.completed'
            ? CANCELLATION_REASON.COMPLETED
            : CANCELLATION_REASON.ADMIN_EXTERNAL;
        }
        if (subRow.cancellation_requested_at == null) subUpdate.cancellation_requested_at = nowIso;

        const graceEndMs = subRow.current_period_end ? new Date(subRow.current_period_end).getTime() : null;
        if (graceEndMs && graceEndMs > nowMs) {
          delete subUpdate.status_id;                        // within grace → keep access
          subUpdate.cancel_at_period_end = true;             // reflect "won't renew"
        } else if (!subRow.current_period_end) {
          subUpdate.end_date = nowIso.slice(0, 10);          // no known boundary → end now (legacy)
        }
      } else if (newStatusId === SUBSCRIPTION_STATUS.PAUSED) {
        subUpdate.end_date = nowIso.slice(0, 10);            // pause flow, unchanged
      }

      // Error-checked: a failed write throws → 500 → Razorpay retries (no silent loss).
      if (Object.keys(subUpdate).length > 0) {
        const { error: subUpdErr } = await supabase
          .from('baker_subscriptions').update(subUpdate).eq('id', subRow.id);
        if (subUpdErr) throw new Error(`baker_subscriptions update failed: ${subUpdErr.message}`);
      }
      // Mirror status onto bakers only when we actually changed status AND this is the current sub.
      if (isCurrent && subUpdate.status_id !== undefined) {
        const { error: bakerUpdErr } = await supabase.from('bakers')
          .update({ subscription_status_id: subUpdate.status_id }).eq('id', bakerId);
        if (bakerUpdErr) throw new Error(`bakers status update failed: ${bakerUpdErr.message}`);
      }
    }

    // ── Deferred downgrade, step 3: the parked LOWER sub activated at cycle end → PROMOTE it ─────
    // The baker rode the old (higher) plan to period end; now switch them to the new plan, supersede
    // the old row, and clear the schedule. Guarded by the scheduled_subscription_id link (cleared here)
    // → idempotent: later renewal charges of this sub won't re-run it.
    if (event === 'subscription.activated' || event === 'subscription.charged') {
      const { data: oldRow } = await supabase.from('baker_subscriptions')
        .select('id, billing_subscription_id, plan_id')
        .eq('scheduled_subscription_id', razorpaySubId).maybeSingle();
      if (oldRow) {
        const promoNow = new Date().toISOString();
        await supabase.from('baker_subscriptions').update({
          status_id:                 SUBSCRIPTION_STATUS.CANCELLED,
          end_date:                  promoNow.slice(0, 10),
          scheduled_plan_id:         null,
          scheduled_effective_at:    null,
          scheduled_subscription_id: null,
        }).eq('id', oldRow.id);
        // The old sub was cancel-at-cycle-end; make sure it's really closed now.
        await razorpayCancelSubscription(oldRow.billing_subscription_id, false).catch(() => {});
        // Promote: the baker is now on THIS (lower) sub + plan.
        await supabase.from('bakers').update({
          billing_subscription_id: razorpaySubId,
          subscription_plan_id:    subRow.plan_id,
          subscription_status_id:  SUBSCRIPTION_STATUS.ACTIVE,
        }).eq('id', bakerId);
        await logSubscriptionEvent(bakerId, {
          event:        'downgraded',
          previousTier: PLAN.NAME_BY_ID[oldRow.plan_id] ?? null,
          newTier:      PLAN.NAME_BY_ID[subRow.plan_id] ?? null,
          newStatus:    'active',
          changedBy:    'razorpay',
        }).catch(err => console.error('[billing] downgrade-applied event log failed:', err.message));
      }
    }

    // First activation (customer authorised payment) → record it in the subscription
    // history. subscribe() doesn't log for the paid flow, so the audit event lives here.
    if (event === 'subscription.activated') {
      await logSubscriptionEvent(bakerId, {
        event:     'activated',
        newTier:   PLAN.NAME_BY_ID[subRow.plan_id] ?? null,
        newStatus: 'active',
        changedBy: 'razorpay',
      }).catch(err => console.error('[billing] activation event log failed:', err.message));
    }

    // Record the payment on activation AND charge (whichever carries the payment entity
    // first) — onConflict makes it idempotent, so no duplicate. No longer hinges solely on
    // subscription.charged arriving. Error-checked so a failed write can't vanish silently.
    const PAYMENT_EVENT_STATUS = {
      'subscription.activated': PAYMENT_STATUS.CAPTURED,
      'subscription.charged':   PAYMENT_STATUS.CAPTURED,
      'payment.failed':         PAYMENT_STATUS.FAILED,
    };
    if (payment?.id && PAYMENT_EVENT_STATUS[event] !== undefined) {
      const { error: payErr } = await supabase.from('payments').upsert({
        baker_id:                 bakerId,
        baker_subscription_id:    subRow.id,
        razorpay_payment_id:      payment.id,
        razorpay_subscription_id: razorpaySubId,
        amount:                   payment.amount ?? 0,
        currency:                 payment.currency ?? 'INR',
        status_id:                PAYMENT_EVENT_STATUS[event],
        charged_at:               payment.created_at
          ? new Date(payment.created_at * 1000).toISOString()
          : new Date().toISOString(),
      }, { onConflict: 'razorpay_payment_id', ignoreDuplicates: true });
      if (payErr) throw new Error(`payments upsert failed: ${payErr.message}`);
    }

    // ── Lifecycle emails (baker-facing) ───────────────────────────────────────
    // Fire ONLY for the baker's CURRENT subscription — a stale event, or the cancel of a sub that
    // was just superseded by an upgrade, must not email. Each event maps to at most one email
    // (charged only when it's a real renewal, not the first activation charge). Best-effort: a send
    // hiccup must NOT throw — that would 500 the webhook, make Razorpay retry the whole thing, and
    // risk double-processing — so wrap and swallow.
    if (isCurrent && bakerRow) {
      const planName      = PLAN.NAME_BY_ID[subRow.plan_id] ?? null;
      const nextBillingAt = sub?.current_end ? new Date(sub.current_end * 1000).toISOString() : null;
      try {
        if (event === 'subscription.activated') {
          await notifySubscriptionActivated(bakerRow, { planName, nextBillingAt });
        } else if (event === 'subscription.charged' && (sub?.paid_count ?? 0) > 1) {
          await notifySubscriptionRenewed(bakerRow, { planName, nextBillingAt, amount: payment?.amount ?? null });
        } else if (event === 'subscription.pending') {
          await notifyPaymentFailed(bakerRow, { planName, shortUrl: sub?.short_url ?? null });
        } else if (event === 'subscription.cancelled' && subRow.cancellation_reason_id !== CANCELLATION_REASON.DOWNGRADE) {
          // Skip when this cancel is a downgrade handoff (the lower plan takes over) — not a real cancel.
          await notifySubscriptionCancelled(bakerRow, { planName, accessUntil: subRow.current_period_end ?? nextBillingAt });
        } else if (event === 'subscription.halted' || event === 'subscription.completed') {
          await notifySubscriptionExpired(bakerRow, { planName });
        }
      } catch (err) {
        console.error('[billing] lifecycle email dispatch failed:', err.message);
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Billing webhook error:', err.message);
    serverError(req, res, err);
  }
});

export default router;
