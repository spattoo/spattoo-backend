-- Re-add billing_subscription_id to baker_subscriptions — REVERSES
-- drop_baker_subscriptions_billing_id.sql.
--
-- Why: the earlier "baker-level only" decision broke the billing flow. The code writes
-- this column per-row on subscribe (the PENDING park-insert), and the webhook matches
-- each Razorpay event to the EXACT subscription row by it (precise attribution across
-- upgrades / multiple historical rows — "the baker's most-recent non-cancelled row" is
-- not reliable). Without the column the park-insert crashes and no subscription/payment
-- is ever recorded. bakers.billing_subscription_id stays as the baker-level "current"
-- pointer; this row-level column is the per-subscription identity.
--
-- Apply AFTER drop_baker_subscriptions_billing_id.sql on any env where that drop ran.
ALTER TABLE baker_subscriptions ADD COLUMN IF NOT EXISTS billing_subscription_id text;
CREATE INDEX IF NOT EXISTS baker_subscriptions_billing_sub_id_idx
  ON baker_subscriptions(billing_subscription_id);

NOTIFY pgrst, 'reload schema';
