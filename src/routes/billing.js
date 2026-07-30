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
import { isValidGstin, normalizeGstin } from '../lib/gstin.js';
import { emitSaleEvent }       from '../services/billingEvents.js';
import { creditPurchase }      from '../services/aiCredits.js';

const router = Router();

// Deferred recreate flows: every one is mechanically cancel-old + park-new-sub with
// start_at = current_period_end. The `notes.change` intent tag (set at subscribe time) is what
// tells them apart — NOT tier rank, which collides on the SAME-plan cases (reactivate vs
// payment-method change vs interval switch). The webhook branches on this set in steps 2/3 +
// the activation log. 'interval' = same tier, different billing period (monthly↔yearly): a fresh
// mandate at the new period authorized now, first charge deferred to cycle end (monthly→yearly
// can't reuse the UPI mandate — the annual amount exceeds its max — so it's a recreate like the rest).
const DEFERRED_CHANGES = new Set(['downgrade', 'reactivate', 'payment_method', 'interval']);

// ── Razorpay client + helpers ───────────────────────────────────────────────────
// Lazily construct the SDK so local/dev boot never fails without keys; the helpers
// throw a clear error at call time when Razorpay isn't configured. `razorpayEnabled`
// lets the subscribe route fall back to immediate (no-charge) activation in envs
// without keys, while configured envs go through real Checkout.
export function razorpayEnabled() {
  return !!(config.razorpay.keyId && config.razorpay.keySecret);
}
let _razorpay = null;
export function razorpay() {
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
    const baker = await getBakerForUser(req.user.id, 'id, gstin');
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
      // Deferred downgrade: the baker stays on `tier` until scheduled_downgrade_at, then moves to
      // scheduled_downgrade_to. Null when no downgrade is scheduled. Drives "X until <date>, then Y".
      scheduled_downgrade_to: sub.scheduled_plan?.name ?? null,
      scheduled_downgrade_at: sub.scheduled_effective_at ?? null,
      // Interval switch (same tier, different period): the period the baker moves to at the boundary.
      // Null unless a same-tier monthly↔yearly change is armed. Drives "Monthly until <date>, then Yearly".
      scheduled_period: sub.scheduled_period?.name ?? null,
      // Recipient GSTIN (for the checkout screen to prefill + the tax invoice). Null when not provided.
      gstin: baker.gstin ?? null,
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── PATCH /billing/tax-profile ────────────────────────────────────────────────
// Save the baker's GSTIN (captured on the checkout screen). Persisted on the profile so automatic
// renewals reuse it — the charge event snapshot reads it from here. Send gstin: null/'' to clear it.
router.patch('/billing/tax-profile', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });

    if (!('gstin' in req.body)) return res.status(400).json({ error: 'gstin is required' });
    const raw = req.body.gstin;
    let gstin = null;
    if (raw != null && String(raw).trim() !== '') {
      gstin = normalizeGstin(raw);
      if (!isValidGstin(gstin)) return res.status(400).json({ error: 'That GSTIN isn’t valid.', code: 'invalid_gstin' });
    }

    const { error } = await supabase.from('bakers').update({ gstin }).eq('id', baker.id);
    if (error) return serverError(req, res, error);
    res.json({ gstin });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /billing/subscribe ───────────────────────────────────────────────────
