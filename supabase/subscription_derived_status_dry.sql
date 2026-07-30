-- ── get_baker_subscription: map status_id ONCE (de-duplicate derived_status) ───
-- Run once in the Supabase SQL editor. Idempotent.
--
-- CREATE OR REPLACE (no DROP): the return shape is IDENTICAL to the deployed
-- 21-column version from subscription_scheduled_interval.sql, so the return type is
-- unchanged and there is no window where the function does not exist.
-- PREREQUISITE: subscription_scheduled_interval.sql must already be applied (it is —
-- verified live: scheduled_period_name present, 21 columns).
--
-- WHY — the bug this prevents recurring:
--   The status_id → name mapping existed TWICE (once for `status`, once for
--   `derived_status`) and the copies DRIFTED: derived_status enumerated only
--   1,2,3,4,6 and status_id = 5 fell through to ELSE 'unknown'. status_id 5 is set
--   solely by billing.js on `subscription.halted` (dunning retries exhausted — the
--   customer definitively failed to pay), and 'unknown' is in NEITHER access gate:
--     - api  src/constants/entitlements.js  BLOCKED_STATUSES = {expired, cancelled,
--            paused, no_subscription}
--     - core CakeDesigner.jsx:5028          ['expired','cancelled','paused']
--   → a non-paying baker kept FULL paid access indefinitely. It was latent only
--   because no baker had reached dunning-exhaustion yet.
--
--   Adding `WHEN 5` to the second copy (already done) fixes the instance and leaves
--   the next status_id free to drift the same way. This maps status_id ONCE, in the
--   CTE, and states what derived_status actually MEANS:
--
--       derived_status = status, EXCEPT an ACTIVE row past its paid-through
--                        boundary reads as 'expired'
--
--   A future status_id then flows into BOTH columns automatically.
--
-- GRACE IS PRESERVED: only status_id = 1 decays at the boundary. past_due (4) and
-- pending (2) are the dunning window — Razorpay is still retrying, so the baker keeps
-- access and must NOT be forced to 'expired'.
--
-- Row-pick semantics unchanged: WHERE / ORDER BY / LIMIT reference only
-- baker_subscriptions columns, so picking the row BEFORE the LEFT JOINs is equivalent
-- (and avoids building join rows that are then discarded).

CREATE OR REPLACE FUNCTION get_baker_subscription(p_baker_id uuid)
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
  WITH picked AS (
    SELECT
      bs.*,
      -- The ONE status_id → name mapping. Both `status` and `derived_status` read it.
      CASE bs.status_id
        WHEN 1 THEN 'active'
        WHEN 2 THEN 'pending'
        WHEN 3 THEN 'paused'
        WHEN 4 THEN 'past_due'
        WHEN 5 THEN 'expired'
        WHEN 6 THEN 'cancelled'
        ELSE 'unknown'
      END AS status_name,
      -- Paid-through boundary passed? current_period_end is the authoritative instant;
      -- end_date is the legacy date fallback for rows predating the instant columns.
      CASE
        WHEN bs.current_period_end IS NOT NULL THEN now() >= bs.current_period_end
        ELSE bs.end_date IS NOT NULL AND bs.end_date < CURRENT_DATE
      END AS boundary_passed
    FROM baker_subscriptions bs
    WHERE bs.baker_id = p_baker_id
    ORDER BY (bs.status_id = 1) DESC,   -- the ACTIVE row wins over a newer PENDING parked (downgrade) row
             bs.created_at DESC
    LIMIT 1
  )
  SELECT
    p.id,
    sp.id           AS plan_id,
    sp.name         AS plan_name,
    sp.display_name AS plan_display_name,
    bp.name         AS period_name,
    bp.display_name AS period_display_name,
    p.status_name   AS status,
    CASE
      WHEN p.status_id = 1 AND p.boundary_passed THEN 'expired'
      ELSE p.status_name
    END             AS derived_status,
    p.start_date,
    p.end_date,
    p.cancel_at_period_end,
    p.current_period_start,
    p.current_period_end,
    p.cancellation_requested_at,
    cr.key          AS cancellation_reason,
    p.cancellation_note,
    p.scheduled_plan_id,
    ssp.name        AS scheduled_plan_name,
    p.scheduled_effective_at,
    sbp.name         AS scheduled_period_name,
    sbp.display_name AS scheduled_period_display_name
  FROM picked p
  LEFT JOIN subscription_plans   sp  ON sp.id  = p.plan_id
  LEFT JOIN subscription_plans   ssp ON ssp.id = p.scheduled_plan_id
  LEFT JOIN billing_periods      bp  ON bp.id  = p.billing_period_id
  LEFT JOIN cancellation_reasons cr  ON cr.id  = p.cancellation_reason_id
  -- The parked (scheduled) sub — its billing period is the target of an interval switch.
  LEFT JOIN baker_subscriptions  ss  ON ss.billing_subscription_id = p.scheduled_subscription_id
  LEFT JOIN billing_periods      sbp ON sbp.id = ss.billing_period_id;
$$;
