-- ── Filming the cake assembling itself is a Blaze feature ────────────────────────────────────────
--
-- The take films every decoration flying in and landing in its own place, and saves the result as a
-- video. Asked for as Blaze-only, explicitly in contrast with how reels are priced:
--
--   "we have watermark optio for reel capture. but this one strictly for blaze."
--
-- ⚠️ NO WATERMARK RUNG, AND THAT IS THE DECISION. `reel_capture` is on for every paid tier because a
-- watermarked reel markets us each time it is posted and costs us nothing to render. This one is the
-- showpiece a baker uses to explain what the studio does, so it is what the tier is FOR rather than
-- a sample of it.
--
-- ⚠️ VALUES ONLY. The entitlement is DEFINED in src/constants/entitlements.js, which is plan-
-- agnostic on purpose; who gets it is data on the plan row, so re-pricing never needs a deploy.
BEGIN;

update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('build_film', true)
 where name in ('blaze', 'forge');

-- Written explicitly rather than left to the registry fallback: a plan row that SAYS false is a plan
-- row somebody can read, and the admin plan editor shows a value rather than a blank.
update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('build_film', false)
 where name in ('spark', 'flame');

COMMIT;
