-- ── 051: the plan picker sells the Edible Print Studio ──────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/features/subscription-billing.md
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- 050 granted `edible_print_studio` to Blaze and Forge. The in-app plan picker reads
-- feature_bullets, which is DISPLAY COPY in a different column that nothing derives from
-- entitlements — so the gate opened and the screen where a baker chooses a plan never
-- mentioned it. That is 048's failure mode exactly, in the other direction: 048 fixed copy
-- that promised more than the plans granted; this fixes a plan that grants more than the
-- copy admits.
--
-- The marketing site (spattoo-web Pricing.tsx) already says it. Two surfaces describing
-- the same ladder differently is how the next drift starts.
--
-- ── ONLY BLAZE CHANGES, AND THAT IS THE POINT ───────────────────────────────────────
-- forge  — its bullets say "Everything in Blaze". 048 built the copy as a LADDER where
--          each tier names the one below and lists only what it adds. A studio bullet on
--          Forge would be the first item to break that pattern, and would imply Blaze
--          lacks it. Nothing to do here is the correct outcome, not an omission.
-- flame  — order-level printing is on EVERY plan and is not gated by this key, so it is
--          not a differentiator. 048's rule: do not list what every tier has had since
--          storefront and custom_templates were opened up.
-- spark  — same, plus 050 sets it false. A trial bullet for a tool the trial cannot open
--          would be the worst version of this bug.
--
-- ── THE WORDING CARRIES THE DISTINCTION ─────────────────────────────────────────────
-- "Edible Print Studio" alone would read as though Flame has no edible printing at all,
-- which is false and would make a Flame baker feel short-changed over something they
-- already have. The bullet names what Blaze ADDS: any image, not only the photos attached
-- to an order. Same words as the marketing table ("Order photos" / "Any image") so the two
-- surfaces cannot be read as describing different features.
--
-- ── feature_bullets IS text[] ───────────────────────────────────────────────────────
-- Not jsonb, though GET /plans serves it as a JSON array — that is PostgREST rendering a
-- Postgres array. 014 declares it `text[] NOT NULL DEFAULT '{}'`. Bare ARRAY[...], never
-- to_jsonb(); wrapping it is what 048's first draft did and it was rejected with 42804.
--
-- ── ⚠️ THIS REWRITES BLAZE'S WHOLE ARRAY ────────────────────────────────────────────
-- Idempotent, which is what a re-runnable migration needs, but it means any bullet edited
-- by hand in Admin → Plans since 048 is replaced by the list below. That editor writes
-- feature_bullets as a free-text box, so it is the one field where a migration can quietly
-- undo somebody's deliberate change. Check the current value before applying if the copy
-- has been touched:
--
--   select name, feature_bullets from subscription_plans where name = 'blaze';
--
-- (The seed, by contrast, cannot collide here: seed_plan_entitlements.sql only rebuilds
-- `features` and never touches tagline or feature_bullets.)

BEGIN;

UPDATE public.subscription_plans SET
  feature_bullets = ARRAY[
    'Everything in Flame',
    '800 smart-tool credits a month',
    'Buy extra credits when you need them',
    '4 team members',
    'Unlimited saved templates',
    'Edible Print Studio — any image, not just order photos',
    'Priority chat support'
  ]
WHERE name = 'blaze';

COMMIT;

-- Verify — Blaze should list the studio, Forge should not (it inherits via "Everything in
-- Blaze"), and neither Spark nor Flame should mention it:
--   select name, feature_bullets from subscription_plans order by sort_order;
