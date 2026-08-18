-- ── 065: what a decoration IS, as distinct from how it is placed ─────────────────────────────────
--
-- `element_types` answers a DESIGNER question: where can this sit, what may be edited, does it hug
-- the wall. That is why the list reads grouped_elements / decor_pattern / piping_style — mechanics.
-- It is the right axis for the canvas and the wrong one for a person looking for a lion.
--
-- The library proves it. "Unicorn" is currently spread across THREE types:
--
--   Top&Side Decors  → Unicorn
--   Cake Topper      → Unicorn horn, Unicorn left eye, Unicorn right eye
--   decor_pattern    → Uniocrn eyes
--
-- and Image topper holds 38 unrelated things — animals, baby clothes, leaf branches, numbers and
-- stars — because it is where anything flat ends up. Neither is a browsing category.
--
-- So: a SECOND axis. A decoration has one type (how it behaves) and one category (what it is), and
-- they are free to disagree. A unicorn horn is a Cake Topper AND Unicorn & Rainbow.
--
-- ── Why a table and not a text column ───────────────────────────────────────────────────────────
-- Same reason as element_types, roles and every other enumerable here: a name the customer reads
-- needs to be renameable without an UPDATE across the library, ordered deliberately rather than
-- alphabetically, and retired without deleting the elements that referenced it. `sort_order` is the
-- point — this list is a MENU, and "Animals" should not sit under "Baby" because A precedes B.
--
-- ── Procedural decorations are rows, not a special case ──────────────────────────────────────────
-- Some decorations are generated in code rather than loaded as an asset — grass, letter blocks,
-- luster dust, the cream pen. That is an implementation detail and the customer must never meet it:
-- they are looking for a gold shimmer, and whether we draw it or download it is our business.
--
-- So they belong in THIS table like everything else, and the designer already has the mechanism:
-- `placement_config.procedural` names a generator, and PROCEDURAL_TOOLS in CakeDesigner looks it up
-- from the clicked element. One code path — a card with `procedural` calls its generator, a card
-- without one places its asset — and the category menu never has to know the difference.
--
-- ⚠️ Luster dust and the cream pen have NO row yet, so this migration cannot categorise them. They
-- are reached today by setting `activeTool` directly, and their element_types (`luster_dust`,
-- `text`) hold zero rows. Giving them one each is a small piece of authoring, not a schema change:
-- a name, a thumbnail, the existing type, a category, and `placement_config.procedural`. Until then
-- they stay outside the category menu — visibly missing, which is the right kind of wrong.

CREATE TABLE IF NOT EXISTS public.element_categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text NOT NULL UNIQUE,
  name       text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now()
);

COMMENT ON TABLE public.element_categories IS
  'Customer-facing browsing categories for decorations — what a thing IS. Orthogonal to '
  'element_types, which is how it BEHAVES. Ordered by sort_order because this list is a menu.';

