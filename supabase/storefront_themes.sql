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
  -- when a storefront is rendered. Added by migration 052 for databases that already have
  -- this table — a CREATE TABLE IF NOT EXISTS cannot add a column to an existing one.
  is_premium  boolean     NOT NULL DEFAULT false,
  sort_order  smallint    NOT NULL DEFAULT 0
);

INSERT INTO storefront_themes (id, key, name, description, is_active, sort_order) VALUES
  (1, 'spotlight',  'Spotlight',  'A dramatic dark hero with a spotlit, rotating 3D cake. Bold and modern.', true,  1),
  (2, 'patisserie', 'Patisserie', 'A light, elegant editorial layout that lets your cakes lead.',           false, 2),
  (3, 'aurora',     'Aurora',     'Soft, airy and colourful — a bright, welcoming storefront.',              false, 3)
-- is_premium is deliberately NOT in the DO UPDATE list: re-running this file must not reset
-- a flag set later. The three rows above are all basic, and that is the decision — premium
-- starts with themes added from here on.
ON CONFLICT (id) DO UPDATE
  SET key = EXCLUDED.key, name = EXCLUDED.name, description = EXCLUDED.description,
      is_active = EXCLUDED.is_active, sort_order = EXCLUDED.sort_order;

-- bakers reference a theme by id (default Spotlight). Replaces any earlier text column.
ALTER TABLE bakers DROP COLUMN IF EXISTS storefront_theme;
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS storefront_theme_id smallint NOT NULL DEFAULT 1
  REFERENCES storefront_themes(id);
