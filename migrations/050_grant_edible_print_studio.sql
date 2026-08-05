-- ── 050: open the Edible Print Studio gate on Blaze and Forge ───────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/features/ (print sheets), spattoo-web apps/marketing/components/Pricing.tsx
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────────────────
-- The standalone studio shipped GATED SHUT FOR EVERYONE, which is not a state anybody chose.
--
-- `edible_print_studio` was added to the entitlement registry with `fallback: false`, and the
-- resolver reads a plan's value with hasOwnProperty:
--
--     const raw = hasOwnProperty(features, key) ? features[key] : def.fallback;
--
-- No plan row carried the key, so every tier — Blaze and Forge included — resolved FALSE. The
-- routes in src/routes/printSheets.js all sit behind requireEntitlement('edible_print_studio') and
-- the Chef's Desk menu item is hidden unless the client sees it true, so the feature was built,
-- enforced, and reachable by nobody.
--
-- That is the correct failure direction — a missing key locks rather than unlocks — but it is still
-- a feature paying customers cannot see.
--
-- ── WHAT IS AND IS NOT BEING GRANTED ────────────────────────────────────────────────────────────
-- Only the STANDALONE studio. The same sheet reached from an ORDER is not gated by this key and
-- stays on every plan, deliberately: printing a photo a customer attached is part of fulfilling an
-- order they have already paid for, and withdrawing it would take away work in progress.
--
-- What Blaze buys is printing things NO order asked for — a name, a logo, a sheet of the same rose
-- to cut out. That is the bakery's own productivity, which is a fair thing to sell. Somebody else's
-- paid order is not.
--
-- ── WHY spark AND flame ARE WRITTEN EXPLICITLY FALSE ────────────────────────────────────────────
-- They would resolve false by fallback anyway, so this looks redundant. It is not:
--
--   * The admin plan editor is registry-driven and renders a form from the plan's features. A key
--     that is ABSENT and a key that is FALSE look the same to the resolver and different to a human
--     reading the row — absent reads as "nobody has decided yet", which is exactly the state that
--     caused this migration.
--   * It makes the seed and the plan rows the same shape, so a diff between them is a real
--     disagreement rather than noise.
--
-- ── ⚠️ THE SEED MUST CARRY IT TOO ───────────────────────────────────────────────────────────────
-- supabase/seed_plan_entitlements.sql rebuilds `features` with jsonb_build_object — the WHOLE
-- object, not a merge. Running the seed after this migration would drop the key straight back out
-- and silently re-lock Blaze and Forge. The seed is updated in the same change; if you are reading
-- this because the studio vanished, check that first.
--
-- Merge (`||`) rather than jsonb_build_object here, for the opposite reason: a migration must not
-- assume it knows every key a plan row currently has.

BEGIN;

update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('edible_print_studio', true)
 where name in ('blaze', 'forge');

update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('edible_print_studio', false)
 where name in ('spark', 'flame');

COMMIT;

-- Verify — expect blaze/forge true, spark/flame false, and no plan missing the key:
--   select name, features -> 'edible_print_studio' as studio from subscription_plans order by name;
