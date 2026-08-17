-- ── Storefront themes (master table) ──────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- Master list of storefront THEMES (layouts/templates) a baker can pick for their
-- customer-facing page. `bakers.storefront_theme_id` references this table — adding
-- a new template is a data INSERT here, no schema change. is_active = false means
-- "coming soon" (shown in Settings, not yet selectable to render).

CREATE TABLE IF NOT EXISTS storefront_themes (
  id          smallint    PRIMARY KEY,
  key         text        NOT NULL UNIQUE,          -- stable slug the storefront renders by ('spotlight')
  name        text        NOT NULL,                 -- display name ('Spotlight')
  description text,                                  -- short blurb for the picker
  is_active   boolean     NOT NULL DEFAULT true,    -- false = coming soon
  -- Needs the `premium_themes` entitlement (Blaze+). Checked when a theme is CHOSEN, never
  -- when a storefront is rendered. Added by migration 054 for databases that already have
  -- this table — a CREATE TABLE IF NOT EXISTS cannot add a column to an existing one.
  is_premium  boolean     NOT NULL DEFAULT false,
  sort_order  smallint    NOT NULL DEFAULT 0
);

-- ⚠️ THE is_active VALUES HERE ARE LIVE-DANGEROUS. The DO UPDATE below sets is_active =
-- EXCLUDED.is_active, so whatever this list says WINS on a re-run. It used to say Patisserie and
-- Aurora were false ("coming soon") long after both went live, which meant re-running this file on
-- a real database would have switched off two shipped themes — including the only premium one.
-- They are corrected to match production. Treat this list as a statement about the live system, not
-- as the historical seed it started out as.
INSERT INTO storefront_themes (id, key, name, description, is_active, is_premium, sort_order) VALUES
  (1, 'spotlight',  'Spotlight',  'A dramatic dark hero with a spotlit, rotating 3D cake. Bold and modern.', true,  false, 1),
  (2, 'patisserie', 'Patisserie', 'A light, elegant editorial layout that lets your cakes lead.',            true,  true,  2),
  (3, 'aurora',     'Aurora',     'Soft, airy and colourful — a bright, welcoming storefront.',              true,  false, 3),
  (4, 'ink',        'Ink',        'Hand-drawn, on paper. Your name large, a drawn cake beneath it, and nothing else competing.', true, true, 4)
-- is_premium is deliberately NOT in the DO UPDATE list: re-running this file must not reset a flag
-- set later. It IS in the INSERT column list now, so a FRESH install gets Patisserie and Ink priced
-- correctly from the first row — the gap that made this file disagree with production.
ON CONFLICT (id) DO UPDATE
  SET key = EXCLUDED.key, name = EXCLUDED.name, description = EXCLUDED.description,
      is_active = EXCLUDED.is_active, sort_order = EXCLUDED.sort_order;

-- bakers reference a theme by id (default Spotlight). Replaces any earlier text column.
ALTER TABLE bakers DROP COLUMN IF EXISTS storefront_theme;
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS storefront_theme_id smallint NOT NULL DEFAULT 1
  REFERENCES storefront_themes(id);
