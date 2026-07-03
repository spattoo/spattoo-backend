import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { PLAN }                from '../constants/subscriptionPlans.js';
import { PERIOD }              from '../constants/billingPeriods.js';
import { SUBSCRIPTION_STATUS } from '../constants/subscriptionStatuses.js';
import { planEditorSchema }    from '../constants/entitlements.js';

const router = Router();

// ── Shared helpers ─────────────────────────────────────────────────────────────

export async function logSubscriptionEvent(bakerId, {
  event, previousTier, newTier, previousStatus, newStatus, note, changedBy, changedById,
}) {
  const { error } = await supabase.from('subscription_events').insert({
    baker_id:        bakerId,
    event,
    previous_tier:   previousTier  ?? null,
    new_tier:        newTier       ?? null,
    previous_status: previousStatus ?? null,
    new_status:      newStatus      ?? null,
    note:            note           ?? null,
    changed_by:      changedBy      ?? 'system',
    changed_by_id:   changedById    ?? null,
  });
  if (error) console.error('logSubscriptionEvent failed:', error.message);
}

// Returns the baker's current subscription with derived status.
// Status is derived: if end_date is in the past and status is 'active' → 'expired'.
export async function deriveSubscription(bakerId) {
  const { data, error } = await supabase.rpc('get_baker_subscription', { p_baker_id: bakerId });
  if (error) {
    console.error('deriveSubscription rpc failed:', error.message);
    return { status: 'no_subscription', plan: null, end_date: null, id: null };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) return { status: 'no_subscription', plan: null, end_date: null, id: null };

  return {
    id:         row.id,
    status:     row.derived_status,
    plan:       row.plan_id ? { id: row.plan_id, name: row.plan_name, display_name: row.plan_display_name } : null,
    period:     row.period_name ? { name: row.period_name, display_name: row.period_display_name } : null,
    end_date:   row.end_date,
    start_date: row.start_date,
    cancel_at_period_end: row.cancel_at_period_end ?? false,
    // Instant boundaries (authoritative for access) + cancellation audit. current_period_end
    // is the paid-through instant; access is granted while now() < current_period_end.
    current_period_start:      row.current_period_start      ?? null,
    current_period_end:        row.current_period_end        ?? null,
    cancellation_requested_at: row.cancellation_requested_at ?? null,
    cancellation_reason:       row.cancellation_reason       ?? null,
    cancellation_note:         row.cancellation_note         ?? null,
    // Deferred downgrade scheduled on the active row: the lower plan takes effect at
    // scheduled_effective_at (= current_period_end). Null when no change is pending.
    scheduled_plan: row.scheduled_plan_id
      ? { id: row.scheduled_plan_id, name: row.scheduled_plan_name }
      : null,
    scheduled_effective_at: row.scheduled_effective_at ?? null,
  };
}

// ── GET /admin/entitlements-schema ────────────────────────────────────────────
// Drives the admin plan editor's typed form (keys/types/labels) so plan `features`
// are edited as fields, not hand-typed JSON. Source of truth = the entitlement registry.
router.get('/admin/entitlements-schema', requireAuth, (req, res) => {
  res.json(planEditorSchema());
});

// ── GET /plans (public) ───────────────────────────────────────────────────────
// The marketing plan catalog — ONE source for the billing picker AND the signup
// onboarding wizard (both used to hardcode their own copy, which drifted). Public:
// it's the same pricing/feature info shown on the marketing site, and the onboarding
// wizard reads it before the user even has a baker. Active plans only, in order.
router.get('/plans', async (req, res) => {
  try {
    const FULL = 'name, display_name, tagline, feature_bullets, is_popular, has_storefront, price_monthly, price_yearly, sort_order';
    let { data, error } = await supabase
      .from('subscription_plans').select(FULL).eq('is_active', true).order('sort_order');
    if (error) {
      // Marketing columns not migrated yet (014) → fall back to base columns so the plan
      // picker (billing + signup) is never empty due to deploy-before-migration ordering.
      ({ data, error } = await supabase
        .from('subscription_plans')
        .select('name, display_name, price_monthly, price_yearly, sort_order')
        .eq('is_active', true).order('sort_order'));
      if (error) return serverError(req, res, error);
      data = (data ?? []).map(p => ({ ...p, tagline: null, feature_bullets: [], is_popular: false, has_storefront: p.name !== 'spark' }));
    }
    res.json(data ?? []);
  } catch (err) { serverError(req, res, err); }
});