router.post('/billing/subscribe', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const { tier, billing_period_id, intent } = req.body;
    if (!tier || !billing_period_id) {
      return res.status(400).json({ error: 'tier and billing_period_id are required' });
    }

    const periodName = PERIOD.NAME_BY_ID[billing_period_id];
    if (!periodName) return res.status(400).json({ error: 'Invalid billing period' });
    const planId = PLAN.ID_BY_NAME[tier];
    if (!planId) return res.status(400).json({ error: `Unknown plan: ${tier}` });
    // Spark is the FREE baseline — it can't be subscribed to. A paid baker returning to free is a
    // CANCELLATION (revert to free at period end), which goes through /billing/cancel, not here. This
    // also fails closed if the UI ever offers Spark as a selectable plan.
    if (planId === PLAN.SPARK) {
      return res.status(400).json({ error: 'The free plan can’t be subscribed to. Cancel your plan to return to it.', code: 'free_plan_not_subscribable' });
    }

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
      // Winding down = cancelled but still in the grace window (status 'active' + cancel_at_period_end).
      // A resubscribe here is a REACTIVATION (un-cancel), which may target the SAME plan.
      const reactivating = onPaid && current.cancel_at_period_end === true;
      const direction = onPaid
        ? planChangeDirection(PLAN.RANK_BY_ID[curPlanId], PLAN.RANK_BY_ID[planId])
        : null;   // null = fresh subscribe from free/none
      // Payment-method change: an ACTIVE (not winding-down) baker re-authorizing a new mandate on the
      // SAME plan (e.g. UPI→card, or a fresh card). Mechanically a recreate like any other change — the
      // new method is simply picked at Checkout. Deferred to cycle end (below) so there's no double charge
      // and the old (possibly dead/expiring) method is never charged again.
      const changingMethod = intent === 'change_method' && onPaid
        && direction === PLAN_CHANGE.SAME && !reactivating;
      // Interval switch: SAME tier, DIFFERENT billing period (monthly↔yearly). Decided by comparing
      // periods (server-authoritative — the client's intent tag is not trusted to gate it). Deferred to
      // cycle end in BOTH directions: yearly→monthly can't refund the prepaid year, and monthly→yearly
      // can't grow the UPI mandate, so a fresh mandate at the new period is authorized now with the first
      // charge at the boundary. Excludes the payment-method case (same period).
      const switchingInterval = onPaid && direction === PLAN_CHANGE.SAME && !reactivating
        && !changingMethod && !!current.period?.name && current.period.name !== periodName;
      // Same plan is a no-op — UNLESS reactivating (un-cancel), changing the payment method, or switching
      // the billing interval. Only same tier AND same period is the true no-op.
      if (direction === PLAN_CHANGE.SAME && !reactivating && !changingMethod && !switchingInterval) {
        return res.status(409).json({ error: `You're already on the ${tier} ${periodName} plan.` });
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

      // ── DEFERRED to cycle end (SUBSCRIPTION_CHANGE_PLAN.md §8) ─────────────────
      // Triggered by a DOWNGRADE, by REACTIVATING (un-cancel) to the same/lower tier while winding down,
      // by a PAYMENT-METHOD change (same plan, new mandate), or by an INTERVAL switch (same tier, new
      // period) — all keep the paid grace and defer the first charge to the next cycle. (Reactivating to
      // a HIGHER tier falls through to the immediate upgrade path.) Park the target sub with start_at =
      // current_period_end: authorized now (Checkout), first charge next cycle. Do NOT cancel the old sub
      // or repoint the baker yet — the `subscription.authenticated` webhook commits it AT CYCLE END and
      // only AFTER the new mandate is authorized (safe sequencing). notes.change tells the webhook which
      // kind it is ('downgrade' | 'reactivate' | 'payment_method' | 'interval') — drives history + reason + display.
      const deferred = direction === PLAN_CHANGE.DOWNGRADE
        || (reactivating && direction !== PLAN_CHANGE.UPGRADE)
        || changingMethod
        || switchingInterval;
      if (deferred) {
        if (!current.current_period_end) {
          return res.status(409).json({ error: 'Your renewal date isn’t known yet — please try again shortly.' });
        }
        const startAt    = Math.floor(new Date(current.current_period_end).getTime() / 1000);
        const changeKind = reactivating ? 'reactivate'
          : changingMethod ? 'payment_method'
          : switchingInterval ? 'interval'
          : 'downgrade';
        const parked  = await razorpayCreateSubscription(razorpayPlanId, totalCount,
          { baker_id: baker.id, tier, period: periodName, change: changeKind }, startAt);

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

        // We DON'T commit the downgrade on the current row yet. It's committed only when the parked
        // mandate is AUTHORIZED (subscription.authenticated → step 2), so an abandoned Checkout leaves
        // the current plan + the UI untouched (no phantom "downgrade scheduled"). The parked sub's
        // notes.change='downgrade' is how step 2 recognises it.
        return res.json({ key_id: config.razorpay.keyId, subscription_id: parked.id, scheduled: true });
      }

      // ── UPGRADE / FRESH subscribe → immediate (existing behaviour, unchanged) ──
      // Cancel any in-flight Razorpay subscription before starting a new one.
      if (baker.billing_subscription_id) {
        await razorpayCancelSubscription(baker.billing_subscription_id, false)
          .catch(err => console.error('[billing] cancel previous Razorpay sub failed:', err.message));
      }

      // change = 'upgrade' (from a lower paid tier) or 'new' (fresh from free) → the activation webhook
      // labels the history event accordingly ('upgraded' / 'subscribed').
      const subscription = await razorpayCreateSubscription(razorpayPlanId, totalCount,
        { baker_id: baker.id, tier, period: periodName, change: direction === PLAN_CHANGE.UPGRADE ? 'upgrade' : 'new' });

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

// Typed billing error — carries an httpStatus/code so callers (route or account deletion) map it to
// the right response instead of falsely reporting a cancel we could not send to the provider.
function billingError(httpStatus, code, message) {
  const e = new Error(message);
  e.httpStatus = httpStatus;
  e.code = code;
  return e;
}

// Cancel a baker's subscription — the ONE Razorpay-cancel path, shared by the baker-initiated
// POST /billing/cancel AND account deletion (routes/account.js). Cancels IMMEDIATELY in Razorpay
// (certain + auditable) and marks the current row cancel_at_period_end so paid access is preserved
// as a GRACE period until current_period_end but never renews. FAIL-CLOSED: throws a typed error if
// a real Razorpay sub can't be cancelled (keys missing / provider rejects) — the caller must NOT
// report success while Razorpay keeps charging. No-op-safe for free/Spark bakers (no Razorpay sub).
export async function cancelBakerSubscription(bakerId, { changedBy = 'baker', reasonKey = null, note = null } = {}) {
  const { data: baker } = await supabase
    .from('bakers').select('id, billing_subscription_id').eq('id', bakerId).maybeSingle();
  if (!baker) throw billingError(404, 'baker_not_found', 'Baker not found');

  const current = await deriveSubscription(baker.id);
  const today   = new Date().toISOString().slice(0, 10);

  // If a downgrade is scheduled on the current row, cancellation SUPERSEDES it (last-action-wins):
  // abort the parked lower sub + clear the schedule so it never promotes.
  let parkedDowngradeSubId = null;
  if (current.id) {
    const { data: cur } = await supabase.from('baker_subscriptions')
      .select('scheduled_subscription_id').eq('id', current.id).maybeSingle();
    parkedDowngradeSubId = cur?.scheduled_subscription_id ?? null;
  }

  // Cancel IMMEDIATELY in Razorpay (atCycleEnd=false) — flips it to `cancelled` synchronously so the
  // cancel is verifiable; local grace until current_period_end preserves paid access. Fail-closed if
  // Razorpay is a real sub we can't reach/cancel.
  if (baker.billing_subscription_id) {
    if (!razorpayEnabled()) {
      console.error('[billing] cancel blocked: Razorpay not configured — refusing to report a cancel we cannot send to the provider');
      throw billingError(503, 'razorpay_unavailable', 'Billing is temporarily unavailable. Please try again shortly.');
    }
    try {
      await razorpayCancelSubscription(baker.billing_subscription_id, false);
    } catch (err) {
      // A deferred downgrade may have already cancelled this sub at authorize time — that's success.
      const already = await razorpay().subscriptions.fetch(baker.billing_subscription_id)
        .then(s => s.status === 'cancelled').catch(() => false);
      if (!already) {
        console.error('[billing] Razorpay cancel failed:', err.message);
        throw billingError(502, 'razorpay_cancel_failed', 'Could not cancel with the payment provider. Please try again.');
      }
      console.warn('[billing] current sub already cancelled (downgrade in progress) — treating cancel as success');
    }
  }

  // Supersede any scheduled downgrade: cancel the parked lower sub + close its PENDING row.
  if (parkedDowngradeSubId) {
    await razorpayCancelSubscription(parkedDowngradeSubId, false)
      .catch(e => console.error('[billing] cancel parked downgrade sub failed:', e.message));
    await supabase.from('baker_subscriptions')
      .update({ status_id: SUBSCRIPTION_STATUS.CANCELLED, end_date: today })
      .eq('billing_subscription_id', parkedDowngradeSubId);
  }

  // Optional churn reason — validated against the customer-selectable master list; falls back to the
  // generic customer_requested when omitted/invalid.
  let cancellationReasonId = CANCELLATION_REASON.CUSTOMER_REQUESTED;
  if (reasonKey) {
    const { data: r } = await supabase.from('cancellation_reasons')
      .select('id').eq('key', reasonKey).eq('is_customer_selectable', true).eq('is_active', true).maybeSingle();
    if (r) cancellationReasonId = r.id;
  }

  // Mark the CURRENT row: grace access (status stays active) until current_period_end even though
  // Razorpay is already cancelled; won't renew. Paid-through boundary (end_date/current_period_end)
  // is preserved; the daily reconcile relabels to cancelled once it passes.
  const markQuery = supabase.from('baker_subscriptions')
    .update({
      cancel_at_period_end:      true,
      cancellation_requested_at: new Date().toISOString(),
      cancellation_reason_id:    cancellationReasonId,
      cancellation_note:         note ?? null,
      scheduled_plan_id:         null,
      scheduled_effective_at:    null,
      scheduled_subscription_id: null,
    });
  const { error: markErr } = baker.billing_subscription_id
    ? await markQuery.eq('billing_subscription_id', baker.billing_subscription_id)
    : await markQuery.eq('baker_id', baker.id).eq('status_id', SUBSCRIPTION_STATUS.ACTIVE);
  if (markErr) throw markErr;

  await logSubscriptionEvent(baker.id, {
    event:          'cancelled',
    previousTier:   current.plan?.name ?? null,
    newTier:        current.plan?.name ?? null,
    previousStatus: current.status,
    newStatus:      'cancelled',
    changedBy,
  });

  return { ok: true, hadPaidSub: !!baker.billing_subscription_id };
}

// ── POST /billing/cancel ──────────────────────────────────────────────────────
router.post('/billing/cancel', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const baker = await getBakerForUser(req.user.id, 'id');
    if (!baker) return res.status(404).json({ error: 'Baker not found' });
    const { reason, note } = req.body ?? {};
    await cancelBakerSubscription(baker.id, { changedBy: 'baker', reasonKey: reason, note });
    res.json({ ok: true });
  } catch (err) {
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message, code: err.code });
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

    // ── AI credit top-up (one-time payment, NOT a subscription) ─────────────────────────────────
    // MUST run before the razorpaySubId guard below: a pack purchase is a Razorpay ORDER, so its
    // payment entity carries no subscription_id and the guard would silently drop it — the baker
    // would be charged and credited nothing.
    //
    // Identified by notes.kind, which POST /baker/ai-credits/purchase stamps on the order. The
    // baker id comes from those notes rather than from any lookup: the notes were written
    // server-side at checkout from the authenticated principal, so they are ours, not the client's.
    //
    // Idempotent by razorpay payment id (unique index on credit_transactions.idempotency_key), so a
    // redelivery returns the original row instead of minting a second batch.
    if (payment?.notes?.kind === 'ai_credit_pack' && event === 'payment.captured') {
      const { baker_id: packBakerId, pack_key: packKey } = payment.notes;
      if (packBakerId && packKey) {
        const txId = await creditPurchase({
          bakerId:           packBakerId,
          packKey,
          razorpayPaymentId: payment.id,
          note:              `razorpay order ${payment.order_id ?? '?'}`,
        });
        if (!txId) console.error('[billing] credit pack purchase not recorded — unknown pack', packKey, payment.id);
        // TODO(GST): a pack sale is a taxable supply at ISSUE (AI_CREDITS_PLAN.md §2.4) and needs an
        // invoice, exactly like a subscription charge. emitSaleEvent() is subscription-shaped
        // (plan_id / billing_period_id / period_months), so forcing a pack through it would put a
        // false line in the accounting feed. Needs a sibling emitter before packs are sold for real.
      }
      return res.json({ ok: true });
    }

    const razorpaySubId = sub?.id ?? payment?.subscription_id ?? null;
    if (!razorpaySubId) return res.json({ ok: true });

    // Match the EXACT local row for this Razorpay subscription by its billing_subscription_id
    // — NOT "the baker's most-recent non-cancelled row", which let a late event for a
    // superseded sub mutate the wrong (current) row.
    const { data: subRow, error: subLookupErr } = await supabase
      .from('baker_subscriptions')
      .select('id, baker_id, plan_id, billing_period_id, current_period_end, cancellation_reason_id, cancellation_requested_at, scheduled_subscription_id')
      .eq('billing_subscription_id', razorpaySubId).maybeSingle();
    if (subLookupErr) throw new Error(`sub lookup failed: ${subLookupErr.message}`);
    if (!subRow) return res.json({ ok: true });
    const bakerId = subRow.baker_id;

    // Only mirror status onto bakers when this IS the baker's current subscription, so a
    // stale event for an old sub can't clobber the live status.
    const { data: bakerRow } = await supabase
      .from('bakers')
      .select('id, name, email, timezone, billing_subscription_id, gstin, address_line1, address_line2, city, state, postal_code, country')
      .eq('id', bakerId).maybeSingle();
    const isCurrent = bakerRow?.billing_subscription_id === razorpaySubId;

    // ── Deferred downgrade, step 2: the parked LOWER sub just got its mandate authorized ─────────
    // The downgrade is COMMITTED only here (safe sequencing / option 1) — an abandoned Checkout never
    // fires this, so the current plan + UI stay untouched (no phantom "downgrade scheduled"). Recognise
    // the parked sub by its notes.change='downgrade'; the OLD (higher) sub is the baker's ACTIVE row.
    // Intent of a deferred recreate, stashed at subscribe time. EVERY paid transition is mechanically
    // cancel-old + new-sub; this tag (NOT tier rank) is what tells the flows apart — critical for the
    // SAME-plan cases (reactivate vs payment-method change) that rank can't distinguish.
    const deferredChange = sub?.notes?.change;   // 'downgrade' | 'reactivate' | 'payment_method' | 'interval' (else undefined)
    if (event === 'subscription.authenticated' && DEFERRED_CHANGES.has(deferredChange)) {
      const isReactivate    = deferredChange === 'reactivate';
      const isPaymentMethod = deferredChange === 'payment_method';
      const isInterval      = deferredChange === 'interval';
      const parkedRow = subRow;   // looked up above by billing_subscription_id = this parked sub
      const { data: oldRow } = await supabase.from('baker_subscriptions')
        .select('id, baker_id, plan_id, billing_subscription_id, current_period_end')
        .eq('baker_id', parkedRow.baker_id).eq('status_id', SUBSCRIPTION_STATUS.ACTIVE)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (oldRow?.billing_subscription_id) {
        // Commit the pending change on the current (active) row — the SOURCE OF TRUTH the UI + step 3 read.
        // The old sub is superseded at cycle end by the parked one (scheduled_subscription_id). The cancel
        // below fires subscription.cancelled on the old sub while it's still current — the email + reason
        // handlers recognise that as a HANDOFF (not a real cancel) via the armed scheduled_subscription_id.
        // DOWNGRADE keeps the explicit DOWNGRADE reason (its own suppression + audit); REACTIVATE clears
        // the baker's cancellation; PAYMENT-METHOD + INTERVAL leave reason null (superseded — the real
        // audit is the 'payment_method_changed' / 'interval_changed' event logged below). scheduled_plan_id
        // = parkedRow.plan_id is the SAME tier for interval (the plan continues); the period change is read
        // from the parked sub in get_baker_subscription (scheduled_period_*).
        await supabase.from('baker_subscriptions').update({
          scheduled_plan_id:         parkedRow.plan_id,
          scheduled_effective_at:    oldRow.current_period_end,
          scheduled_subscription_id: razorpaySubId,
          cancel_at_period_end:      true,
          cancellation_reason_id:    (isReactivate || isPaymentMethod || isInterval) ? null : CANCELLATION_REASON.DOWNGRADE,
          ...(isReactivate ? { cancellation_requested_at: null, cancellation_note: null } : {}),
        }).eq('id', oldRow.id);
        // Cancel the OLD (active) sub IMMEDIATELY for DOWNGRADE, PAYMENT-METHOD and INTERVAL — cancel-at-
        // cycle-end no-ops on UPI (verified: end_at/charge_at stay armed → old would re-charge, on the OLD
        // method). Baker keeps the tier LOCALLY via the current_period_end grace rule. REACTIVATE skips —
        // the old sub is already cancelled (baker cancelled first), so re-cancelling would fire a spurious email.
        if (!isReactivate) {
          await razorpayCancelSubscription(oldRow.billing_subscription_id, false)
            .catch(e => console.error('[billing] immediate cancel of old sub (deferred change) failed:', e.message));
        }
        // Log the baker's ACTION here (armed). Downgrade ALSO logs 'downgraded' when it APPLIES (step 3);
        // reactivate + payment-method + interval are one-moment actions, so step 3 does NOT re-log them.
        await logSubscriptionEvent(oldRow.baker_id, {
          event: isPaymentMethod ? 'payment_method_changed'
            : isInterval ? 'interval_changed'
            : isReactivate ? 'reactivated' : 'downgrade_scheduled',
          previousTier: PLAN.NAME_BY_ID[oldRow.plan_id] ?? null,
          newTier: PLAN.NAME_BY_ID[parkedRow.plan_id] ?? null, newStatus: 'active', changedBy: 'razorpay',
        }).catch(err => console.error('[billing] deferred-change log failed:', err.message));
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
        // Don't attribute an external/admin cancel when this is a deferred-change HANDOFF (the old sub is
        // being replaced by the armed scheduled_subscription_id) — that's a supersession, not a real cancel.
        if (subRow.cancellation_reason_id == null && !subRow.scheduled_subscription_id) {
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

    // ── Deferred change, step 3: the parked sub activated at cycle end → PROMOTE it ─────────────
    // The baker rode the old plan to period end; now switch them to the new plan, supersede the old
    // row, and clear the schedule. Covers a scheduled DOWNGRADE and a REACTIVATION (same/lower). Guarded
    // by scheduled_subscription_id (cleared here) → idempotent: later renewal charges won't re-run it.
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
        // Promote: the baker is now on THIS sub + plan.
        await supabase.from('bakers').update({
          billing_subscription_id: razorpaySubId,
          subscription_plan_id:    subRow.plan_id,
          subscription_status_id:  SUBSCRIPTION_STATUS.ACTIVE,
        }).eq('id', bakerId);
        // Log the APPLIED transition — driven by INTENT (notes.change), NOT tier rank, since same-plan
        // changes (reactivate / payment-method / interval) are rank-identical. Reactivate, payment-method
        // and interval are one-moment actions already logged when armed (step 2), so they DON'T re-log here;
        // downgrade logs 'downgraded' now (distinct from its 'downgrade_scheduled'). Fall back to rank only
        // if the intent tag is somehow absent.
        const change = sub?.notes?.change;
        const oldRank = PLAN.RANK_BY_ID[oldRow.plan_id], newRank = PLAN.RANK_BY_ID[subRow.plan_id];
        const appliedEvent = DEFERRED_CHANGES.has(change)
          ? (change === 'downgrade' ? 'downgraded' : null)   // reactivate / payment_method: logged at step 2
          : (newRank < oldRank ? 'downgraded' : newRank > oldRank ? 'upgraded' : 'reactivated');
        if (appliedEvent) {
          await logSubscriptionEvent(bakerId, {
            event:        appliedEvent,
            previousTier: PLAN.NAME_BY_ID[oldRow.plan_id] ?? null,
            newTier:      PLAN.NAME_BY_ID[subRow.plan_id] ?? null,
            newStatus:    'active',
            changedBy:    'razorpay',
          }).catch(err => console.error('[billing] deferred-change applied event log failed:', err.message));
        }
      }
    }

    // First activation (customer authorised payment) → record it in the subscription history.
    // Label it by INTENT (stashed in the Razorpay sub notes.change at subscribe time) so the timeline
    // reads "Subscribed to X" / "Upgraded to X" instead of a flat "activated". Downgrades are NOT
    // logged here — the cycle-end promotion (step 3 above) logs 'downgraded' with both tiers.
    if (event === 'subscription.activated') {
      const change = sub?.notes?.change;
      // Skip for ALL deferred changes — their history is logged when armed (step 2) and, for downgrade,
      // when applied (step 3). Only fresh subscribes / immediate upgrades log their activation here.
      if (!DEFERRED_CHANGES.has(change)) {
        await logSubscriptionEvent(bakerId, {
          event:     change === 'upgrade' ? 'upgraded' : 'subscribed',
          newTier:   PLAN.NAME_BY_ID[subRow.plan_id] ?? null,
          newStatus: 'active',
          changedBy: 'razorpay',
        }).catch(err => console.error('[billing] activation event log failed:', err.message));
      }
    }

    // NOTE: do NOT log 'cancelled' here — the /billing/cancel route already logs it (changed_by='baker'),
    // so logging again on the subscription.cancelled webhook would double it. (External/dashboard cancels
    // going unlogged is a minor known gap — a future targeted log gated on an external reason.)

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

      // Raise the accounting event ONLY for a CAPTURED payment (a real taxable supply). The (deferred)
      // accounting system consumes this to issue the GST invoice. Idempotent + best-effort — see
      // billingEvents.js. Core stays GST-agnostic; the event carries the gross + snapshot only.
      if (PAYMENT_EVENT_STATUS[event] === PAYMENT_STATUS.CAPTURED) {
        const chargedAt = payment.created_at
          ? new Date(payment.created_at * 1000).toISOString()
          : new Date().toISOString();

        await emitSaleEvent({
          payment, subRow, baker: bakerRow, sub, subscriptionId: razorpaySubId,
          chargedAt,
        });

        // Stamp "this baker has paid" ONCE, on the first captured payment. A baker who has
        // entered a paid subscription never returns to trial, so this is a one-way fact and is
        // never cleared (not on cancel, lapse, or downgrade). It's what lets the lapsed-access
        // gate say "your subscription has ended" instead of the false "your trial has ended".
        // Fill-when-null (`is('first_paid_at', null)`) makes it idempotent, so a webhook retry
        // or a later renewal can't overwrite the original date. Best-effort: this is display
        // metadata, so a failure must NOT throw — throwing would 500 the webhook and make
        // Razorpay retry the whole thing, risking double-processing of the payment above.
        const { error: firstPaidErr } = await supabase.from('bakers')
          .update({ first_paid_at: chargedAt })
          .eq('id', bakerId)
          .is('first_paid_at', null);
        if (firstPaidErr) console.error('[billing] first_paid_at stamp failed:', firstPaidErr.message);
      }
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
        } else if (event === 'subscription.cancelled'
                   && subRow.cancellation_reason_id !== CANCELLATION_REASON.DOWNGRADE
                   && !subRow.scheduled_subscription_id) {
          // Skip when this cancel is a deferred-change HANDOFF (downgrade tagged by reason; payment-method
          // by the armed scheduled_subscription_id) — the same/lower plan takes over, so it's not a real cancel.
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
