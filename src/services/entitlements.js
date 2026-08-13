import { supabase } from './supabase.js';
import { deriveSubscription } from '../routes/subscriptions.js';
import { ENTITLEMENTS, BLOCKED_STATUSES } from '../constants/entitlements.js';

// Per-plan entitlement values live on the plan row (admin-editable, seeded once).
// Read per call — plans are a 4-row lookup and this runs once per request.
async function getPlanFeatures(planId) {
  if (!planId) return {};
  const { data } = await supabase
    .from('subscription_plans').select('features').eq('id', planId).maybeSingle();
  return (data?.features && typeof data.features === 'object') ? data.features : {};
}

// Spark trial length in days — configurable on the Spark plan row (features.trial_days),
// admin-editable, no deploy. Read by BOTH Spark-grant paths (provisioning + activate-spark)
// so the trial window can never drift. Fallback 30. NOTE: trial_days is plan CONFIG, not an
// entitlement — getEntitlements only iterates ENTITLEMENTS keys, so it's ignored there.
export async function getSparkTrialDays() {
  const { data } = await supabase
    .from('subscription_plans').select('features').eq('name', 'spark').maybeSingle();
  const d = data?.features?.trial_days;
  return Number.isInteger(d) && d > 0 ? d : 30;
}

// Resolve a baker's entitlements: subscription status (the gate) + the per-key
// values from their plan, with an INACTIVE subscription collapsing everything to
// its fallback. The single source of truth both the middleware and the client read.
export async function getEntitlements(bakerId) {
  const sub      = await deriveSubscription(bakerId);
  const status   = sub?.status ?? 'no_subscription';
  const blocked  = BLOCKED_STATUSES.has(status);
  const features = blocked ? {} : await getPlanFeatures(sub?.plan?.id);

  const ent = {};
  for (const [key, def] of Object.entries(ENTITLEMENTS)) {
    // `key in features` (not ??) so an explicit null (= unlimited) is preserved
    // instead of falling back to the floor.
    const raw = Object.prototype.hasOwnProperty.call(features, key) ? features[key] : def.fallback;
    ent[key] = blocked ? def.fallback : raw;
  }

  return {
    planId: sub?.plan?.id ?? null,
    plan:   sub?.plan?.name ?? null,   // display/telemetry only — never gate on this
    status,
    active: !blocked,
    ent,
    // The day the subscription began — the anchor the AI-credit allowance window is measured
    // from (services/aiCredits.js). start_date, NOT current_period_start: the latter moves
    // yearly on an annual plan, which would hand that baker one allowance a year.
    anchor: sub?.start_date ?? null,
  };
}

// Can this baker accept a NEW order right now? Gated ONLY by an active subscription:
// Spark is "try for a month, then decide" — it lapses past its trial window; paid plans
// stay active while paying. There is NO order-count cap on ANY plan (the only caps are on
// other resources — AI tokens, store themes — never orders). Shared by the order-intake
// guard (orders.js) and the storefront "accepting orders" banner (storefront.js) so the
// two can never drift.
export async function getOrderAcceptance(bakerId) {
  const e = await getEntitlements(bakerId);
  // `ent` rides along because this already paid for it. The public storefront route calls this on
  // every request and then needs `premium_themes` to decide which theme to serve — resolving the
  // set twice on the hottest unauthenticated route would be two round trips for an answer that is
  // sitting right here. Callers that only want `accepting` can keep ignoring it.
  if (!e.active) return { accepting: false, code: 'BAKER_INACTIVE', ent: e };
  return { accepting: true, code: null, ent: e };
}
