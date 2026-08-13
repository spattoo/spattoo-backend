-- ── get_baker_subscription: expose scheduled downgrade + fix current-row pick ──
-- Run once in the Supabase SQL editor. Idempotent (DROP + CREATE).
--
-- Two changes for the deferred-downgrade feature (SUBSCRIPTION_CHANGE_PLAN.md):
--
-- 1. CURRENT-ROW PICK: the old `ORDER BY created_at DESC LIMIT 1` returned the most-recently-created
--    row. A deferred downgrade parks a PENDING lower sub whose row is created LAST, so for the whole
--    downgrade window this function returned the pending lower plan instead of the still-ACTIVE higher
--    plan the baker is actually on. Fix: prefer the ACTIVE row (status_id = 1) first, then newest. This
--    is correct for every state (fresh/upgrade pending → no active row → newest pending; downgrade →
--    active higher row wins; post-promotion → new active row wins).
--
-- 2. SCHEDULED DOWNGRADE: expose scheduled_plan_id / scheduled_plan_name / scheduled_effective_at so the
--    billing screen can show "<current> until <date>, then <lower>".

DROP FUNCTION IF EXISTS get_baker_subscription(uuid);
CREATE FUNCTION get_baker_subscription(p_baker_id uuid)
RETURNS TABLE (
  id                        uuid,
  plan_id                   int,
  plan_name                 text,
  plan_display_name         text,
  period_name               text,
  period_display_name       text,
  status                    text,
  derived_status            text,
  start_date                date,
  end_date                  date,
  cancel_at_period_end      boolean,
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  cancellation_requested_at timestamptz,
  cancellation_reason       text,
  cancellation_note         text,
  scheduled_plan_id         int,
  scheduled_plan_name       text,
  scheduled_effective_at    timestamptz
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
    bs.scheduled_effective_at
  FROM baker_subscriptions bs
  LEFT JOIN subscription_plans   sp  ON sp.id  = bs.plan_id
  LEFT JOIN subscription_plans   ssp ON ssp.id = bs.scheduled_plan_id
  LEFT JOIN billing_periods      bp  ON bp.id  = bs.billing_period_id
  LEFT JOIN cancellation_reasons cr  ON cr.id  = bs.cancellation_reason_id
  WHERE bs.baker_id = p_baker_id
  ORDER BY (bs.status_id = 1) DESC,   -- the ACTIVE row wins over a newer PENDING parked (downgrade) row
           bs.created_at DESC
  LIMIT 1;
$$;
