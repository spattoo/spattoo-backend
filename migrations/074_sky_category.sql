-- ── A Sky category ──────────────────────────────────────────────────────────────────────────────
-- Rainbows, clouds, stars, suns and moons are one subject, and it is not unicorns. 065 filed them
-- under 'unicorn-rainbow' because that was the nearest shelf that existed; it is the right shelf for
-- a unicorn horn and the wrong one for a cloud.
--
-- ── WHAT MOVES, AND WHAT DELIBERATELY DOES NOT ──────────────────────────────────────────────────
-- Name matching again, because that is all there is — but NARROWER than 065's, in one specific way:
-- anything whose name mentions a unicorn STAYS where it is. 065's rule was '%unicorn%' OR
-- '%rainbow%', so "Unicorn with rainbow mane" is sitting in that category on the strength of both
-- words. Moving every '%rainbow%' would drag unicorns into the sky with them.
--
-- The reverse case is accepted: a plain "Rainbow" that a baker meant as part of a unicorn set moves
-- to Sky. That is recoverable in one click on Manage Elements. A unicorn lost among the clouds is
-- the same click, but nobody goes looking for it there, so the asymmetry is deliberate.
--
-- ── AND WHY THIS DOES NOT JUST FIX 073 ──────────────────────────────────────────────────────────
-- 073 files procedural rainbows and clouds into 'unicorn-rainbow'. Editing it would be rewriting a
-- migration that may already have run. This runs after it and moves them on, which is correct
-- whether 073 ran or not — and it is idempotent, so it is also correct if this one runs twice.

BEGIN;

-- 35, so it sits directly after Unicorn & Rainbow (30) and before Baby (40). The list is a MENU:
-- a customer who did not find their rainbow under unicorns meets Sky on the very next line.
INSERT INTO public.element_categories (slug, name, sort_order)
VALUES ('sky', 'Sky', 35)
ON CONFLICT (slug) DO NOTHING;

-- 1. The generated ones, by what they ARE rather than by their name. `placement_config.procedural`
--    is exact where a name is a guess, so these move whatever anybody called them.
WITH c AS (SELECT id FROM public.element_categories WHERE slug = 'sky')
UPDATE public.cake_elements e SET category_id = c.id
FROM c
WHERE e.placement_config->>'procedural' IN ('rainbow', 'cloud')
  AND e.category_id IS DISTINCT FROM c.id;

-- 2. Everything else, by name — from the unicorn shelf or from no shelf at all, and never from a
--    shelf somebody chose deliberately. `star` is spelled with a word boundary: '%star%' also
--    matches "starfish", "mustard" and "starter".
WITH c AS (SELECT id FROM public.element_categories WHERE slug = 'sky'),
     u AS (SELECT id FROM public.element_categories WHERE slug = 'unicorn-rainbow')
UPDATE public.cake_elements e SET category_id = c.id
FROM c, u
WHERE (e.category_id = u.id OR e.category_id IS NULL)
  AND e.name !~* 'unicorn'
  AND e.name ~* '(rainbow|cloud|\ystars?\y|\ysuns?\y|\ymoons?\y)';

COMMIT;

-- Verify — what landed in Sky, and what stayed with the unicorns:
--   select c.name, e.name, e.placement_config->>'procedural'
--     from cake_elements e join element_categories c on c.id = e.category_id
--    where c.slug in ('sky', 'unicorn-rainbow')
--    order by c.sort_order, e.name;
--
-- Anything mis-filed moves in one click on Manage Elements, which is what that screen is for.
