-- ── 066: the Ink storefront theme ───────────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/features/storefront-access-control.md
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- A theme exists only if it has a row here. bakers.storefront_theme_id is a foreign key
-- to this table, so a template with tokens, a hero renderer and a TEMPLATES entry is
-- still unreachable without one — which is exactly the state Atelier has been in for
-- weeks: complete in code, invisible to every baker.
--
-- Ink is the drawn theme. Everything in its hero is a line drawing on paper: no
-- photograph, no render, and no rotating 3D cake. That last part is the point rather than
-- a stylistic preference — the same 3D cake appears in Spotlight, Aurora and Atelier,
-- which is most of why bakers report that the themes feel like one storefront in
-- different clothes. A theme whose picture is shared with three others is a skin.
--
-- ── PREMIUM ─────────────────────────────────────────────────────────────────────────
-- is_premium = true, so it needs the `premium_themes` entitlement (Blaze and Forge, set
-- by 054). Flame and the trial can PREVIEW it and are sent to billing when they try to
-- publish — the flag gates CHOOSING, never RENDERING.
--
-- ⚠️ Worth knowing before this ships: Patisserie, the only premium theme so far, is live
-- and chosen by ZERO bakers (22 are on Spotlight, 1 on Aurora). Ink is therefore the
-- second premium theme with no evidence yet that the first converts. That is a product
-- question — discoverability, or the preview-to-upgrade path — and not a reason to hold
-- the row, but it should be answered before a third.
--
-- ── ⚠️ TWO FILES, AGAIN ─────────────────────────────────────────────────────────────
-- supabase/storefront_themes.sql seeds a FRESH environment and is CREATE TABLE IF NOT
-- EXISTS, so it cannot add a row to a database that already has the table. This migration
-- is what moves the existing ones. Both are updated in this change, as 054 required.

BEGIN;

INSERT INTO storefront_themes (id, key, name, description, is_active, is_premium, sort_order)
VALUES (4, 'ink', 'Ink',
        'Hand-drawn, on paper. Your name large, a drawn cake beneath it, and nothing else competing.',
        true, true, 4)
-- is_active and is_premium ARE in this update list, unlike the seed file's: this migration
-- is the authority on what Ink is, and re-running it should restore that. The seed's list
-- deliberately omits is_premium so that re-seeding cannot silently un-price a theme.
ON CONFLICT (id) DO UPDATE
  SET key = EXCLUDED.key, name = EXCLUDED.name, description = EXCLUDED.description,
      is_active = EXCLUDED.is_active, is_premium = EXCLUDED.is_premium,
      sort_order = EXCLUDED.sort_order;

COMMIT;

-- Verify:
--   select id, key, name, is_active, is_premium, sort_order from storefront_themes order by sort_order;
-- Expected: spotlight(basic), patisserie(premium), aurora(basic), ink(premium).
--
-- NOT in this migration, deliberately:
--   ATELIER still has no row. It is complete in code and unreachable, and adding it here
--   would take one line — but it is also the theme judged weaker than the basic ones, so
--   shipping it is a decision about whether it is ready, not a database gap to tidy up.
