-- ── 041: what a flavour TASTES like, in two fields ──────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Plan: spattoo-docs/plans/storefront-facets.md — "The suggester"
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- The storefront's flavour suggester answers "I can't decide — help me pick" with a real
-- recommendation and the reason for it. To do that it has to know something about a
-- flavour beyond its name, and 038 gave flavours only a colour.
--
-- Two fields carry nearly all of it:
--
--   taste_family    what it IS, so "a chocolate person" can be answered
--   crowd_pleaser   whether it divides a room, so "safe bet" can be answered
--
-- ── WHY NOT TAGS ────────────────────────────────────────────────────────────────────
-- There is a tags table with categories (occasion, style, age_group…) and it is the
-- better end state if flavours ever need multi-dimensional matching. It is not worth it
-- yet: it needs a new category, a flavour_tags join, and admin plumbing, to express what
-- two columns express today. Revisit when a rule needs a flavour to be two things at once.
--
-- ── WHY GLOBAL, NOT PER BAKER ───────────────────────────────────────────────────────
-- "Belgian Dark is chocolate" is true in every kitchen, so Spattoo authors it once and no
-- baker is ever asked. Per-baker personalisation comes from the CATALOGUE, not from these
-- fields: the same rule run over a different baker's flavours gives a different answer,
-- because they stock different things. Where a baker genuinely wants a thumb on the
-- scale, that belongs on their settings row as one flag they will actually tick — not as
-- a rules engine nobody will author.
--
-- A baker's OWN flavour has no global row to inherit from, so they set these when they
-- create it, alongside its colours.
--
-- ── WHY NULL IS ALLOWED ─────────────────────────────────────────────────────────────
-- A flavour added tomorrow has no family until somebody authors one, and the suggester
-- must not break in the meantime — it simply cannot score that flavour, which is honest.
-- Never guess a family from the name: "Belgian Dark" and "White Forest" are both
-- unparseable, and a wrong suggestion with a confident reason is worse than no suggestion.

BEGIN;

ALTER TABLE public.flavours
  ADD COLUMN IF NOT EXISTS taste_family  text,
  ADD COLUMN IF NOT EXISTS crowd_pleaser boolean;

ALTER TABLE public.baker_flavours
  ADD COLUMN IF NOT EXISTS taste_family  text,
  ADD COLUMN IF NOT EXISTS crowd_pleaser boolean;

-- Eight families, chosen to be what a RULE needs rather than what a chef would say. A
-- longer list splits the catalogue so finely that no family has enough members to
-- recommend from.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'flavours_taste_family_valid') THEN
    ALTER TABLE public.flavours ADD CONSTRAINT flavours_taste_family_valid CHECK (
      taste_family IS NULL OR taste_family IN
      ('chocolate','fruit','classic','nut','caramel','coffee','tea','indian'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'baker_flavours_taste_family_valid') THEN
    ALTER TABLE public.baker_flavours ADD CONSTRAINT baker_flavours_taste_family_valid CHECK (
      taste_family IS NULL OR taste_family IN
      ('chocolate','fruit','classic','nut','caramel','coffee','tea','indian'));
  END IF;
END $$;

COMMENT ON COLUMN public.flavours.taste_family IS
  'What this flavour IS, for the storefront suggester: chocolate | fruit | classic | nut | caramel | coffee | tea | indian. Authored by Spattoo — true in every kitchen. NULL = not yet authored, and the suggester simply cannot score it; never guessed from the name.';

COMMENT ON COLUMN public.flavours.crowd_pleaser IS
  'Does this please a room, or divide it? Drives the "safe bet" answer. Dark chocolate, matcha and rasmalai are wonderful and divide people; vanilla and butterscotch do not. NULL = not yet authored.';

-- ── Seed the list as it stands ──────────────────────────────────────────────────────
-- Matched on lower(name) for dev/prod portability, and COALESCE-guarded so re-applying
-- never stomps a correction made in admin — the same rule 038 uses, for the same reason.
WITH seed(name, family, pleaser) AS (VALUES
  ('belgian dark',             'chocolate', false),   -- dark chocolate divides a room
  ('black currant',            'fruit',     false),
  ('black forest',             'chocolate', true),
  ('blueberry',                'fruit',     true),
  ('butterscotch',             'caramel',   true),
  ('choco cherry',             'chocolate', true),
  ('choco hazelnut',           'chocolate', true),
  ('chocolate',                'chocolate', true),
  ('chocolate mango',          'chocolate', false),   -- an unusual pairing, loved by some
  ('chocolate truffle',        'chocolate', true),
  ('coconut',                  'fruit',     false),
  ('ferrero rocher chocolate', 'chocolate', true),
  ('gauva',                    'fruit',     false),
  ('lemon',                    'fruit',     false),
  ('litchi',                   'fruit',     false),
  ('lotus biscoff',            'caramel',   true),
  ('matcha',                   'tea',       false),
  ('mocha',                    'coffee',    false),   -- coffee is rarely a child's cake
  ('orange',                   'fruit',     false),
  ('pineapple',                'fruit',     true),
  ('pistachio',                'nut',       false),
  ('rasmalai',                 'indian',    false),
  ('red velvet',               'classic',   true),
  ('strawberry',               'fruit',     true),
  ('vanilla',                  'classic',   true),
  ('white forest',             'classic',   true)
)
UPDATE public.flavours f
   SET taste_family  = COALESCE(f.taste_family,  s.family),
       crowd_pleaser = COALESCE(f.crowd_pleaser, s.pleaser)
  FROM seed s
 WHERE lower(f.name) = s.name
   AND (f.taste_family IS NULL OR f.crowd_pleaser IS NULL);

DO $$
DECLARE unset int;
BEGIN
  SELECT count(*) INTO unset FROM public.flavours
   WHERE is_active AND (taste_family IS NULL OR crowd_pleaser IS NULL);
  RAISE NOTICE '041: % active flavour(s) the suggester cannot score yet — set them in admin.', unset;
END $$;

COMMIT;
