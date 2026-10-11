-- ── 127: a fondant balloon in the decorations catalogue ──────────────────────────────────────────
--
-- The procedural balloon exists in core (geometry/balloon.js, FondantBalloon.jsx, tuned at
-- /elements/balloon in admin). This is the row that puts it on the shelf a customer picks from.
--
-- ⚠️ THE ROW AND THE HANDLER LAND TOGETHER, AND THAT IS NOT A STYLE POINT. `placement_config.
-- procedural` is read by PROCEDURAL_TOOLS in CakeDesigner; a row whose key has no entry there is a
-- decoration that appears in the picker and does NOTHING when tapped. This project has already paid
-- for that exact bug once — the Store rail item carried a submenu the More sheet could not render,
-- so it was dead on every phone for a day with every gate passing. `balloon: addBalloon` ships in
-- the same change as this row.
--
-- ⚠️ MODELLED ON `Puffy cloud`, deliberately, because it is the closest thing already on the shelf:
-- the same element type and the same medium. Copying the shape of a row that works is how a new
-- element avoids inventing a fourth way to be configured.
--
-- ⚠️ BUT NOT ITS CATEGORY. The cloud and the rainbow live in `sky`, and taking the whole row would
-- have put the balloon there with them — which is how it was first written. Sandeep: "category
-- should not be sky. should party&shapes." He is right, and the distinction is about how a CUSTOMER
-- browses rather than about how the element is built: a cloud is weather, and a balloon is a party.
-- Category is identity, and identity is the half you cannot inherit from a template.
--
-- Differences from the cloud, each one a decision:
--   · `color: true` in allowed_actions. A cloud is white and the control would be a lie; a
--     balloon's colour is most of the point — the reference is a pale one, a mint one and a pink
--     one on the same cake.
--   · `party-shapes`, not the cloud's `sky` — see above.
--     A balloon goes in on a pick, and the pick goes into the lid.
--     A cloud leans against the wall and stands on the board; a balloon does neither.
--   · `placement_config.balloon` carries the proportions signed off in the studio, so an admin
--     retunes the shape on the row without a deploy (INVARIANTS #1a). Core's BALLOON_DEFAULTS is
--     only the seed a row with nothing authored falls back to.
--
-- ⚠️ NO STICK IS CONFIGURED HERE. The pick is the element-stick property on this same row, authored
-- in Manage Elements with its own bury depth (elementStick.js). It is left unset so a human turns it
-- on and chooses the depth by looking — a stick buried to a number nobody judged is the thing that
-- property was built to stop.
--
-- Idempotent: keyed on the name, so re-running does not create a second balloon.

insert into public.cake_elements
  (name, offering, is_active, sort_order, element_type_id, category_id, medium,
   default_color, allowed_zones, applicable_zones, allowed_actions, default_params, placement_config)
select
  'Balloon', true, true, 60,
  (select element_type_id from public.cake_elements where name = 'Puffy cloud' limit 1),
  (select id from public.element_categories where slug = 'party-shapes'),
  'fondant',
  '#F4EFE6',
  array['top_surface']::text[],
  array[]::text[],
  '{"move": true, "color": true, "delete": true, "resize": true, "duplicate": true}'::jsonb,
  '{}'::jsonb,
  jsonb_build_object(
    'procedural', 'balloon',
    'top_surface', 'hug',
    -- Signed off in the studio against the reference photograph, 2026-10-07.
    'balloon', jsonb_build_object(
      'width',  0.62,
      'belly',  0.61,
      'crown',  0.86,
      'neck',   0.26,
      'knot',   0.095,
      'collar', 0.055,
      'segments', 14,
      'radial',   48
    )
  )
where not exists (select 1 from public.cake_elements where name = 'Balloon');

-- From 2026-10-30 Supabase stops auto-granting Data API access to NEW tables; this creates none, so
-- there is nothing to grant. `check:migration-grants` agrees — it only speaks about create table.