// ── GET /admin/subscription-plans ─────────────────────────────────────────────
router.get('/admin/subscription-plans', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('subscription_plans').select('*').order('sort_order');
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) { serverError(req, res, err); }
});

// ── POST /admin/subscription-plans ────────────────────────────────────────────
router.post('/admin/subscription-plans', requireAuth, requireCapability('subscription:override'), async (req, res) => {
  try {
    const { name, display_name, price_monthly, price_yearly, features, sort_order,
            tagline, feature_bullets, is_popular, has_storefront } = req.body;
    if (!name || !display_name) return res.status(400).json({ error: 'name and display_name are required' });

    const { data, error } = await supabase
      .from('subscription_plans')
      .insert({
        name, display_name, price_monthly: price_monthly ?? 0, price_yearly: price_yearly ?? 0,
        features: features ?? {}, sort_order: sort_order ?? 0,
        tagline: tagline ?? null, feature_bullets: feature_bullets ?? [],
        is_popular: is_popular ?? false, has_storefront: has_storefront ?? true,
      })
      .select().single();
    if (error) return serverError(req, res, error);
    res.status(201).json(data);
  } catch (err) { serverError(req, res, err); }
});

// ── PATCH /admin/subscription-plans/:id ───────────────────────────────────────
router.patch('/admin/subscription-plans/:id', requireAuth, requireCapability('subscription:override'), async (req, res) => {
  try {
    const ALLOWED = ['display_name', 'price_monthly', 'price_yearly', 'features', 'is_active', 'sort_order',
                     'tagline', 'feature_bullets', 'is_popular', 'has_storefront'];
    const updates = {};
    for (const f of ALLOWED) { if (f in req.body) updates[f] = req.body[f]; }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });

    const { data, error } = await supabase
      .from('subscription_plans').update(updates).eq('id', req.params.id).select().single();
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) { serverError(req, res, err); }
});

// ── GET /admin/bakers/subscriptions ───────────────────────────────────────────
router.get('/admin/bakers/subscriptions', requireAuth, requireCapability('baker:support'), async (req, res) => {
  try {
    const { data, error } = await supabase.rpc('get_baker_subscriptions_admin');
    if (error) return serverError(req, res, error);
    res.json(data ?? []);
  } catch (err) { serverError(req, res, err); }
});

// ── GET /admin/bakers/:id/subscription ────────────────────────────────────────
router.get('/admin/bakers/:id/subscription', requireAuth, requireCapability('baker:support'), async (req, res) => {
  try {
    const { data: baker, error } = await supabase
      .from('bakers').select('id, name, email')
      .eq('id', req.params.id).maybeSingle();
    if (error) return res.status(404).json({ error: 'Baker not found' });

    const current = await deriveSubscription(req.params.id);

    const { data: events } = await supabase
      .from('subscription_events').select('*')
      .eq('baker_id', req.params.id)
      .order('created_at', { ascending: false }).limit(50);

    res.json({ baker, current, events: events ?? [] });
  } catch (err) { serverError(req, res, err); }
});

// ── POST /admin/bakers/:id/subscription ───────────────────────────────────────
// Admin override — create a new baker_subscriptions row with the given plan/status/end date
router.post('/admin/bakers/:id/subscription', requireAuth, requireCapability('subscription:override'), async (req, res) => {
  try {
    const { plan_name, billing_period_id, status, end_date, note } = req.body;
    if (!plan_name) return res.status(400).json({ error: 'plan_name is required' });

    const planId = PLAN.ID_BY_NAME[plan_name];
    if (!planId) return res.status(400).json({ error: `Unknown plan: ${plan_name}` });

    const current = await deriveSubscription(req.params.id);
    const today   = new Date().toISOString().slice(0, 10);

    // Close the current active subscription row
    if (current.id) {
      await supabase.from('baker_subscriptions')
        .update({ status_id: SUBSCRIPTION_STATUS.CANCELLED, end_date: today })
        .eq('id', current.id);
    }

    // Calculate end_date from billing period using constants
    let resolvedEndDate = end_date || null;
    if (!resolvedEndDate && billing_period_id) {
      const months = PERIOD.MONTHS_BY_ID[billing_period_id];
      if (months) {
        const d = new Date();
        d.setMonth(d.getMonth() + months);
        resolvedEndDate = d.toISOString().slice(0, 10);
      }
    }

    // Create the new row
    const statusId = SUBSCRIPTION_STATUS.ID_BY_NAME[status] ?? SUBSCRIPTION_STATUS.ACTIVE;
    const { error: insertErr } = await supabase.from('baker_subscriptions').insert({
      baker_id:          req.params.id,
      plan_id:           planId,
      billing_period_id: billing_period_id || null,
      status_id:         statusId,
      start_date:        today,
      end_date:          resolvedEndDate,
    });
    if (insertErr) return serverError(req, res, insertErr);

    // Keep subscription_plan_id in sync
    await supabase.from('bakers')
      .update({ subscription_plan_id: planId })
      .eq('id', req.params.id);

    await logSubscriptionEvent(req.params.id, {
      event:          'admin_override',
      previousTier:   current.plan?.name ?? null,
      newTier:        plan_name,
      previousStatus: current.status,
      newStatus:      status ?? 'active',
      note,
      changedBy:      'admin',
      changedById:    req.user.id,
    });

    res.json({ ok: true });
  } catch (err) { serverError(req, res, err); }
});

