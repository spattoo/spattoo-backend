-- ── 120: the baker chooses what their own rail looks like ────────────────────────────────────────
--
-- A cosmetic, deliberately: the rail is the one surface a baker looks at all day and never gets to
-- own. Blaze and above, resolved the way premium storefront themes are.
--
-- ── WHY baker_appusers AND NOT bakers ───────────────────────────────────────────────────────────
-- Migration 060 already argued this for the designer tour, and the argument is the same here: "A
-- tour is a fact about a PERSON, not about a bakery." So is a rail skin. `bakers` is the shop; the
-- human is a row here, and the day seats ship two people in one bakery will want different rails.
--
-- It is also the line that keeps this from being confused with storefront_theme_id. That one is
-- per-BAKERY and CUSTOMER-FACING — it decides what a shopper sees. A customer never sees this rail.
--
-- ── WHY A TABLE AND NOT AN ENUM ─────────────────────────────────────────────────────────────────
-- Root CLAUDE.md rule 3: every value an admin would tune is seeded in code and overlaid from the
-- DB. A second skin must be a ROW, not a second branch in the renderer — the same shape
-- cake_textures and materials already have.
--
-- ⚠️ EVERY SKIN CARRIES ITS OWN INK, AND THAT IS NOT DECORATION. The rail's labels are 9px, and a
-- skin is a BACKGROUND for them. A mid-oak handle tried on 2026-10-04 looked exactly right and put
-- those labels at 2.61:1 — barely half the 4.5:1 floor for small text — while every gate stayed
-- green. Whoever adds the next row will not measure it either, so `ink` and `ink_active` live on the
-- row beside the colours they have to survive, and check:rail-skins computes the ratio for every row
-- and fails the build below the floor. The gate is the feature; the colours are the easy part.

BEGIN;

CREATE TABLE IF NOT EXISTS public.rail_skins (
  id          serial PRIMARY KEY,
  -- The key the renderer switches on. Config-driven, never type-driven (rule 2): core reaches a
  -- skin's drawing by KEY, and anything it cannot name falls back to the default.
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  -- `chrome` is the one everybody gets. Exactly one row may be the default, and it is the fallback
  -- a downgrade lands on — see lib/railSkin.js.
  is_default  boolean NOT NULL DEFAULT false,
  -- Needs the `rail_skins` entitlement (Blaze+). FALSE on the default, by definition: a skin
  -- everybody falls back to cannot be the one that is withheld.
  is_premium  boolean NOT NULL DEFAULT true,
  -- The silhouette's own gradient, top → bottom. Four stops, as CHROME_STOPS has three: a handle
  -- that changes material partway needs one more than a bar that does not.
  stops       jsonb  NOT NULL,
  -- Where the handle's material stops, as a FRACTION of the handle's length (0..1), or null for a
  -- skin that is one material all the way down. Fractional rather than pixels because the rail is
  -- drawn to its measured height and a pixel would be wrong on every other window.
  joint_at    numeric(4,3),
  -- How the upper material is DRAWN, as a key the renderer switches on — never the skin's own name
  -- (rule 2: config-driven, never type-driven). 'none' is a plain gradient; 'grain' adds the wood
  -- lines and the cylinder shading. A fourth skin wanting brushed metal is a new key here and a new
  -- branch in ONE place in core, not a condition on `key === 'walnut'` scattered through a render.
  texture     text NOT NULL DEFAULT 'none',
  -- Labels and icons at rest, and when the item is the current destination. On the row, next to the
  -- colours they sit on. See the warning above.
  ink         text NOT NULL,
  ink_active  text NOT NULL DEFAULT '#ffffff',
  sort_order  int  NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- At most one default. A partial unique index rather than a CHECK, because the rule is about the
-- TABLE and not about a row: two defaults is the state that makes the fallback ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS rail_skins_one_default_uidx
  ON public.rail_skins (is_default) WHERE is_default;

-- Server-only, like notification_channels (095) and appuser_phone_changes (119): RLS on, no
-- policies. Supabase serves `public` through PostgREST with the anon key that ships in the browser,
-- and this is master data the API hands out — not something a client writes.
ALTER TABLE public.rail_skins ENABLE ROW LEVEL SECURITY;

-- The baker's choice. NEVER nulled on downgrade: lib/railSkin.js resolves at render, so an
-- entitlement they lose takes the LOOK away and leaves the CHOICE, which comes back the moment they
-- are on Blaze again. Nulling it would make re-subscribing a support ticket.
ALTER TABLE baker_appusers ADD COLUMN IF NOT EXISTS rail_skin text;

COMMENT ON COLUMN baker_appusers.rail_skin IS
  'rail_skins.key this person chose. Resolved against the rail_skins entitlement at render '
  '(lib/railSkin.js); never cleared when a plan changes.';

-- ── The seed ────────────────────────────────────────────────────────────────────────────────────
-- Chrome is what the rail has always been — CHROME_STOPS from spattoo-core/src/shared/chrome.js,
-- whose own header says an approximation would be wrong by definition. The other two were measured
-- against the 4.5:1 floor before they were written here.
INSERT INTO public.rail_skins (key, name, is_default, is_premium, stops, joint_at, texture, ink, sort_order)
VALUES
  ('chrome', 'Chrome', true, false,
   '["#121214","#08080a","#08080a","#020203"]'::jsonb, NULL, 'none',
   'rgba(255,255,255,0.78)', 0),
  -- Dark walnut, with the handle in wood and the head left as it is. Measured 5.60:1 against its
  -- own ink at the handle's lightest point; the oak it started as measured 2.61 and was refused.
  ('walnut', 'Walnut', false, true,
   '["#3A2616","#4C321C","#3C2717","#2C1D11"]'::jsonb, 0.62, 'grain',
   'rgba(255,255,255,0.78)', 10),
  -- Slate: one material all the way down, a cooler grey than chrome. 8.9:1.
  ('slate', 'Slate', false, true,
   '["#2B3038","#232830","#1E232A","#161A20"]'::jsonb, NULL, 'none',
   'rgba(255,255,255,0.80)', 20)
ON CONFLICT (key) DO NOTHING;

-- ── Who may choose one ──────────────────────────────────────────────────────────────────────────
-- Blaze and above, like premium_themes.
--
-- ⚠️ SPARK AND FLAME ARE WRITTEN EXPLICITLY FALSE, not left absent. Migration 054 states the reason
-- and names the casualty: "an absent key reads as 'nobody has decided yet', which is the state that
-- left the Edible Print Studio locked for everyone (see 050)."
update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('rail_skins', true)
 where name in ('blaze', 'forge');

update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('rail_skins', false)
 where name in ('spark', 'flame');

COMMIT;
