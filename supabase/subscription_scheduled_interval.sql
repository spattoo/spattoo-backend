-- ── get_baker_subscription: expose the SCHEDULED sub's billing PERIOD ─────────
-- Run once in the Supabase SQL editor. Idempotent (DROP + CREATE).
--
-- For the interval-switch feature (B7): a same-tier monthly↔yearly change parks a new sub at the
-- new period and arms scheduled_subscription_id on the current row. scheduled_plan_id is the SAME
-- tier (the plan continues), so the period is the ONLY thing that changed — but it lived only on the
-- parked row, invisible to the billing screen. Without it, an armed interval switch reads as a plain
-- "renews as <same tier>" and hides the period change (even after a reload, since the panel rebuilds
-- from server state).
--
-- Fix: self-join the parked sub via scheduled_subscription_id → its billing_period, and return
-- scheduled_period_name / scheduled_period_display_name. NULL when no change is pending or the
-- scheduled change keeps the same period (a plain downgrade). Read-only RPC shape change — no table
-- column added, no change to the hot access pattern.

DROP FUNCTION IF EXISTS get_baker_subscription(uuid);
CREATE FUNCTION get_baker_subscription(p_baker_id uuid)
RETURNS TABLE (
  id                            uuid,
  plan_id                       int,
  plan_name                     text,
  plan_display_name             text,
  period_name                   text,
  period_display_name           text,
  status                        text,
  derived_status                text,
  start_date                    date,
  end_date                      date,
  cancel_at_period_end          boolean,
  current_period_start          timestamptz,
  current_period_end            timestamptz,
  cancellation_requested_at     timestamptz,
  cancellation_reason           text,
  cancellation_note             text,
  scheduled_plan_id             int,
  scheduled_plan_name           text,
  scheduled_effective_at        timestamptz,
  scheduled_period_name         text,
  scheduled_period_display_name text
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
      WHEN bs.status_id = 1 AND (
        CASE
          WHEN bs.current_period_end IS NOT NULL THEN now() >= bs.current_period_end
          ELSE bs.end_date IS NOT NULL AND bs.end_date < CURRENT_DATE
        END
      ) THEN 'expired'
      WHEN bs.status_id = 1 THEN 'active'
      WHEN bs.status_id = 2 THEN 'pending'
      WHEN bs.status_id = 3 THEN 'paused'
      WHEN bs.status_id = 4 THEN 'past_due'
      WHEN bs.status_id = 5 THEN 'expired'   -- halted/dunning-exhausted; was missing → 'unknown' → access NOT blocked
      WHEN bs.status_id = 6 THEN 'cancelled'
      ELSE 'unknown'
    END             AS derived_status,
    bs.start_date,
    bs.end_date,
    bs.cancel_at_period_end,
    bs.current_period_start,
    bs.current_period_end,
    bs.cancellation_requested_at,
    cr.key          AS cancellation_reason,
    bs.cancellation_note,
    bs.scheduled_plan_id,
    ssp.name        AS scheduled_plan_name,
    bs.scheduled_effective_at,
    sbp.name         AS scheduled_period_name,
    sbp.display_name AS scheduled_period_display_name
  FROM baker_subscriptions bs
  LEFT JOIN subscription_plans   sp  ON sp.id  = bs.plan_id
  LEFT JOIN subscription_plans   ssp ON ssp.id = bs.scheduled_plan_id
  LEFT JOIN billing_periods      bp  ON bp.id  = bs.billing_period_id
  LEFT JOIN cancellation_reasons cr  ON cr.id  = bs.cancellation_reason_id
  -- The parked (scheduled) sub — its billing period is the target of an interval switch.
  LEFT JOIN baker_subscriptions  ss  ON ss.billing_subscription_id = bs.scheduled_subscription_id
  LEFT JOIN billing_periods      sbp ON sbp.id = ss.billing_period_id
  WHERE bs.baker_id = p_baker_id
  ORDER BY (bs.status_id = 1) DESC,   -- the ACTIVE row wins over a newer PENDING parked (downgrade) row
           bs.created_at DESC
  LIMIT 1;
$$;
