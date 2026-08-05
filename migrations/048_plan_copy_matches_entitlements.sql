-- ── 048: the plan picker's copy matches what the plans actually grant ───────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/features/subscription-billing.md
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- subscription_plans holds the DISPLAY copy (tagline, feature_bullets, has_storefront)
-- and plan_entitlements holds what a plan actually GRANTS. They are different tables,
-- nothing ties them together, and they had drifted badly:
--
--   spark  "10 total orders"        →  max_orders_total is null (the 30-day window gates it)
--          "1 team member"          →  max_team_members 2
--          "Design canvas"          →  storefront + designer, both on
--          has_storefront false     →  storefront true on EVERY tier
--   flame  "Public storefront"      →  not a differentiator; Spark has it
--          "Everything in Spark"    →  Flame IS Spark plus 100 credits
--   blaze  "Custom templates"       →  custom_templates true on every tier
--          "Custom branding"        →  custom_branding true on every tier
--          "5 team members"         →  max_team_members 4   ⚠ SELLS ONE MORE THAN IT GRANTS
--   forge  "Unlimited team members" →  max_team_members 10  ⚠ SELLS UNLIMITED, GRANTS TEN
--
-- The last two are the ones that matter. A Blaze baker adding a fifth seat is refused by
-- the entitlement, having been sold five on the screen where they chose the plan. That is
-- not stale copy, it is a promise the product breaks.
--
-- ── WHAT THE LADDER ACTUALLY IS NOW ─────────────────────────────────────────────────
-- Every tier has the storefront, the designer, custom branding, custom templates, X-Ray,
-- flavour suggestions and unlimited orders. What differs:
--
--   spark   200 credits · 2 seats · 30 saved templates · 30 DAYS, then it lapses
--   flame   300 credits · 2 seats · 30 saved templates · no time limit
--   blaze   800 credits · 4 seats · unlimited saved templates · can buy top-ups · priority chat
--   forge  2000 credits · 10 seats · unlimited saved templates · can buy top-ups · account manager
--
-- So the ladder is CREDITS, SEATS and SUPPORT. The copy now says that, instead of listing
-- features every tier has had since storefront and custom_templates were opened up.
--
-- ── THE FALLBACK IN routes/subscriptions.js ─────────────────────────────────────────
-- GET /plans has a pre-014 fallback that hardcodes `has_storefront: p.name !== 'spark'`.
-- That is fixed in the same change — it would have re-introduced the wrong value on any
-- deploy where the marketing columns were missing.

BEGIN;

UPDATE public.subscription_plans SET
  has_storefront  = true,
  tagline         = 'Everything, free for 30 days',
  feature_bullets = to_jsonb(ARRAY[
    'Your storefront + 3D designer',
    'Unlimited orders and quotes',
    'Flavour suggestions for your customers',
    '200 smart-tool credits',
    '30 days — then choose a plan'
  ])
WHERE name = 'spark';

UPDATE public.subscription_plans SET
  has_storefront  = true,
  tagline         = 'Less than the price of one cake',
  feature_bullets = to_jsonb(ARRAY[
    'Everything in Spark, with no time limit',
    '300 smart-tool credits a month',
    '2 team members',
    'Email support'
  ])
WHERE name = 'flame';

UPDATE public.subscription_plans SET
  has_storefront  = true,
  tagline         = 'More credits, more seats, faster help',
  feature_bullets = to_jsonb(ARRAY[
    'Everything in Flame',
    '800 smart-tool credits a month',
    'Buy extra credits when you need them',
    '4 team members',
    'Unlimited saved templates',
    'Priority chat support'
  ])
WHERE name = 'blaze';

UPDATE public.subscription_plans SET
  has_storefront  = true,
  tagline         = 'The most credits and the biggest team',
  feature_bullets = to_jsonb(ARRAY[
    'Everything in Blaze',
    '2,000 smart-tool credits a month',
    '10 team members',
    'Dedicated account manager'
  ])
WHERE name = 'forge';

COMMIT;
