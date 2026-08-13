-- ── 038: what a flavour LOOKS like ──────────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Plan: spattoo-docs/plans/flavour-pricing.md (storefront facets)
--
-- ── WHY A FLAVOUR NEEDS A COLOUR ────────────────────────────────────────────────────
-- The storefront is getting a "taste" facet, and the thing that sells a flavour is not
-- its name — it is the crumb. A customer choosing between Belgian Dark and Rasmalai is
-- choosing between a colour and a texture they can picture, and a <select> of 26 words
-- is exactly the boring form the facet exists to replace.
--
-- So a flavour needs to be drawable: a SPONGE colour and a FILLING colour is enough to
-- render a convincing slice in cross-section, which is the one view that actually shows
-- what a flavour is. The cake's exterior cannot — a chocolate cake and a vanilla one
-- under fondant look identical.
--
-- ── WHY IT IS AUTHORED GLOBALLY, NOT PER BAKER ──────────────────────────────────────
-- Red Velvet is crimson in every kitchen. This is a property of the FLAVOUR, so Spattoo
-- authors it once in admin for the shared list, and a baker never sees the question.
-- Deriving it from the name was the alternative and it fails immediately: "Belgian Dark"
-- and "White Forest" are both unparseable, and the failure is silent and ugly.
--
-- A baker's OWN flavour has no global row to inherit from, so they pick the colours when
-- they create it — one swatch in a form they are already filling.
--
-- ── WHY NULL IS ALLOWED ─────────────────────────────────────────────────────────────
-- A flavour added to the global list tomorrow has no colours until someone authors them,
-- and the storefront must not break in the meantime. NULL means "we do not know", and
-- the renderer falls back to a neutral sponge rather than guessing — the same rule as
-- price_per_kg, where the honest answer is stated rather than invented.

BEGIN;

ALTER TABLE public.flavours
  ADD COLUMN IF NOT EXISTS sponge_color  text,
  ADD COLUMN IF NOT EXISTS filling_color text;

ALTER TABLE public.baker_flavours
  ADD COLUMN IF NOT EXISTS sponge_color  text,
  ADD COLUMN IF NOT EXISTS filling_color text;

-- Hex, or nothing. A malformed colour reaches a canvas and paints black, which reads as
-- a bug in the cake rather than a bug in the data.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flavours_colors_hex') THEN
    ALTER TABLE public.flavours ADD CONSTRAINT flavours_colors_hex CHECK (
      (sponge_color  IS NULL OR sponge_color  ~* '^#[0-9a-f]{6}$') AND
      (filling_color IS NULL OR filling_color ~* '^#[0-9a-f]{6}$')
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'baker_flavours_colors_hex') THEN
    ALTER TABLE public.baker_flavours ADD CONSTRAINT baker_flavours_colors_hex CHECK (
      (sponge_color  IS NULL OR sponge_color  ~* '^#[0-9a-f]{6}$') AND
      (filling_color IS NULL OR filling_color ~* '^#[0-9a-f]{6}$')
    );
  END IF;
END $$;

COMMENT ON COLUMN public.flavours.sponge_color IS
  'Hex colour of the CRUMB, for drawing a slice in cross-section on the storefront. Authored by Spattoo in admin — a property of the flavour, the same in every kitchen. NULL = not yet authored; the renderer falls back to a neutral sponge rather than guessing.';

COMMENT ON COLUMN public.flavours.filling_color IS
  'Hex colour of the FILLING or frosting layer, paired with sponge_color to draw a slice. NULL = not yet authored.';

-- ── Seed the list as it stands ──────────────────────────────────────────────────────
-- Matched on lower(name) rather than id, so this file is portable between dev and prod
-- where the uuids differ. `WHERE sponge_color IS NULL` twice over: it makes the seed
-- re-runnable, and — more importantly — it means a colour later corrected in admin is
-- never stomped by someone re-applying this migration.
--
-- These are a starting palette, not a final one. They are meant to be refined in admin
-- against a real rendered slice, which is the only place they can honestly be judged.
WITH seed(name, sponge, filling) AS (VALUES
  ('belgian dark',             '#3B2415', '#23130B'),
  ('black currant',            '#EFE0C4', '#4A1B3D'),
  ('black forest',             '#4A2C1A', '#8E1B22'),
  ('blueberry',                '#F2E4C6', '#3D2B56'),
  ('butterscotch',             '#F0DFB8', '#C88B3A'),
  ('choco cherry',             '#4A2C1A', '#8E1B22'),
  ('choco hazelnut',           '#4A2C1A', '#7A4A28'),
  ('chocolate',                '#4A2C1A', '#33200F'),
  ('chocolate mango',          '#4A2C1A', '#E39B2C'),
  ('chocolate truffle',        '#3F2617', '#22110A'),
  ('coconut',                  '#F3EAD6', '#FFFFFF'),
  ('ferrero rocher chocolate', '#4A2C1A', '#6B4526'),
  ('gauva',                    '#F2E4C6', '#E8737F'),
  ('lemon',                    '#F7E9A8', '#F2C744'),
  ('litchi',                   '#F7EFE2', '#E9C9CE'),
  ('lotus biscoff',            '#E8D2AE', '#C77B3C'),
  ('matcha',                   '#A9BE7B', '#CFE0B0'),
  ('mocha',                    '#4A3524', '#7A5C42'),
  ('orange',                   '#F7DFA8', '#E58A2B'),
  ('pineapple',                '#F4E6C0', '#F0C860'),
  ('pistachio',                '#C3CE96', '#A8BB7A'),
  ('rasmalai',                 '#FBF3DA', '#EED9A0'),
  ('red velvet',               '#8E2436', '#F6F1E8'),
  ('strawberry',               '#F5E6D3', '#E4626F'),
  ('vanilla',                  '#F2E3BC', '#FBF5E6'),
  ('white forest',             '#F7F0DE', '#DCC7A6')
)
UPDATE public.flavours f
   SET sponge_color  = COALESCE(f.sponge_color,  s.sponge),
       filling_color = COALESCE(f.filling_color, s.filling)
  FROM seed s
 WHERE lower(f.name) = s.name
   AND (f.sponge_color IS NULL OR f.filling_color IS NULL);

DO $$
DECLARE unpainted int;
BEGIN
  SELECT count(*) INTO unpainted FROM public.flavours
   WHERE is_active AND (sponge_color IS NULL OR filling_color IS NULL);
  RAISE NOTICE '038: % active flavour(s) still without colours — author them in admin.', unpainted;
END $$;

COMMIT;
