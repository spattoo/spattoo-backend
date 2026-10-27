-- ── 134: sand in the decorations catalogue ──────────────────────────────────────────────────────
--
-- The procedural sand exists in core (geometry/sand.js, geometry/region.js, SandBed.jsx, tuned at
-- /elements/sand in admin) and the designer has a Sand card. This is the row that puts it on the
-- shelf a customer picks from, and the row an admin edits in Manage Elements.
--
-- ⚠️ THE ROW AND THE HANDLER LAND TOGETHER. `placement_config.procedural` is read by
-- PROCEDURAL_TOOLS in CakeDesigner; a row whose key has no entry there is a decoration that appears
-- in the picker and does NOTHING when tapped. `sand: addSand` is already in that table — this
-- migration is the second half of a change whose first half has shipped, not a speculative row.
--
-- ⚠️ `surface_treatment`, NOT `fondant_decor`. 076 made that type for exactly this: things that
-- COVER a surface rather than stand on it — piped grass, dust up a wall, freehand cream. Sand does
-- not stand on the top, it IS the top for as much of it as the baker gave it. 073's lesson was that
-- a type per decoration is the mistake; this reuses the type that already describes the behaviour.
--
-- ⚠️ CATEGORY IS IDENTITY, AND THERE IS NO SEA CATEGORY YET. The thirteen are animals, art, baby,
-- chocolate, finishes, flowers-leaves, numbers-letters, party-shapes, people, photo-frames, piping,
-- sky and unicorn-rainbow. `finishes` is where a baker dressing a surface looks, and it is the same
-- shelf dust and foil sit on. When shells, starfish and driftwood arrive they will want a `sea`
-- category and sand should move there with them — that is a decision for when those rows exist, not
-- a category minted now for one element (074 and 080 both waited for the second member).

BEGIN;

-- ── A medium of its own, because sand is not any of the ten ──────────────────────────────────────
-- ⚠️ `medium` IS NOT DECORATION; IT IS WHAT THE BAKER MAKES IT FROM, and it prints on the build
-- guide. The ten seeded materials are chocolate, cream_knife, edible_print, fondant, ganache,
-- isomalt, marzipan, modelling_chocolate, royal_icing and wafer_paper — and sand is none of them.
-- Borrowing `fondant` would put "fondant" on a printed sheet in front of somebody holding a bag of
-- biscuits. 101's own note says the point of making this a table was that materials arrive as rows
-- over time; this is one of those.
--
-- `guide_format` stays NULL: the three values are 'modelled', 'piping_nozzle' and 'palette_knife',
-- and sand is none of those either. It is scattered by hand. NULL is allowed by the check 107 last
-- widened, so nothing has to change to say so honestly.
insert into decoration_mediums (key, label, can_model, can_print, guide_format, build_note, sort_order) values
  ('biscuit_crumb', 'Biscuit crumb', false, false, null,
   'Plain sweet biscuits — digestives, Marie, graham crackers — CRUSHED TO A POWDER and scattered. '
   'Blitz in a processor or crush in a bag with a rolling pin until it is a fine, even sand with no '
   'lumps left: a coarse crumb reads as gravel, not as sand, and that is the whole difference. '
   'Spoon it over the surface and level it with the back of a spoon, banking it a little deeper '
   'where the drift should look piled and feathering it to nothing at the edge. Colour comes from '
   'the biscuit itself, so pick the shade by choosing the biscuit — digestives for golden sand, '
   'Marie or shortbread for a pale one; a pinch of cocoa darkens it. Scatter it LAST, after '
   'everything standing in it is in place, so nothing has to be pressed through it afterwards. '
   'Do NOT describe piping, moulding or modelling.',
   86)
on conflict (key) do update set
  label        = excluded.label,
  can_model    = excluded.can_model,
  can_print    = excluded.can_print,
  guide_format = excluded.guide_format,
  build_note   = excluded.build_note,
  sort_order   = excluded.sort_order,
  is_active    = true;

-- ── The catalogue row ───────────────────────────────────────────────────────────────────────────
-- Idempotent: keyed on the name, so re-running does not create a second sand.
insert into public.cake_elements
  (name, offering, is_active, sort_order, element_type_id, category_id, medium,
   default_color, allowed_zones, applicable_zones, allowed_actions, default_params, placement_config)
select
  'Sand', true, true, 61,
  (select id from public.element_types where slug = 'surface_treatment'),
  (select id from public.element_categories where slug = 'finishes'),
  'biscuit_crumb',
  -- The palette's first entry. Core's SAND_COLORS is the fallback a row with nothing authored uses.
  '#d9b584',
  array['top_surface']::text[],
  array[]::text[],
  /* ⚠️ `move` IS FALSE, AND THAT IS NOT AN OVERSIGHT. The card exposes no position — the area is
     centred on the tier and sized by the dial — so a move control would be a button that does
     nothing. It is the same statement `check:movable`'s NOT_DRAGGED entry makes in core, and the
     two have to agree. The day the card grows Across/Up/Turn, BOTH change together.
     `duplicate` is false for a different reason: a tier has one drift, and a second copy of it
     would be the same sand in the same place. */
  '{"move": false, "color": true, "delete": true, "resize": true, "duplicate": false}'::jsonb,
  '{}'::jsonb,
  jsonb_build_object(
    'procedural', 'sand',
    -- Matches the type's placement_rules (076): a treatment is drawn to fit, never bent round.
    'top_surface', 'stand',
    /* ⚠️ A SHORT NAMED PALETTE, NOT A COLOUR WHEEL. Sandeep: "color options should be selective
       colors only. not a complete color picker." Sand is a narrow band of real colours and a free
       picker invites a blue beach. An admin retunes these here without a deploy; core's SAND_COLORS
       is only the seed a row with nothing authored falls back to. */
    'colors', jsonb_build_object(
      'sand',    '#d9b584',
      'pale',    '#e8d4ae',
      'golden',  '#d2a862',
      'biscuit', '#c89a63',
      'shell',   '#efe0c6'
    ),
    -- What a baker gets on the first tap, signed off against the renders on 2026-10-24. Core's
    -- SAND_DEFAULTS and REGION_DEFAULTS are the fallback; these are the authored starting point.
    'sand', jsonb_build_object(
      'shape',     'round',
      -- Generous on purpose: at 0.55 the first tap was a small blob in the middle of the top, which
      -- reads as a mistake rather than as the thing the baker just asked for.
      'size',      0.8,
      'spacing',   0.04,
      'rise',      0.055,
      'falloff',   0.5,
      'edgeBreak', 0.55,
      'seed',      11
    )
  )
where not exists (select 1 from public.cake_elements where name = 'Sand');

COMMIT;

-- Verify — the medium, the row, and that the handler key matches what core registers:
--   select key, label, guide_format from decoration_mediums where key = 'biscuit_crumb';
--   select e.name, t.slug as type, c.slug as category, e.medium,
--          e.placement_config->>'procedural' as handler
--     from cake_elements e
--     join element_types t on t.id = e.element_type_id
--     left join element_categories c on c.id = e.category_id
--    where e.name = 'Sand';
--
-- This migration creates no table, so there is nothing for check:migration-grants to grant.
