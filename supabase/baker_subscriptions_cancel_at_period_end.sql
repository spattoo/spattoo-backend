-- cancel_at_period_end: the baker cancelled but keeps access until end_date.
-- Set on POST /billing/cancel. The row stays status_id=1 (active) until the cycle ends,
-- when the subscription.cancelled webhook (exact-row match) / daily expiry job flips it to
-- 6 (cancelled). derived_status is unchanged (still 'active' until end_date) — this flag is
-- what the UI uses to show "won't renew" and hide the Cancel button.
ALTER TABLE baker_subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;

-- Recreate get_baker_subscription to expose cancel_at_period_end (RPC return shape changed).
DROP FUNCTION IF EXISTS get_baker_subscription(uuid);
CREATE FUNCTION get_baker_subscription(p_baker_id uuid)
RETURNS TABLE (
  id                   uuid,
  plan_id              int,
  plan_name            text,
  plan_display_name    text,
  period_name          text,
  period_display_name  text,
  status               text,
  derived_status       text,
  start_date           date,
  end_date             date,
  cancel_at_period_end boolean
)
LANGUAGE sql STABLE AS $$
  SELECT
    bs.id,
    sp.id           AS plan_id,
    sp.name         AS plan_name,
    sp.display_name AS plan_display_name,
    bp.name         AS period_name,
    bp.display_name AS period_display_name,
    CASE bs.status_id
      WHEN 1 THEN 'active'
      WHEN 2 THEN 'pending'
      WHEN 3 THEN 'paused'
      WHEN 4 THEN 'past_due'
      WHEN 5 THEN 'expired'
      WHEN 6 THEN 'cancelled'
      ELSE 'unknown'
    END             AS status,
    CASE
      WHEN bs.status_id = 1 AND bs.end_date IS NOT NULL AND bs.end_date < CURRENT_DATE
        THEN 'expired'
      WHEN bs.status_id = 1 THEN 'active'
      WHEN bs.status_id = 2 THEN 'pending'
      WHEN bs.status_id = 3 THEN 'paused'
      WHEN bs.status_id = 4 THEN 'past_due'
      WHEN bs.status_id = 6 THEN 'cancelled'
      ELSE 'unknown'
    END             AS derived_status,
    bs.start_date,
    bs.end_date,
    bs.cancel_at_period_end
  FROM baker_subscriptions bs
  LEFT JOIN subscription_plans sp ON sp.id = bs.plan_id
  LEFT JOIN billing_periods    bp ON bp.id = bs.billing_period_id
  WHERE bs.baker_id = p_baker_id
  ORDER BY bs.created_at DESC
  LIMIT 1;
$$;

NOTIFY pgrst, 'reload schema';
