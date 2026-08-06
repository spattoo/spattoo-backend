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
-- 2026-08-02 (custom templates open to every tier):
--   * custom_templates false → TRUE on spark and flame. The key gates NOTHING — the registry marks
--     it deprecated and inert, superseded by max_saved_templates, which is itself read by no route
--     and no component. So Flame bakers already had custom templates; the pricing page just said
--     they did not, which under-sells the plan and is indefensible the moment one of them notices.
--   * Made the DECLARATION match reality rather than deleting the key: a false value here reads as
--     a decision, and the next person to wire up gating would have implemented the wrong one.
--
-- 2026-08-05 (edible_print_studio — the key every plan was missing):
--   * The standalone Edible Print Studio shipped GATED SHUT FOR EVERYONE. The registry declares the
--     key with fallback:false and no plan row carried it, so the resolver's hasOwnProperty check
--     fell through to the fallback on all four tiers — Blaze and Forge included. The routes and the
--     menu item were both enforcing correctly against a value nobody had set.
--   * Blaze/Forge TRUE, Spark/Flame FALSE. What is gated is only the STANDALONE tool: the same
--     sheet reached from an ORDER carries no entitlement check and stays on every plan. Printing a
--     photo a customer attached is part of fulfilling an order they have already paid for. What
--     Blaze buys is printing what no order asked for — a name, a logo, a sheet of one rose — which
--     is the bakery's own productivity rather than a customer's order.
--   * Spark and Flame are written FALSE rather than left absent, for the reason this file gives
--     above about custom_templates: an absent key reads as "nobody has decided", which is the exact
--     state that caused the outage. A false value reads as a decision.
--   * ⚠️ This file rebuilds `features` with jsonb_build_object — the WHOLE object. Migration 050
--     grants the same thing with a merge; running this seed without these four lines would drop the
--     key back out and silently re-lock Blaze and Forge. Any new entitlement key needs BOTH.
--
-- 2026-08-06 (premium_themes — the next tier lever):
--   * Blaze/Forge TRUE, Spark/Flame FALSE. Gates CHOOSING a theme marked
--     storefront_themes.is_premium, never RENDERING one — a shop already published on a
--     theme keeps working if that theme is later re-priced.
--   * Every theme that exists today is BASIC, so this changes nothing a baker can see on the
--     day it runs. It is the capability, ready for the first premium theme. See migration 052.
--   * Same both-files rule as edible_print_studio: this file rebuilds `features` wholesale,
--     so a key granted only in a migration is dropped the next time the seed runs.
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
--     ⚠️ REVERSED 2026-08-05 (100 → 200) — see below.
--
-- 2026-08-05 (allowance windows follow the BILLING DATE, migration 047):
--   * Spark 100 → 200, and this is NOT a change of generosity. The allowance window is now anchored
--     to the subscription's start date rather than the calendar month, so a 30-day trial falls
--     inside ONE window instead of straddling two. The 100 above was chosen knowing the calendar
--     handed every trial a second allowance; take that away and 100 means 100. 200 reproduces what
--     a trial was already worth.
--   * It also makes the trial EVEN. Under the calendar it was worth between 100 and 200 depending
--     on the signup date — a trial starting on the 1st never reached the second allowance, and one
--     starting on the 2nd reached it for a single day. 200 now means 200 for everybody.
--   * The paid tiers are UNCHANGED. Their numbers were sized per calendar month and a window is
--     still one month long; only its start moved. What changes for them is that the first month is
--     no longer a lottery — a baker joining on the 28th used to get two allowances in four days.
--   * Blaze 800 / Forge 2000 unchanged — 45 orders at a 60% photo mix is ~405 credits, so Blaze
--     sits near 50% utilisation with real headroom for the actions still to be built.
--   * The photo-mix fraction driving all of this is an ESTIMATE. It is directly measurable once
--     there is usage (manual vs designed orders per baker); revisit on that, not on this model.

-- trial_days = Spark trial length (plan CONFIG, not an entitlement — the resolver ignores it).
-- Read by both Spark-grant paths (provisioning + activate-spark). Spark is ONE-TIME + time-boxed
-- (never permanent); after it expires the baker sees the upgrade screen and customers can't quote.
update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', true,
  'ai_background_removal', false, 'whatsapp_notifications', false, 'xray_reports', true,
  'max_orders_total', null, 'max_team_members', 2, 'max_saved_templates', 30,
  'ai_credits_per_month', 200, 'can_buy_credits', false,
  'edible_print_studio', false, 'premium_themes', false,
  'trial_days', 30
) where name = 'spark';

update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', true,
  'ai_background_removal', false, 'whatsapp_notifications', false, 'xray_reports', true,
  'max_orders_total', null, 'max_team_members', 2, 'max_saved_templates', 30,
  'ai_credits_per_month', 300, 'can_buy_credits', false,
  'edible_print_studio', false, 'premium_themes', false
) where name = 'flame';

update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', true,
  'ai_background_removal', true, 'whatsapp_notifications', false, 'xray_reports', true,
  'max_orders_total', null, 'max_team_members', 4, 'max_saved_templates', null,
  'ai_credits_per_month', 800, 'can_buy_credits', true,
  'edible_print_studio', true, 'premium_themes', true
) where name = 'blaze';

update subscription_plans set features = jsonb_build_object(
  'storefront', true, 'custom_branding', true, 'custom_templates', true,
  'ai_background_removal', true, 'whatsapp_notifications', false, 'xray_reports', true,
  'max_orders_total', null, 'max_team_members', 10, 'max_saved_templates', null,
  'ai_credits_per_month', 2000, 'can_buy_credits', true,
  'edible_print_studio', true, 'premium_themes', true
) where name = 'forge';
