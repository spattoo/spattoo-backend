-- ── Unicorns to Animals, and the Unicorn & Rainbow shelf retired ────────────────────────────────
-- 074 moved the rainbows, clouds and stars out to Sky. What is left on 'unicorn-rainbow' is
-- unicorns, under a name that still promises rainbows it no longer has — and a category that
-- advertises something it does not hold is a small lie to somebody browsing.
--
-- So the unicorns go to Animals. A dinosaur already sits there without anyone minding that it is
-- extinct; a mythical horse is no stretch. And 065 says this list is a MENU — a shorter one is a
-- better one.
--
-- ── RETIRED, NOT DELETED ────────────────────────────────────────────────────────────────────────
-- `is_active = false`, which is what the public endpoint filters on. Deleting the row would work too
-- — the FK is ON DELETE SET NULL, so nothing cascades — but it would also silently uncategorise any
-- element the move below missed, and an uncategorised element appears under no heading at all.
-- Retiring leaves the row, so a straggler stays findable on Manage Elements, which lists inactive
-- categories as well.
--
-- ── IF THIS TURNS OUT TO BE WRONG ───────────────────────────────────────────────────────────────
-- Unicorn may deserve its own shelf: it is a destination theme people come looking for by name,
-- while Animals is where you look when you do not know what you want. That is a merchandising call
-- and it is reversible — flip is_active back on and move the unicorns home. Nothing here is lossy.

BEGIN;

-- Every element still on that shelf, whatever it is called. By category rather than by name,
-- because after 074 the shelf IS the definition of "these are the unicorns" — and a name rule would
-- miss "Magical horse with horn".
WITH u AS (SELECT id FROM public.element_categories WHERE slug = 'unicorn-rainbow'),
     a AS (SELECT id FROM public.element_categories WHERE slug = 'animals')
UPDATE public.cake_elements e SET category_id = a.id
FROM u, a
WHERE e.category_id = u.id;

-- Only once it is empty. The guard is not ceremony: run out of order, or with 074 skipped, and this
-- would hide a shelf with rainbows still standing on it.
UPDATE public.element_categories
   SET is_active = false
 WHERE slug = 'unicorn-rainbow'
   AND NOT EXISTS (
     SELECT 1 FROM public.cake_elements e
      WHERE e.category_id = (SELECT id FROM public.element_categories WHERE slug = 'unicorn-rainbow'));

COMMIT;

-- Verify — the shelf is empty and gone from the menu, and nothing was orphaned:
--   select slug, name, is_active from element_categories order by sort_order;
--   select count(*) from cake_elements where category_id is null;
--   select c.name, count(*) from cake_elements e
--     join element_categories c on c.id = e.category_id
--    group by c.name order by c.name;
