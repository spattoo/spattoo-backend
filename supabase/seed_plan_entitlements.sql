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
--   * ai_credits_per_month NEW (resized 2026-07-31, see below). The monthly
--     allowance for metered smart tools (#13) + X-Ray on photo-only orders. Sized from WORST-CASE
--     spend, not typical usage — it is a cost CEILING first and an upgrade lever second, and it is
--     the only line in this file with real marginal cost behind it.
--   * Spark deliberately equals Flame, and must STAY low even if the pending "trial = Blaze for 30
--     days" decision lands (SUBSCRIPTION_TIERS.md). "Trial = Blaze" should mean Blaze's FEATURES;
--     granting Blaze's AI allowance to every trialist is the one way a trial can cost real money.
--   * Values are seed data, tuned from the margin dashboard, never a code constant. Numbers stay
--     generous through beta (failed generations are not charged) and tighten at GA.
--
-- 2026-08-02 (X-Ray opens to every tier; CREDITS are the only lever on it):
--   * xray_reports false → TRUE on spark and flame. X-Ray is now available on every plan, for both
--     kinds of order, and the difference between tiers is the AI ALLOWANCE alone.
--   * Why: the split was defensible but unexplainable. A photo X-Ray calls the model and is paid
--     for with credits on any plan; a designed-cake one costs us nothing and was a Blaze hook. On a
--     pricing page that reads as "X-Ray: from photos / + your 3D designs", which no baker parses —
--     and in the product it means a Flame baker can pay credits for the HARDER reading and then be
--     refused the free one on their own design. That is backwards.
--   * Cost: none. A designed cake's X-Ray is generated from the design we already hold; no model
--     call, no marginal rupee. This gives away nothing but a differentiator.
--   * What it costs us commercially: Blaze loses a named hook (SUBSCRIPTION_TIERS #16 called it
--     "the strongest hook"). Blaze now differentiates on custom templates, background removal,
--     unlimited saved templates, top-ups, and 800 vs 300 credits. Watch whether that is enough.
--   * The `xray_reports` KEY stays, and the gate in OrdersPanel.jsx stays with it — this is a DATA
--     change, reversible without a deploy, which is the whole reason entitlements are data.
--
-- 2026-08-02 (trial = FLAME for 30 days — decided; SUBSCRIPTION_TIERS.md "PENDING SIGN-OFF"):
--   * Spark's FEATURES now equal Flame's: max_team_members 1 → 2, max_saved_templates 3 → 30.
--     The trial has to equal ONE tier or the pricing card cannot be written — "everything in Flame
--     except three things you have not heard of yet" is not a sentence anyone can put on a card.
--     Both raised values have NO marginal cost, which is why they move and the credits do not.
--   * ai_credits_per_month STAYS 100. The principle the Blaze option was going to be held to
--     applies just as well here: the trial grants the tier's FEATURES, not its AI allowance, because
--     that allowance is the only line in this file with real money behind it and Spark is the only
--     unpaid segment. A trialist gets a starter allowance, and the marketing copy says exactly that
--     rather than implying Flame's 300.
--   * Consequence worth knowing: credits go UP on converting (100 → 300), so the one metered thing
--     a trialist might run low on gets BETTER when they pay. That is the right direction.
--
-- 2026-07-31 (sized against the segments, not guessed):
--   * Flame 200 → 300. Flame is 10–30 orders/month. At 15 credits a build guide, 200 buys 13 — and
--     a 30-order baker at a ~60% photo mix needs 18. The wall was landing on the top third of the
--     band, i.e. on ordinary use. It must read as "you have outgrown this plan", not "you had a busy
--     fortnight", or the Blaze lever becomes a grievance. 300 covers 30 orders (270 = the 90% nudge)
--     and the wall now fires around 40 — genuinely past Flame.
--     Cost of the raise: 300 credits fully burned on the THINNEST-margin action is ~₹70, 7% of ₹999.
--   * Spark 200 → 100. A trial is <10 orders; ~6 guides is plenty to feel the feature. It is also
--     the only unpaid segment, and the calendar-month meter already hands every 30-day trial two
--     allowances (a trial always straddles a month boundary), so 100 is really ~200 in practice.
--   * Blaze 800 / Forge 2000 unchanged — 45 orders at a 60% photo mix is ~405 credits, so Blaze
--     sits near 50% utilisation with real headroom for the actions still to be built.
--   * The photo-mix fraction driving all of this is an ESTIMATE. It is directly measurable once
--     there is usage (manual vs designed orders per baker); revisit on that, not on this model.

-- trial_days = Spark trial length (plan CONFIG, not an entitlement — the resolver ignores it).
-- Read by both Spark-grant paths (provisioning + activate-spark). Spark is ONE-TIME + time-boxed
-- (never permanent); after it expires the baker sees the upgrade screen and customers can't quote.
update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', false,
  'ai_background_removal', false, 'whatsapp_notifications', false, 'xray_reports', true,
  'max_orders_total', null, 'max_team_members', 2, 'max_saved_templates', 30,
  'ai_credits_per_month', 100, 'can_buy_credits', false,
  'trial_days', 30
) where name = 'spark';

update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', false,
  'ai_background_removal', false, 'whatsapp_notifications', false, 'xray_reports', true,
  'max_orders_total', null, 'max_team_members', 2, 'max_saved_templates', 30,
  'ai_credits_per_month', 300, 'can_buy_credits', false
) where name = 'flame';

update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', true,
  'ai_background_removal', true, 'whatsapp_notifications', false, 'xray_reports', true,
  'max_orders_total', null, 'max_team_members', 4, 'max_saved_templates', null,
  'ai_credits_per_month', 800, 'can_buy_credits', true
) where name = 'blaze';

update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', true,
  'ai_background_removal', true, 'whatsapp_notifications', false, 'xray_reports', true,
  'max_orders_total', null, 'max_team_members', 10, 'max_saved_templates', null,
  'ai_credits_per_month', 2000, 'can_buy_credits', true
) where name = 'forge';