// ── GET /admin/bakers/:id/payments ────────────────────────────────────────────
router.get('/admin/bakers/:id/payments', requireAuth, requireCapability('baker:support'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payments')
      .select('id, razorpay_payment_id, amount, currency, status_id, charged_at')
      .eq('baker_id', req.params.id)
      .order('charged_at', { ascending: false })
      .limit(50);
    if (error) return serverError(req, res, error);
    res.json(data ?? []);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /baker/subscription/history ───────────────────────────────────────────
router.get('/baker/subscription/history', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id')
      .eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account' });

    const { data, error } = await supabase
      .from('subscription_events')
      .select('id, event, previous_tier, new_tier, previous_status, new_status, note, created_at')
      .eq('baker_id', contact.baker_id)
      .order('created_at', { ascending: false }).limit(20);
    if (error) return serverError(req, res, error);
    res.json(data ?? []);
  } catch (err) { serverError(req, res, err); }
});

// ── POST /api/baker/plan/select ──────────────────────────────────────────────
// Onboarding/dev ONLY: the baker sets their own plan WITHOUT payment, so the signup
// wizard can be exercised across tiers. Gated by an explicit per-environment flag
// (ALLOW_FREE_PLAN_SELECT=true) — same model as the marketing SHOW_SIGNIN flag:
// set it on the dev API, never on prod. NODE_ENV can't distinguish them here (the
// dev API also runs NODE_ENV=production on Render). Real upgrades go through
// /api/billing/subscribe (Razorpay). Body: { plan: 'spark'|'flame'|'blaze'|'forge' }.
router.post('/baker/plan/select', requireAuth, requireCapability('billing:manage'), async (req, res) => {
  try {
    if (process.env.ALLOW_FREE_PLAN_SELECT !== 'true') {
      return res.status(403).json({ error: 'Plan selection without payment is disabled' });
    }
    const planName = String(req.body.plan ?? '').toLowerCase();
    const planId   = PLAN.ID_BY_NAME[planName];
    if (!planId) return res.status(400).json({ error: `Unknown plan: ${req.body.plan}` });

    const { data: contact } = await supabase
      .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
    if (!contact) return res.status(404).json({ error: 'No baker account' });
    const bakerId = contact.baker_id;

    const current = await deriveSubscription(bakerId);
    const today   = new Date().toISOString().slice(0, 10);

    // Close the current active subscription row, open a fresh monthly one.
    if (current.id) {
      await supabase.from('baker_subscriptions')
        .update({ status_id: SUBSCRIPTION_STATUS.CANCELLED, end_date: today })
        .eq('id', current.id);
    }
    const end = new Date();
    end.setMonth(end.getMonth() + PERIOD.MONTHS_BY_ID[PERIOD.MONTHLY]);
    const { error: insErr } = await supabase.from('baker_subscriptions').insert({
      baker_id:          bakerId,
      plan_id:           planId,
      billing_period_id: PERIOD.MONTHLY,
      status_id:         SUBSCRIPTION_STATUS.ACTIVE,
      start_date:        today,
      end_date:          end.toISOString().slice(0, 10),
    });
    if (insErr) return serverError(req, res, insErr);

    await supabase.from('bakers')
      .update({ subscription_plan_id: planId, subscription_status_id: SUBSCRIPTION_STATUS.ACTIVE })
      .eq('id', bakerId);

    await logSubscriptionEvent(bakerId, {
      event:          'plan_selected',
      previousTier:   current.plan?.name ?? null,
      newTier:        planName,
      previousStatus: current.status,
      newStatus:      'active',
      note:           'Onboarding plan selection (no charge)',
      changedBy:      'baker',
      changedById:    req.user.id,
    });

    res.json({ ok: true, plan: planName });
  } catch (err) { serverError(req, res, err); }
});

export default router;
