-- ── Words a person adds, that a recompute cannot wipe ───────────────────────────────────────────
--
-- Sandeep, on the twelve theme names not fitting a teddy-bear-and-balloons cake: *"can we allow
-- user tags? meaning not just limiting to pre defined tags?"*
--
-- ⚠️ THE ANSWER IS NOT A SECOND TAG VOCABULARY. `template_tags` is curated on purpose: it draws the
-- filter chips, it is grouped into categories the filter ANDs across, and the AI half picks from it
-- precisely because it is closed. Free text there fragments into "makeup", "make-up", "Makeup",
-- "beauty" — four chips for one idea. The rule already written in lib/templateElements.js is the
-- right one: *"search_slugs IS SEARCHED AND NEVER DRAWN … Search widens; the filter stays legible."*
--
-- ⚠️ SO WHY A NEW COLUMN RATHER THAN TYPING INTO `search_slugs`. Because that column is DERIVED and
-- is overwritten wholesale — `syncTemplateDerived` rebuilds it from the design's elements and
-- lettering every time the design is saved, and deliberately so: an element removed from a cake
-- must stop describing it. A hand-typed term put there would survive until the next save and then
-- vanish, and vanish SILENTLY, because that function never throws on purpose. Two columns, two
-- owners: the machine owns `search_slugs`, a person owns `manual_slugs`, and nothing either writes
-- can erase the other.
--
-- Searching reads the union of the two. Nothing is drawn from either.

BEGIN;

ALTER TABLE public.cake_templates
  ADD COLUMN IF NOT EXISTS manual_slugs text[] NOT NULL DEFAULT '{}'::text[];

COMMENT ON COLUMN public.cake_templates.manual_slugs IS
  'Search terms typed by a person. Union-ed with the derived search_slugs when searching; never '
  'drawn as a chip. Kept apart from search_slugs because that column is rebuilt from the design on '
  'every save and would silently wipe them.';

-- The same index shape search_slugs has, since the two are searched together.
CREATE INDEX IF NOT EXISTS cake_templates_manual_slugs_idx
  ON public.cake_templates USING gin (manual_slugs);

COMMIT;

-- Verify:
--   select name, search_slugs, manual_slugs from public.cake_templates where manual_slugs <> '{}';
