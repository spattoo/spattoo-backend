-- ── cancellation_reasons master table + reason/note on baker_subscriptions ────────
-- Run once in the Supabase SQL editor (dev). Safe to re-run (IF NOT EXISTS / ON CONFLICT / DROP+CREATE).
--
-- Master data (admin-authorable, like subscription_plans / billing_periods): why a subscription
-- was cancelled. ONE table holds BOTH system-attributed reasons (upgrade / downgrade / external /
-- completed / the customer_requested fallback — is_customer_selectable=false) AND the customer
-- churn-survey options (is_customer_selectable=true, shown in the cancel dialog). baker_subscriptions
-- references it by a compact smallint surrogate FK (scale rule — the hot table stores the id, not the
-- text key); the readable `key` is translated at the API boundary via the RPC join.

CREATE TABLE IF NOT EXISTS cancellation_reasons (
  id                     smallint PRIMARY KEY,          -- explicit, stable ids (mirrors status_id)
  key                    text NOT NULL UNIQUE,          -- machine key: 'upgrade','too_expensive',…
  display_name           text NOT NULL,
  is_customer_selectable boolean NOT NULL DEFAULT false,-- appears in the churn survey
  is_active              boolean NOT NULL DEFAULT true,
  sort_order             int NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- ids: 1–5 system-attributed (not customer-selectable), 10+ customer-facing survey options.
INSERT INTO cancellation_reasons (id, key, display_name, is_customer_selectable, sort_order) VALUES
  ( 1, 'upgrade',            'Upgraded plan',                false,  0),
  ( 2, 'downgrade',          'Downgraded plan',              false,  1),
  ( 3, 'admin_external',     'Cancelled by support',         false,  2),
  ( 4, 'completed',          'Term completed',               false,  3),
  ( 5, 'customer_requested', 'Cancelled (no reason given)',  false,  4),
  (10, 'too_expensive',      'Too expensive',                true,  10),
  (11, 'not_using',          'Not using it enough',          true,  11),
  (12, 'missing_features',   'Missing features I need',      true,  12),
  (13, 'switching',          'Switching to another tool',    true,  13),
  (14, 'other',              'Other',                        true,  14)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE baker_subscriptions
  ADD COLUMN IF NOT EXISTS cancellation_reason_id smallint REFERENCES cancellation_reasons(id),
  ADD COLUMN IF NOT EXISTS cancellation_note      text;

-- ── Re-expose cancellation_reason (key, translated) + note in the RPCs ────────────
-- (Extends the shape from baker_subscriptions_period_instants.sql; additive/backward-compatible.)
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
  cancellation_note         text
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
    bs.cancellation_note
  FROM baker_subscriptions bs
  LEFT JOIN subscription_plans   sp ON sp.id = bs.plan_id
  LEFT JOIN billing_periods      bp ON bp.id = bs.billing_period_id
  LEFT JOIN cancellation_reasons cr ON cr.id = bs.cancellation_reason_id
  WHERE bs.baker_id = p_baker_id
  ORDER BY bs.created_at DESC
  LIMIT 1;
$$;

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
  cancellation_requested_at timestamptz,
  cancellation_reason       text,
  cancellation_note         text
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
    bs.cancellation_requested_at,
    cr.key          AS cancellation_reason,
    bs.cancellation_note
  FROM bakers b
  LEFT JOIN baker_subscriptions  bs ON bs.baker_id = b.id
  LEFT JOIN subscription_plans   sp ON sp.id = bs.plan_id
  LEFT JOIN billing_periods      bp ON bp.id = bs.billing_period_id
  LEFT JOIN cancellation_reasons cr ON cr.id = bs.cancellation_reason_id
  ORDER BY b.id, bs.created_at DESC;
$$;

NOTIFY pgrst, 'reload schema';
