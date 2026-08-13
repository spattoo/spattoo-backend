// Subscription plan-change helpers (SUBSCRIPTION_CHANGE_PLAN.md).
//
// Direction is decided by tier RANK — `subscription_plans.sort_order` (spark=0, flame=1, blaze=2, forge=3) —
// NOT by `plan_id`. plan_id is a stable surrogate with no ordering guarantee; comparing it would silently
// break if a plan were ever inserted out of id-order. Callers pass the two plans' sort_order values.

export const PLAN_CHANGE = Object.freeze({ UPGRADE: 'upgrade', DOWNGRADE: 'downgrade', SAME: 'same' });

// 'upgrade' | 'downgrade' | 'same' | null (if a rank is missing). Upgrade = immediate; downgrade = deferred
// to current_period_end (see the plan). Equal rank is a no-op the route should reject.
export function planChangeDirection(currentRank, targetRank) {
  if (currentRank == null || targetRank == null) return null;
  if (targetRank > currentRank) return PLAN_CHANGE.UPGRADE;
  if (targetRank < currentRank) return PLAN_CHANGE.DOWNGRADE;
  return PLAN_CHANGE.SAME;
}
