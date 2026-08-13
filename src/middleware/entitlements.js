import { supabase } from '../services/supabase.js';
import { getEntitlements } from '../services/entitlements.js';

// Resolve the requesting baker's entitlements ONCE per request (memoised on req).
// Sits after requireAuth (needs req.user). Returns { planId, plan, status, active, ent }.
export async function ctxEntitlements(req) {
  if (req._entitlements) return req._entitlements;
  const { data: contact } = await supabase
    .from('baker_appusers').select('baker_id').eq('auth_user_id', req.user.id).maybeSingle();
  req._entitlements = contact?.baker_id
    ? await getEntitlements(contact.baker_id)
    : { planId: null, plan: null, status: 'no_baker', active: false, ent: {} };
  return req._entitlements;
}

// Coarse gate: subscription must be active (not expired/cancelled/paused). 402.
export const requireActiveSubscription = async (req, res, next) => {
  try {
    const e = await ctxEntitlements(req);
    if (!e.active) {
      return res.status(402).json({
        error: 'Your subscription is not active.', code: 'SUBSCRIPTION_INACTIVE', status: e.status,
      });
    }
    next();
  } catch (err) { next(err); }
};

// Feature gate: subscription active AND the plan includes `key`. 402 / 403.
export const requireEntitlement = (key) => async (req, res, next) => {
  try {
    const e = await ctxEntitlements(req);
    if (!e.active) {
      return res.status(402).json({
        error: 'Your subscription is not active.', code: 'SUBSCRIPTION_INACTIVE', status: e.status,
      });
    }
    if (!e.ent[key]) {
      return res.status(403).json({
        error: 'Your plan does not include this feature.', code: 'ENTITLEMENT_REQUIRED', entitlement: key,
      });
    }
    next();
  } catch (err) { next(err); }
};

// Numeric-quota check for the action routes (e.g. orders/team). `currentCount` is
// the live usage the route counts. limit === null/undefined ⇒ unlimited. Returns
// { ok, limit }; the route decides the response (so it can include usage context).
export async function checkQuota(req, key, currentCount) {
  const e = await ctxEntitlements(req);
  const limit = e.ent[key];
  const ok = limit == null || currentCount < limit;
  return { ok, limit };
}
