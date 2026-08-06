-- ── 053: the plan picker sells premium themes ───────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/features/subscription-billing.md
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- 052 built the premium-theme gate and the marketing pricing table gained a "Storefront
-- themes: Basic / Basic + premium" row. feature_bullets is display copy in a different
-- column that nothing derives from entitlements, so without this the in-app picker would
-- not mention themes at all — the same one-surface drift that left team seats on the
-- picker for three days after the pricing page dropped them.
--
-- spattoo-docs/bin/check-plan-copy.mjs now fails the build on exactly this, so the pair
-- is enforced rather than remembered.
--
-- ── ONLY BLAZE, AS ALWAYS ───────────────────────────────────────────────────────────
-- forge  — "Everything in Blaze" carries it; 048 built this copy as a ladder.
-- flame  — basic themes are on every plan, so naming them sells a non-difference. Flame's
--          bullets say what Flame ADDS over Spark, and themes are not it.
-- spark  — same.
--
-- ── WHAT IT DOES NOT SAY ────────────────────────────────────────────────────────────
-- Not "unlock every theme", and no number. Every theme that exists today is BASIC (052),
-- so premium is currently an empty set that fills as themes are built. A count here would
-- be wrong the day it is written and wrong again every time one ships.
--
-- feature_bullets is text[] — bare ARRAY[...], never to_jsonb(); see 048.
--
-- ⚠️ Rewrites Blaze's whole array to stay re-runnable, so a bullet hand-edited in
-- Admin → Plans since 051 is replaced. Check first if the copy has been touched:
--   select name, feature_bullets from subscription_plans where name = 'blaze';

BEGIN;

UPDATE public.subscription_plans SET
  feature_bullets = ARRAY[
    'Everything in Flame',
    '800 smart-tool credits a month',
    'Buy extra credits when you need them',
    'Unlimited saved templates',
    'Premium storefront themes',
    'Edible Print Studio — any image, not just order photos',
    'Priority chat support'
  ]
WHERE name = 'blaze';

COMMIT;

-- Verify — Blaze lists premium themes, and no other tier claims them:
--   select name, feature_bullets from subscription_plans order by sort_order;
