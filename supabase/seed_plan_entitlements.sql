-- Per-plan entitlement values → subscription_plans.features (jsonb). The code
-- registry (src/constants/entitlements.js) defines the KEYS + fallbacks; these are
-- the VALUES the resolver reads. Idempotent (plain UPDATE by stable plan name).
-- null on an int key = unlimited. Keep in sync with the registry + marketing pricing.
-- See docs (spattoo-core) SUBSCRIPTION_TIERS.md for the rationale behind each value.
--
-- 2026-06-30 reshape (tiering Wave 1):
--   * storefront + custom_branding ON for ALL tiers (Spark = full creative+storefront explore;
--     fixes Spark onboarding hiding store-setup/brand-colors).
--   * max_orders_total = null for ALL — Spark gated by the 30-day TRIAL window, NOT an order count.
--   * whatsapp_notifications OFF all tiers (#20 deferred).
--   * max_saved_templates NEW: Spark 3 / Flame 30 / Blaze+ unlimited (custom saved templates only).
--   * max_team_members: 1 / 2 / 4 / 10 (anti-resale cap; no "unlimited", per-seat overage later).
--   * custom_templates is DEPRECATED (superseded by max_saved_templates) — left for now, inert.
--
-- 2026-07-29 (AI credits):
--   * ai_credits_per_month NEW: Spark 200 / Flame 200 / Blaze 800 / Forge 2000. The monthly
--     allowance for metered smart tools (#13) + X-Ray on photo-only orders. Sized from WORST-CASE
--     spend, not typical usage — it is a cost CEILING first and an upgrade lever second, and it is
--     the only line in this file with real marginal cost behind it.
--   * Spark deliberately equals Flame, and must STAY low even if the pending "trial = Blaze for 30
--     days" decision lands (SUBSCRIPTION_TIERS.md). "Trial = Blaze" should mean Blaze's FEATURES;
--     granting Blaze's AI allowance to every trialist is the one way a trial can cost real money.
--   * Values are seed data, tuned from the margin dashboard, never a code constant. Numbers stay
--     generous through beta (failed generations are not charged) and tighten at GA.

-- trial_days = Spark trial length (plan CONFIG, not an entitlement — the resolver ignores it).
-- Read by both Spark-grant paths (provisioning + activate-spark). Spark is ONE-TIME + time-boxed
-- (never permanent); after it expires the baker sees the upgrade screen and customers can't quote.
update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', false,
  'ai_background_removal', false, 'whatsapp_notifications', false, 'xray_reports', false,
  'max_orders_total', null, 'max_team_members', 1, 'max_saved_templates', 3,
  'ai_credits_per_month', 200,
  'trial_days', 30
) where name = 'spark';

update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', false,
  'ai_background_removal', false, 'whatsapp_notifications', false, 'xray_reports', false,
  'max_orders_total', null, 'max_team_members', 2, 'max_saved_templates', 30,
  'ai_credits_per_month', 200
) where name = 'flame';

update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', true,
  'ai_background_removal', true, 'whatsapp_notifications', false, 'xray_reports', true,
  'max_orders_total', null, 'max_team_members', 4, 'max_saved_templates', null,
  'ai_credits_per_month', 800
) where name = 'blaze';

update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', true,
  'ai_background_removal', true, 'whatsapp_notifications', false, 'xray_reports', true,
  'max_orders_total', null, 'max_team_members', 10, 'max_saved_templates', null,
  'ai_credits_per_month', 2000
) where name = 'forge';
