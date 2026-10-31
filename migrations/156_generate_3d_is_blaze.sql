-- ── 156: generating a 3D decoration is a Blaze feature ───────────────────────────────────────────
--
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Sandeep: *"generating the 3d elements is allowed from blaze and above subscription only."*
--
-- "Above" is forge, which 058 hides from the picker but which still exists and still outranks
-- blaze. Named explicitly rather than derived from sort_order, so re-ordering the tiers cannot
-- silently change who may spend our vendor budget.
--
-- ⚠️ THIS FLAG IS COST CONTROL, NOT PACKAGING, WHICH MAKES IT UNLIKE ITS NEIGHBOURS. build_film
-- (135) and reel_capture are free for us to honour — they render on the baker's own GPU and we pay
-- nothing per use, which is why reel_capture is given to every paid tier. A generation spends real
-- money at a vendor the moment the button is pressed, and there is no meter underneath it:
-- src/routes/ai3d.js does not import services/aiCredits.js, and AI_ACTION has no 3D key, so nothing
-- reserves, counts or refuses a single run. Until that exists, this row IS the limit.
--
-- ⚠️ VALUES ONLY. The entitlement is DEFINED in src/constants/entitlements.js, which is plan-
-- agnostic on purpose; who gets it is data on the plan row, so re-pricing never needs a deploy.
-- The rule that reads it is src/lib/generate3d.js, held by `npm run check:generate-3d`.
BEGIN;

update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('generate_3d_decorations', true)
 where name in ('blaze', 'forge');

-- Written explicitly rather than left to the registry fallback: a plan row that SAYS false is a plan
-- row somebody can read, and the admin plan editor shows a value rather than a blank. The fallback
-- is false either way, so this changes nothing about who may generate — it changes what a person
-- looking at the row can tell.
update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('generate_3d_decorations', false)
 where name in ('spark', 'flame');

COMMIT;

-- ⚠️ NO feature_bullets CHANGE HERE, AND THAT IS A DECISION NOT AN OMISSION. Selling this on the
-- plan page means the same claim has to appear in spattoo-web/apps/marketing/components/Pricing.tsx
-- or `check:plan-copy` fails — the two surfaces agreeing to say nothing is consistent, the two
-- disagreeing is the drift that gate exists to catch. The feature is not baker-facing yet (every
-- ai3d route sits behind requireAdmin), so there is nothing to sell. Add both together, later.