-- ON DELETE SET NULL, not CASCADE: retiring a category must never delete the decorations in it.
-- Nullable because it is added to a live library — an uncategorised element still works everywhere
-- it worked before, it simply does not appear under a category heading yet.
ALTER TABLE public.cake_elements
  ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.element_categories(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.cake_elements.category_id IS
  'Browsing category (what this decoration is). NULL = not yet categorised; such an element is '
  'still placeable, it just has no home in the category menu. See element_categories.';

-- The menu reads "give me the elements in this category" on every open, filtered to the active,
-- top-level, in-scope rows the catalogue query already selects.
CREATE INDEX IF NOT EXISTS cake_elements_category_id_idx
  ON public.cake_elements (category_id) WHERE is_active AND parent_id IS NULL;

-- ── The starting list ────────────────────────────────────────────────────────────────────────────
-- Derived from what is actually in the library today, not invented. Gaps in sort_order leave room
-- to insert without renumbering.
INSERT INTO public.element_categories (slug, name, sort_order) VALUES
  ('animals',          'Animals',            10),
  ('flowers-leaves',   'Flowers & Leaves',   20),
  ('unicorn-rainbow',  'Unicorn & Rainbow',  30),
  ('baby',             'Baby',               40),
  ('numbers-letters',  'Numbers & Letters',  50),
  ('party-shapes',     'Party & Shapes',     60),
  ('chocolate',        'Chocolate',          70),
  ('people',           'People',             80),
  ('photo-frames',     'Photo Frames',       90),
  ('piping',           'Piping',            100),
  ('finishes',         'Finishes',          110)
ON CONFLICT (slug) DO NOTHING;

-- ── Backfill ─────────────────────────────────────────────────────────────────────────────────────
-- By NAME, because that is the only signal that distinguishes a lion from a leaf — element_type
-- cannot, which is the whole reason this column exists. Deliberately conservative: anything these
-- patterns do not match stays NULL for a human to place, rather than being swept into a
-- catch-all. A wrong category is worse than none — an uncategorised element is visibly missing,
-- a miscategorised one is quietly unfindable.
--
-- ORDER IS LOAD-BEARING. Each statement only touches rows still NULL, so the most reliable signal
-- must go first. Two rules that matter:
--
--   TYPE BEFORE NAME. A piping element is named for the nozzle motion, and three of them —
--   Star Dome, Ribbon Swag, Draped Ribbon — contain words the party-shapes rule looks for. Run by
--   name first and a customer browsing Party & Shapes is offered three piping borders while the
--   piping category is missing them. Nothing errors; they are simply filed under the wrong heading.
--
--   SPECIFIC BEFORE GENERAL. Unicorn before Animals, so "Unicorn horn" is not an animal;
--   party-shapes last, because star/bow/ribbon/heart are the words most likely to appear inside a
--   name that is really about something else.

-- Piping and finishes by TYPE, not name: for these two groups the element_type IS the subject, which
-- makes it the strongest signal available — and running them first protects them from the name rules.
WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c WHERE c.slug = 'piping' AND e.category_id IS NULL
  AND e.element_type_id IN (
    SELECT id FROM public.element_types WHERE slug IN ('cream_piping', 'piping_pattern', 'piping_style'));

WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c WHERE c.slug = 'finishes' AND e.category_id IS NULL
  AND e.element_type_id IN (
    SELECT id FROM public.element_types WHERE slug IN ('cream_layer', 'faux_ball', 'food_foil', 'luster_dust', 'drip'));

WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c WHERE c.slug = 'unicorn-rainbow' AND e.category_id IS NULL
  AND (e.name ILIKE '%unicorn%' OR e.name ILIKE '%uniocrn%' OR e.name ILIKE '%rainbow%');

WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c WHERE c.slug = 'animals' AND e.category_id IS NULL
  AND (e.name ILIKE '%dinosaur%' OR e.name ILIKE '%elephant%' OR e.name ILIKE '%fox%'
    OR e.name ILIKE '%giraffe%'  OR e.name ILIKE '%hippo%'    OR e.name ILIKE '%lion%'
    OR e.name ILIKE '%monkey%'   OR e.name ILIKE '%zebra%'    OR e.name ILIKE '%butterfly%');

WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c WHERE c.slug = 'flowers-leaves' AND e.category_id IS NULL
  AND (e.name ILIKE '%leaf%'   OR e.name ILIKE '%flower%' OR e.name ILIKE '%daisy%'
    OR e.name ILIKE '%berry%'  OR e.name ILIKE '%grass%'  OR e.name ILIKE '%palm%');

WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c WHERE c.slug = 'baby' AND e.category_id IS NULL
  AND (e.name ILIKE '%baby%' OR e.name ILIKE '%onesie%' OR e.name ILIKE '%romper%'
    OR e.name ILIKE '%bib%'  OR e.name ILIKE '%necktie%');

WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c WHERE c.slug = 'numbers-letters' AND e.category_id IS NULL
  AND (e.name ILIKE '%number%' OR e.name ILIKE '%happy birthday%' OR e.name ILIKE '%letter%');

WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c WHERE c.slug = 'chocolate' AND e.category_id IS NULL
  AND e.name ILIKE '%chocolate%';

WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c WHERE c.slug = 'photo-frames' AND e.category_id IS NULL
  AND e.name ILIKE '%photo frame%';

WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c WHERE c.slug = 'people' AND e.category_id IS NULL
  AND e.name ILIKE '%doll%';

WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c WHERE c.slug = 'party-shapes' AND e.category_id IS NULL
  AND (e.name ILIKE '%star%'   OR e.name ILIKE '%bow%'      OR e.name ILIKE '%ribbon%'
    OR e.name ILIKE '%banner%' OR e.name ILIKE '%heart%'    OR e.name ILIKE '%sprinkle%');

-- Anything still NULL is left for a human. On the library as it stands (2026-08-17) nothing is —
-- all 86 match — but that is a fact about today's names, not a guarantee. A new element called
-- "Koala" gets no category until someone gives it one, and appearing nowhere in the menu is the
-- right kind of wrong: visible, rather than quietly filed under the wrong heading.
