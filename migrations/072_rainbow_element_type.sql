-- ── The rainbow is an element TYPE ──────────────────────────────────────────────────────────────
-- A fondant rainbow, generated rather than modelled. Its legs have to REACH THE BOARD, and that is a
-- different distance on a single tier than on a stack — with no scale factor that fixes it, because
-- the legs must stretch while the arch must not. A modelled arch is authored at one leg length.
--
-- Which is an implementation detail the customer must never meet, exactly as 065 says of grass and
-- letter blocks: they are looking for a rainbow, and whether we draw it or download it is our
-- business. So it lives here like everything else, and the mechanism already exists —
-- `placement_config.procedural` names a generator and PROCEDURAL_TOOLS in CakeDesigner looks it up.
--
-- This migration adds the TYPE. The rows are authored in the Rainbow Studio, which is where a look
-- gets judged and saved: "Pastel arch" and "Bold six-band" are two rows over one generator, never
-- two presets hardcoded in a studio.

BEGIN;

-- zones: all three, because the geometry genuinely does all three and each is a different object
-- rather than the same one turned. `top_surface` is the arch standing on or leaning over the cake;
-- `side` is the wall-hugging version, which is about half the cake's width with no straight legs;
-- `board` is a big arch standing beside the cake.
--
-- placement: 'stand' everywhere, including the side. A rainbow pressed onto a wall is NOT hugging in
-- the sense the placement modes mean — 'hug' bends a flat asset round the tier, and this one is
-- generated already bent, by dividing distance-along-the-wall by the radius. Marking it 'hug' would
-- ask the placement layer to bend an object that is not flat and has no need of it.
INSERT INTO public.element_types
  (slug, name, description, placement_rules, sort_order, is_active, baker_uploadable, default_for_uploads)
VALUES (
  'rainbow',
  'Rainbow',
  'Concentric fondant ropes arching over the cake, or pressed onto its wall. Generated to fit '
  'whatever cake it is placed on — the legs stretch to reach the board, the arch does not.',
  '{"zones": ["top_surface", "side", "board"],
    "placement": {"top_surface": "stand", "side": "stand", "board": "stand"}}'::jsonb,
  -- After the existing types rather than in the middle of them: sort_order is a MENU order, and
  -- inserting into the middle would silently renumber nothing but would put a new arrival above
  -- things an admin deliberately ordered.
  (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.element_types),
  true,
  -- Not baker-uploadable: there is no file to upload. A baker cannot bring their own rainbow the way
  -- they can bring their own PNG, because the thing IS the generator.
  false,
  false
)
ON CONFLICT (slug) DO NOTHING;

-- Movable, like every other decoration (061). Written the same idempotent way, so a re-run cannot
-- undo an admin who has since unticked it: the backfill is for a row that never had an opinion.
UPDATE public.element_types
   SET default_allowed_actions = COALESCE(default_allowed_actions, '{}'::jsonb) || '{"move": true}'::jsonb
 WHERE slug = 'rainbow'
   AND NOT (COALESCE(default_allowed_actions, '{}'::jsonb) ? 'move');

-- 065 already made a home for it, by name: the 'unicorn-rainbow' category matches '%rainbow%'. This
-- files any rainbow row created before that category existed, and is a no-op otherwise.
WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c
WHERE c.slug = 'unicorn-rainbow'
  AND e.category_id IS NULL
  AND e.placement_config->>'procedural' = 'rainbow';

COMMIT;

-- Verify — the type exists, is movable, and offers all three surfaces:
--   select slug, name, sort_order, placement_rules, default_allowed_actions
--     from element_types where slug = 'rainbow';
-- And, once a row has been saved from the studio:
--   select name, placement_config->>'procedural', allowed_zones
--     from cake_elements where placement_config->>'procedural' = 'rainbow';
