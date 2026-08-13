-- ── Billing tables migration ─────────────────────────────────────────────────
-- Run once in the Supabase SQL editor.
-- Safe to re-run: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS throughout.

-- ── 1. subscription_plans ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,          -- 'spark' | 'flame' | 'blaze' | 'forge'
  display_name text NOT NULL,
  price_monthly  numeric(10,2) NOT NULL DEFAULT 0,
  price_yearly   numeric(10,2) NOT NULL DEFAULT 0,
  features     jsonb NOT NULL DEFAULT '{}',
  -- Human-facing marketing catalog (billing + onboarding read these from here, one source).
  tagline         text,
  feature_bullets text[]  NOT NULL DEFAULT '{}',
  is_popular      boolean NOT NULL DEFAULT false,
  has_storefront  boolean NOT NULL DEFAULT true,
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Prices in PAISE (Razorpay subunit format): ₹999 = 99900. The UI divides by 100 to display.
INSERT INTO subscription_plans (name, display_name, price_monthly, price_yearly, sort_order, tagline, is_popular, has_storefront, feature_bullets)
VALUES
  ('spark', 'Spark',  0,       0,        0, 'Design canvas · 10 orders',           false, false, ARRAY['Design canvas','10 total orders','1 team member','Help-docs support']),
  ('flame', 'Flame',  99900,   999900,   1, 'Public storefront · unlimited orders', false, true,  ARRAY['Everything in Spark','Public storefront (yourname.spattoo.com)','Unlimited orders','2 team members','Email support']),
  ('blaze', 'Blaze',  249900,  2499900,  2, 'Custom branding & templates',          true,  true,  ARRAY['Everything in Flame','Custom templates','Custom branding','5 team members','Priority chat support']),
  ('forge', 'Forge',  499900,  4999900,  3, 'Everything · unlimited team',          false, true,  ARRAY['Everything in Blaze','Unlimited team members','Dedicated account manager'])
ON CONFLICT (name) DO NOTHING;

-- ── 2. billing_periods ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS billing_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL UNIQUE,          -- 'monthly' | 'quarterly' | 'yearly'
  display_name text NOT NULL,
  months       int NOT NULL,
  discount_pct int NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO billing_periods (name, display_name, months, discount_pct, sort_order)
VALUES
  ('monthly',   'Monthly',   1,  0,  0),
  ('quarterly', 'Quarterly', 3,  10, 1),
  ('yearly',    'Yearly',    12, 17, 2)
ON CONFLICT (name) DO NOTHING;

-- ── 3. baker_subscriptions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS baker_subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baker_id                uuid NOT NULL REFERENCES bakers(id) ON DELETE CASCADE,
  plan_id                 uuid REFERENCES subscription_plans(id),
  billing_period_id       uuid REFERENCES billing_periods(id),
  status                  text NOT NULL DEFAULT 'active',  -- active | cancelled | paused | past_due | pending
  start_date              date NOT NULL DEFAULT CURRENT_DATE,
  end_date                date,
  billing_subscription_id text,                            -- Razorpay subscription ID
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS baker_subscriptions_baker_id_idx ON baker_subscriptions(baker_id);
CREATE INDEX IF NOT EXISTS baker_subscriptions_billing_sub_id_idx ON baker_subscriptions(billing_subscription_id);

-- ── 4. subscription_events ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baker_id         uuid NOT NULL REFERENCES bakers(id) ON DELETE CASCADE,
  event            text NOT NULL,  -- trial_started | activated | upgraded | downgraded | cancelled | payment_failed | admin_override
  previous_tier    text,
  new_tier         text,
  previous_status  text,
  new_status       text,
  note             text,
  changed_by       text NOT NULL DEFAULT 'system',
  changed_by_id    uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscription_events_baker_id_idx ON subscription_events(baker_id);

-- ── 5. New columns on bakers ──────────────────────────────────────────────────
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS billing_customer_id      text;
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS billing_subscription_id  text;
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS subscription_plan_id     uuid REFERENCES subscription_plans(id);

-- ── 6. RPC: get_baker_subscription ────────────────────────────────────────────
-- Returns the most-recent subscription for a baker with derived status.
-- derived_status: if end_date is in the past and DB status is 'active' → 'expired'
CREATE OR REPLACE FUNCTION get_baker_subscription(p_baker_id uuid)
RETURNS TABLE (
  id                      uuid,
  plan_id                 uuid,
  plan_name               text,
  plan_display_name       text,
  period_name             text,
  period_display_name     text,
  status                  text,
  derived_status          text,
  start_date              date,
  end_date                date,
  billing_subscription_id text
)
LANGUAGE sql STABLE AS $$
  SELECT
    bs.id,
    sp.id           AS plan_id,
    sp.name         AS plan_name,
    sp.display_name AS plan_display_name,
    bp.name         AS period_name,
    bp.display_name AS period_display_name,
    bs.status,
    CASE
      WHEN bs.status = 'active' AND bs.end_date IS NOT NULL AND bs.end_date < CURRENT_DATE
        THEN 'expired'
      ELSE bs.status
    END             AS derived_status,
    bs.start_date,
    bs.end_date,
    bs.billing_subscription_id
  FROM baker_subscriptions bs
  LEFT JOIN subscription_plans sp ON sp.id = bs.plan_id
  LEFT JOIN billing_periods    bp ON bp.id = bs.billing_period_id
  WHERE bs.baker_id = p_baker_id
  ORDER BY bs.created_at DESC
  LIMIT 1;
$$;

-- ── 7. RPC: get_baker_subscriptions_admin ─────────────────────────────────────
CREATE OR REPLACE FUNCTION get_baker_subscriptions_admin()
RETURNS TABLE (
  baker_id         uuid,
  baker_name       text,
  plan_name        text,
  period_name      text,
  status           text,
  derived_status   text,
  end_date         date,
  start_date       date
)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (b.id)
    b.id            AS baker_id,
    b.name          AS baker_name,
    sp.name         AS plan_name,
    bp.name         AS period_name,
    bs.status,
    CASE
      WHEN bs.status = 'active' AND bs.end_date IS NOT NULL AND bs.end_date < CURRENT_DATE
        THEN 'expired'
      ELSE bs.status
    END             AS derived_status,
    bs.end_date,
    bs.start_date
  FROM bakers b
  LEFT JOIN baker_subscriptions bs ON bs.baker_id = b.id
  LEFT JOIN subscription_plans  sp ON sp.id = bs.plan_id
  LEFT JOIN billing_periods     bp ON bp.id = bs.billing_period_id
  ORDER BY b.id, bs.created_at DESC;
$$;
