-- ── baker_subscriptions: period boundaries as INSTANTS + cancellation audit ──────
-- Run once in the Supabase SQL editor (dev). Safe to re-run (IF NOT EXISTS / DROP+CREATE).
--
-- WHY: end_date/start_date are `date` columns, but a billing-cycle boundary is really an
-- INSTANT (Razorpay `current_start`/`current_end`). Deriving the date via a UTC truncation
-- (`new Date(current_end*1000).toISOString().slice(0,10)`) drops the baker's timezone offset
-- and lands a day early for non-UTC bakers (the Aug 2 → Aug 1 slip). Model the boundary as a
-- timestamptz and compare instants, which is timezone-correct by construction and also avoids
-- the CURRENT_DATE-in-UTC midnight edge.
--
-- This migration is ADDITIVE and BACKWARD-COMPATIBLE:
--   • The three new columns are nullable with no backfill. Existing rows keep the exact
--     current behaviour because derived_status falls back to the old end_date rule whenever
--     current_period_end IS NULL.
--   • current_period_end gets populated precisely later: a one-time Razorpay backfill for
--     existing active subs, and `subscription.charged` webhook stamping for new ones.
--   • Row selection is unchanged (most-recent). Coverage-based selection (for the resubscribe
--     grace overlap) is intentionally deferred to the resubscribe phase — no overlapping rows
--     can exist yet, so adding it now would be risk without benefit.

-- ── 1. New columns ───────────────────────────────────────────────────────────────
-- current_period_start / current_period_end: Razorpay current_start / current_end as UTC
-- instants. current_period_end is the AUTHORITATIVE paid-through boundary for access.
ALTER TABLE baker_subscriptions ADD COLUMN IF NOT EXISTS current_period_start      timestamptz;
ALTER TABLE baker_subscriptions ADD COLUMN IF NOT EXISTS current_period_end        timestamptz;
-- cancellation_requested_at: when the baker requested cancellation (NULL = not requested).
-- Set on POST /billing/cancel alongside the immediate Razorpay cancel. Audit + confirmation
-- that the cancel was actually issued; distinct from cancel_at_period_end (the "won't renew"
-- display flag) and from the eventual status_id=6 relabel at period end.
ALTER TABLE baker_subscriptions ADD COLUMN IF NOT EXISTS cancellation_requested_at timestamptz;

-- Index the access hot-path: "rows for this baker whose paid-through boundary is in the
-- future" and the daily reconcile sweep ("active rows whose boundary has passed").
CREATE INDEX IF NOT EXISTS baker_subscriptions_current_period_end_idx
  ON baker_subscriptions(current_period_end);

-- ── 2. get_baker_subscription — instant-first derived_status, date fallback ────────
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
  cancellation_requested_at timestamptz
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
    -- Access boundary: prefer the instant (timezone-correct); fall back to the legacy
    -- date rule while current_period_end is not yet populated (un-backfilled rows).
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
    bs.cancellation_requested_at
  FROM baker_subscriptions bs
  LEFT JOIN subscription_plans sp ON sp.id = bs.plan_id
  LEFT JOIN billing_periods    bp ON bp.id = bs.billing_period_id
  WHERE bs.baker_id = p_baker_id
  ORDER BY bs.created_at DESC
  LIMIT 1;
$$;

-- ── 3. get_baker_subscriptions_admin — same instant-first rule + expose boundary ───
DROP FUNCTION IF EXISTS get_baker_subscriptions_admin();
CREATE FUNCTION get_baker_subscriptions_admin()
RETURNS TABLE (
  baker_id                  uuid,
  baker_name                text,
  plan_name                 text,
  period_name               text,
  status                    text,
  derived_status            text,
  end_date                  date,
  start_date                date,
  current_period_end        timestamptz,
  cancel_at_period_end      boolean,
  cancellation_requested_at timestamptz
)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (b.id)
    b.id            AS baker_id,
    b.name          AS baker_name,
    sp.name         AS plan_name,
    bp.name         AS period_name,
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
    bs.end_date,
    bs.start_date,
    bs.current_period_end,
    bs.cancel_at_period_end,
    bs.cancellation_requested_at
  FROM bakers b
  LEFT JOIN baker_subscriptions bs ON bs.baker_id = b.id
  LEFT JOIN subscription_plans  sp ON sp.id = bs.plan_id
  LEFT JOIN billing_periods     bp ON bp.id = bs.billing_period_id
  ORDER BY b.id, bs.created_at DESC;
$$;

-- PostgREST caches the schema; force a reload so the new columns + RPC shapes are served.
NOTIFY pgrst, 'reload schema';
