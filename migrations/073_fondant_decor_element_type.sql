-- ── One type for generated fondant decorations, not one per decoration ──────────────────────────
-- ⚠️ DEV ONLY — do not run this in production.
--
-- The promotion bundle carries element types WITH their ids, and the import matches vocabulary by
-- SLUG: if production has already minted its own id for this slug, importing any element that uses
-- it is rejected with a 409 — same slug, different id, reconcile by hand. Production gets this type
-- when the first element using it is imported, which is how `fondant_decor` got there.
--
-- 072 added a `rainbow` element type. That was a mistake, and this corrects it before a second one
-- compounds it: a cloud was about to get its own type too, and then every future generated shape
-- would have brought another.
--
-- 065 states what this table is FOR: "element_types, which is how it BEHAVES. Orthogonal to
-- element_categories" — what a thing IS. By that definition the rainbow and the cloud are the same
-- type. Their behaviour is byte-identical: the same three zones, `stand` on all of them, movable,
-- nothing to upload. What differs is which generator draws them, and that already lives on the
-- element as `placement_config.procedural`. What they ARE — a rainbow, a cloud — is the category's
-- job, not this table's.
--
-- ── WHY A RENAME AND NOT A NEW ROW ──────────────────────────────────────────────────────────────
-- The id is kept. `cake_elements.element_type_id` is a FK and a rainbow row has already been
-- authored against it on dev; a new type would mean repointing that row, and an export bundle
-- carries ids verbatim precisely so nothing has to be remapped between environments. Renaming
-- touches one row and leaves every reference correct.
--
-- ── THE ZONES ARE A SUPERSET, AND THAT IS FINE ──────────────────────────────────────────────────
-- `placement_rules.zones` on the TYPE is the default offered to an un-promoted upload. What actually
-- governs a placed decoration is `allowed_zones` on the ELEMENT, which each studio authors: grass
-- and letter blocks say top_surface + board, the rainbow says all three. So one type offering all
-- three does not widen anything — each element still says where IT goes.

BEGIN;

-- The rename, for any environment that ran 072.
UPDATE public.element_types
   SET slug        = 'fondant_decor',
       name        = 'Fondant Decoration',
       description = 'Generated fondant shapes that stand on the cake, its side, or the board — '
                     'rainbows, clouds, and whatever is modelled next. The generator is named by '
                     'placement_config.procedural on each element; what it depicts is its category.'
 WHERE slug = 'rainbow'
   AND NOT EXISTS (SELECT 1 FROM public.element_types WHERE slug = 'fondant_decor');

-- …and the create, for one that did not. Both paths land on the same row, so this migration is
-- correct whether or not 072 was ever applied — which matters, because it was deliberately NOT run
-- in production: the export bundle carries the type along with the element.
INSERT INTO public.element_types
  (slug, name, description, placement_rules, sort_order, is_active, baker_uploadable, default_for_uploads)
VALUES (
  'fondant_decor',
  'Fondant Decoration',
  'Generated fondant shapes that stand on the cake, its side, or the board — rainbows, clouds, and '
  'whatever is modelled next. The generator is named by placement_config.procedural on each element; '
  'what it depicts is its category.',
  '{"zones": ["top_surface", "side", "board"],
    "placement": {"top_surface": "stand", "side": "stand", "board": "stand"}}'::jsonb,
  (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM public.element_types),
  true,
  -- Nothing to upload: the thing IS the generator.
  false,
  false
)
ON CONFLICT (slug) DO NOTHING;

-- Movable, like every other decoration (061). Idempotent the same way, so a re-run cannot undo an
-- admin who has since unticked it.
UPDATE public.element_types
   SET default_allowed_actions = COALESCE(default_allowed_actions, '{}'::jsonb) || '{"move": true}'::jsonb
 WHERE slug = 'fondant_decor'
   AND NOT (COALESCE(default_allowed_actions, '{}'::jsonb) ? 'move');

-- 065 files by NAME. "cloud" matches none of its rules, so a cloud row would sit uncategorised and
-- never appear under a heading — invisible rather than merely mis-filed. 'unicorn-rainbow' is where
-- a cloud is most often wanted; a wrong-but-visible home beats an invisible one, and an admin moves
-- it on the Manage Elements screen, which is what that screen is for.
WITH c AS (SELECT slug, id FROM public.element_categories)
UPDATE public.cake_elements e SET category_id = c.id
FROM c
WHERE c.slug = 'unicorn-rainbow'
  AND e.category_id IS NULL
  AND e.placement_config->>'procedural' IN ('rainbow', 'cloud');

COMMIT;

-- Verify — ONE type, holding both generators:
--   select slug, name, placement_rules, default_allowed_actions
--     from element_types where slug in ('fondant_decor', 'rainbow');
--   select name, placement_config->>'procedural', allowed_zones
--     from cake_elements
--    where element_type_id = (select id from element_types where slug = 'fondant_decor');
