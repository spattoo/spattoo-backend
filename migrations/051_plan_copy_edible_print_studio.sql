-- ── 051: the plan picker sells the print studio, and stops selling team seats ───────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/features/subscription-billing.md
--
-- ── WHY, PART ONE: THE STUDIO IS GRANTED AND UNSOLD ─────────────────────────────────
-- 050 granted `edible_print_studio` to Blaze and Forge. The in-app plan picker reads
-- feature_bullets, which is DISPLAY COPY in a different column that nothing derives from
-- entitlements — so the gate opened and the screen where a baker chooses a plan never
-- mentioned it. That is 048's failure mode in reverse: 048 fixed copy that promised more
-- than the plans granted; this fixes a plan granting more than the copy admits.
--
-- ── WHY, PART TWO: IT SELLS SEATS THAT DO NOT EXIST ─────────────────────────────────
-- Three tiers advertise team members, and staff seats are NOT A SHIPPED FEATURE. The
-- marketing site removed them on 2026-08-02 and wrote down why:
--
--   "max_team_members exists in the entitlement registry (1/2/4/10) but nothing
--    customer-facing enforces or shows it… A 'coming soon' is a promise — cheap to print,
--    expensive to withdraw — and the numbers beside it would commit us to 2/4/10 before
--    the feature has a design."
--
-- The in-app picker was not updated in that pass, so the two surfaces disagreed: the
-- pricing page says nothing about seats and the plan picker sells them by the number. Of
-- the two, the picker is the WORSE place for it — a baker reads it at the moment they are
-- choosing what to pay for.
--
-- The taglines go with the bullets, and are the easier half to miss: "More credits, more
-- SEATS, faster help" and "The most credits and the BIGGEST TEAM" sell the same unshipped
-- thing in a line nobody thinks of as a feature list.
--
--   blaze  'More credits, more seats, faster help'   → '…more tools, faster help'
--   forge  'The most credits and the biggest team'   → '…and someone to call'
--
-- Forge's replacement leans on the account manager because that is what is actually left
-- once seats go: credits and support. Naming a real thing beats a vaguer line about scale.
--
-- ⚠️ The entitlement itself is NOT touched. max_team_members stays exactly as it is in the
-- registry and the seed. This removes a CLAIM, not a capability — when seats ship, the copy
-- comes back with values read from the seed, like every other row.
--
-- ── WHY ONLY BLAZE GETS A STUDIO BULLET ─────────────────────────────────────────────
-- forge  — its bullets say "Everything in Blaze". 048 built the copy as a LADDER where each
--          tier names the one below and lists only what it adds. A studio bullet on Forge
--          would be the first item to break that, and would imply Blaze lacks it.
-- flame  — order-level printing is on EVERY plan and is not gated by this key, so it is not
--          a differentiator. 048's rule: do not list what every tier has.
-- spark  — same, plus 050 sets it false. A trial bullet for a tool the trial cannot open
--          would be the worst version of this bug.
--
-- ── THE WORDING CARRIES THE DISTINCTION ─────────────────────────────────────────────
-- "Edible Print Studio" alone would read as though Flame has no edible printing at all,
-- which is false and would short-change a Flame baker over something they already have. The
-- bullet names what Blaze ADDS: any image, not only the photos attached to an order. Same
-- words as the marketing table ("Order photos" / "Any image"), so the two surfaces cannot be
-- read as describing different features.
--
-- ── feature_bullets IS text[] ───────────────────────────────────────────────────────
-- Not jsonb, though GET /plans serves it as a JSON array — that is PostgREST rendering a
-- Postgres array. 014 declares it `text[] NOT NULL DEFAULT '{}'`. Bare ARRAY[...], never
-- to_jsonb(); wrapping it is what 048's first draft did and it was rejected with 42804.
--
-- ── ⚠️ THIS REWRITES WHOLE ARRAYS ───────────────────────────────────────────────────
-- Idempotent, which is what a re-runnable migration needs, but it means any bullet edited by
-- hand in Admin → Plans since 048 is replaced. That editor writes feature_bullets as a
-- free-text box, so it is the one field where a migration can quietly undo a deliberate
-- change. Check before applying if the copy has been touched:
--
--   select name, feature_bullets from subscription_plans order by sort_order;
--
-- (The seed cannot collide here: seed_plan_entitlements.sql only rebuilds `features` and
-- never touches tagline or feature_bullets.)
--
-- Spark is untouched — it never listed seats and gets no studio bullet.

BEGIN;

UPDATE public.subscription_plans SET
  feature_bullets = ARRAY[
    'Everything in Spark, with no time limit',
    '300 smart-tool credits a month',
    'Email support'
  ]
WHERE name = 'flame';

UPDATE public.subscription_plans SET
  tagline         = 'More credits, more tools, faster help',
  feature_bullets = ARRAY[
    'Everything in Flame',
    '800 smart-tool credits a month',
    'Buy extra credits when you need them',
    'Unlimited saved templates',
    'Edible Print Studio — any image, not just order photos',
    'Priority chat support'
  ]
WHERE name = 'blaze';

UPDATE public.subscription_plans SET
  tagline         = 'The most credits, and someone to call',
  feature_bullets = ARRAY[
    'Everything in Blaze',
    '2,000 smart-tool credits a month',
    'Dedicated account manager'
  ]
WHERE name = 'forge';

COMMIT;

-- Verify — Blaze lists the studio, Forge inherits it via "Everything in Blaze", and NO tier
-- mentions team members or seats anywhere:
--   select name, tagline, feature_bullets from subscription_plans order by sort_order;
