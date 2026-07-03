-- ── baker_subscriptions: scheduled (deferred) plan change ─────────────────────
-- Run once in the Supabase SQL editor. Idempotent.
--
-- Supports the DEFERRED DOWNGRADE (SUBSCRIPTION_CHANGE_PLAN.md). When a baker
-- downgrades, the current (higher) row stays ACTIVE until current_period_end and
-- carries a pending change here; the new (lower) Razorpay sub is parked (authorized
-- now, start_at = cycle end) and its id is stashed so the cycle-end activation
-- webhook can promote it. Upgrades are immediate and do NOT use these columns.
--
--   scheduled_plan_id         the plan the baker will move DOWN to (FK → subscription_plans.id)
--   scheduled_effective_at    when it takes effect (= current_period_end at schedule time)
--   scheduled_subscription_id the parked Razorpay subscription id (authorized, deferred first charge)
--
-- All NULL = no pending change (today's behaviour). Compact surrogate FK to the
-- bounded subscription_plans lookup; no change to the hot access pattern.

ALTER TABLE baker_subscriptions
  ADD COLUMN IF NOT EXISTS scheduled_plan_id         int REFERENCES subscription_plans(id),
  ADD COLUMN IF NOT EXISTS scheduled_effective_at    timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_subscription_id text;

-- Find rows with a pending change due to promote (webhook backstop / reconcile).
CREATE INDEX IF NOT EXISTS baker_subscriptions_scheduled_effective_idx
  ON baker_subscriptions (scheduled_effective_at)
  WHERE scheduled_plan_id IS NOT NULL;
