-- ── A type for things that COVER a surface ──────────────────────────────────────────────────────
-- ⚠️ DEV ONLY — do not run this in production.
--
-- The promotion bundle carries element types WITH their ids, and the import matches vocabulary by
-- SLUG: if production has already minted its own id for this slug, importing any element that uses
-- it is rejected with a 409 — same slug, different id, reconcile by hand. Production gets this type
-- when the first element using it is imported, which is how `fondant_decor` got there.
--
-- Grass has a studio with a Save button, a `procedural` key wired into the designer's registry, and
-- a `typeSlug: 'grass'` that names an element type which has never existed. So the save has been
-- impossible since the studio was written, and says so only at the moment somebody presses it:
-- "No 'grass' element type found — create it first in Element Types."
--
-- That is why there is no grass in the catalogue. Not because nobody bothered — because nobody could.
--
-- ── WHY A NEW TYPE AND NOT AN EXISTING ONE ──────────────────────────────────────────────────────
-- Every existing type describes something that STANDS on a surface. `fondant_decor` is the rainbow
-- and the cloud; `topper` is a digit on the top. Grass does not stand on the top, it IS the top —
-- a treatment covering it, the same behaviour luster dust and the cream pen have and a different one
-- from everything else in the table.
--
-- 065: element_types is how a thing BEHAVES. By that rule these three are one type, and the rainbow
-- is not in it.
--
-- ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────────────
-- Letter blocks. They stand on a surface and they are fondant, so `fondant_decor` already describes
-- them exactly and a type of their own would be a type per decoration — the mistake 073 corrected.
-- The studio is repointed instead, which is a one-line change and no migration.
--
-- Luster dust. It has its own type already, with the right zones and no rows. Merging it in here
-- would be tidier and would also be churn on something that works.
--
-- Widening `text` so writings can use it. That is for when writings become rows, which they are not
-- yet, and a type nobody uses is not improved by being changed on speculation.

BEGIN;

-- zones: the superset these treatments cover between them — grass on the top and round the board,
-- luster dust and the pen on the wall. `allowed_zones` on the ELEMENT is what actually governs, and
-- each studio authors its own, so a superset here widens nothing.
--
-- placement 'stand' throughout, like 072 and 073: 'hug' means bend a flat ASSET round the tier, and
-- none of these is an asset. They are drawn to fit whatever they are put on.
INSERT INTO public.element_types
  (slug, name, description, placement_rules, sort_order, is_active, baker_uploadable, default_for_uploads)
VALUES (
  'surface_treatment',
  'Surface Treatment',
  'Generated finishes that COVER a surface rather than standing on it — piped grass over a tier, '
  'dust flicked up a wall, freehand cream. Drawn to fit whatever they are applied to.',
  '{"zones": ["top_surface", "side", "board"],
    "placement": {"top_surface": "stand", "side": "stand", "board": "stand"}}'::jsonb,
  (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.element_types),
  true,
  -- Nothing to upload: the thing IS the generator.
  false,
  false
)
ON CONFLICT (slug) DO NOTHING;

-- Movable, like every other decoration (061). Grass clumps genuinely are dragged, one at a time.
UPDATE public.element_types
   SET default_allowed_actions = COALESCE(default_allowed_actions, '{}'::jsonb) || '{"move": true}'::jsonb
 WHERE slug = 'surface_treatment'
   AND NOT (COALESCE(default_allowed_actions, '{}'::jsonb) ? 'move');

COMMIT;

-- Verify — the type exists and is empty until somebody presses Save in the Grass Studio:
--   select slug, name, placement_rules, default_allowed_actions
--     from element_types where slug = 'surface_treatment';
--   select name, placement_config->>'procedural'
--     from cake_elements
--    where element_type_id = (select id from element_types where slug = 'surface_treatment');
