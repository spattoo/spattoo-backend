-- ── 058: Forge leaves the in-app plan picker ────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-web apps/marketing/components/Pricing.tsx (the Forge column)
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- The marketing pricing page stopped quoting a price for Forge: once team seats came off
-- the table it differed from Blaze by credits and the words "Account manager", which is
-- not a tier — it is Blaze with a bigger number. It now says "Let's talk".
--
-- The in-app picker reads the same plans table and went on quoting ₹4,999, so the two
-- surfaces disagreed the moment that shipped. This closes it at the source rather than by
-- editing copy in two places: the plan stops being SELF-SERVE. A bakery that needs more
-- than Blaze gets a conversation, and a conversation does not start with a card in a list.
--
-- ── WHY is_active AND NOT A DELETION ────────────────────────────────────────────────
-- GET /plans — the picker, in billing AND in signup — is the only reader that filters on
-- `is_active`, so this one flag is the whole change. The row stays because:
--
--   * baker_subscriptions references it. Deleting a plan somebody is on is not a pricing
--     decision, it is data loss.
--   * getEntitlements resolves features by plan ID and does NOT filter on is_active
--     (services/entitlements.js → getPlanFeatures), so anyone already on Forge keeps
--     exactly what they had. Verified, not assumed.
--   * Admin → Plans lists every plan regardless (routes/subscriptions.js selects `*` with
--     no filter) and shows an Active/Inactive pill, so it stays visible and reversible
--     without another migration.
--
-- Re-running supabase/billing_tables.sql cannot undo this: its INSERT ends in
-- ON CONFLICT (name) DO NOTHING, so it never touches a row that already exists.
--
-- ── ⚠️ CHECK THIS BEFORE APPLYING ───────────────────────────────────────────────────
-- If any baker is CURRENTLY on Forge, their billing panel misreads afterwards. It builds
-- `planByName` from GET /plans, and rankOf() falls back to 0 for a plan that is not in
-- that list:
--
--     const rankOf = name => planByName[name]?.sort_order ?? 0;
--
-- so a Forge baker ranks BELOW Spark, and every other plan starts looking like an upgrade
-- — including the ones that are downgrades. Their entitlements are untouched; it is the
-- comparison that breaks.
--
--     select b.name, s.status
--       from baker_subscriptions s
--       join subscription_plans p on p.id = s.plan_id
--       join bakers b on b.id = s.baker_id
--      where p.name = 'forge' and s.status in ('active', 'trialing', 'past_due');
--
-- Expect zero rows. If it is not zero, fix rankOf to fall back to the plan's own
-- sort_order (or keep inactive plans in the catalog and hide them at render) BEFORE
-- running this — otherwise a paying customer is offered a downgrade labelled as an
-- upgrade.

BEGIN;

UPDATE public.subscription_plans
   SET is_active = false
 WHERE name = 'forge';

COMMIT;

-- Verify — forge inactive, the other three untouched:
--   select name, is_active, price_monthly from subscription_plans order by sort_order;
