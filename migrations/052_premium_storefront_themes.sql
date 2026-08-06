-- ── 052: premium storefront themes ──────────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/features/storefront-access-control.md
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- Themes are the next tier lever: Blaze and above get premium ones, Flame and the trial
-- get the basic set. Today nothing can express that. storefront_themes has is_active and
-- nothing else, PATCH /api/baker/profile validates only `is_active`, and there is no
-- entitlement key — so every baker on every plan sees the same list.
--
-- This adds the two halves that make the split real: a flag on the THEME and a key on the
-- PLAN. Neither is a claim on the pricing page until both are enforced, which is the rule
-- spattoo-web's Pricing.tsx opens with and the one team seats broke.
--
-- ── EVERY EXISTING THEME STAYS BASIC ────────────────────────────────────────────────
-- is_premium defaults FALSE and the three current rows keep it. Spotlight, Patisserie and
-- Aurora are available to every plan exactly as before, and no baker loses a theme they
-- already chose. Premium starts with themes built from here on — an explicit decision, not
-- an accident of the default.
--
-- That also means this migration changes NOTHING a baker can see on the day it runs. It is
-- the capability, ready for the first premium theme to be inserted with is_premium = true.
--
-- ⚠️ A baker who already sits on a theme that LATER becomes premium keeps rendering it —
-- the flag is checked when a theme is CHOSEN, not when a storefront is served. Downgrading
-- somebody's live shop because we re-priced a theme would be taking away what they already
-- published. If that is ever wanted it needs its own decision and its own migration.
--
-- ── WHY A FLAG AND NOT A MINIMUM PLAN ───────────────────────────────────────────────
-- `min_plan_id` on the theme would put pricing in the themes table and hard-code the tier
-- ladder into data that has nothing to do with billing — rename a plan and the join breaks.
-- A boolean on the theme says WHAT KIND of thing it is; the plan's `premium_themes` key says
-- who may have that kind. The resolver already reads plan features, so the ladder stays in
-- one place and a plan can be renamed or re-ranked without touching a theme.
--
-- ── ⚠️ TWO FILES, AGAIN ─────────────────────────────────────────────────────────────
-- supabase/storefront_themes.sql creates the table for a fresh environment and is a
-- CREATE TABLE IF NOT EXISTS, so it will NOT add a column to a database that already has
-- the table — this migration is what moves an existing one. Both are updated in this change:
-- the column is in the CREATE for new installs, here for old ones.
--
-- Its INSERT ... ON CONFLICT DO UPDATE names its columns explicitly and does not mention
-- is_premium, so re-running the seed cannot reset a flag set later. That was checked, not
-- assumed — the same wholesale-overwrite trap that seed_plan_entitlements.sql has.

BEGIN;

-- ── The theme half ───────────────────────────────────────────────────────────────────
ALTER TABLE public.storefront_themes
  ADD COLUMN IF NOT EXISTS is_premium boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.storefront_themes.is_premium IS
  'Whether this theme needs the `premium_themes` entitlement (Blaze+). false = available on every plan. Checked when a baker CHOOSES a theme, never when a storefront is rendered — a shop already published on a theme keeps rendering it if the theme is later re-priced.';

-- ── The plan half ────────────────────────────────────────────────────────────────────
-- Merge (`||`), not jsonb_build_object: a migration must not assume it knows every key a
-- plan row already carries. Spark and Flame are written explicitly false rather than left
-- absent — an absent key reads as "nobody has decided yet", which is the state that left
-- the Edible Print Studio locked for everyone (see 050).
update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('premium_themes', true)
 where name in ('blaze', 'forge');

update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('premium_themes', false)
 where name in ('spark', 'flame');

COMMIT;

-- Verify — every theme basic for now, and the plan ladder set:
--   select id, key, is_active, is_premium from storefront_themes order by sort_order;
--   select name, features -> 'premium_themes' as premium from subscription_plans order by sort_order;
