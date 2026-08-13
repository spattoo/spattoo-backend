-- cake_shapes: CONTRACT step — drop the columns the `design` column replaced.
--
-- RUN THIS ONLY AFTER:
--   1. cake_shapes_design.sql has been applied (the `design` column exists), AND
--   2. scripts/migrate_cake_shapes_to_design.js has run (every row's design is backfilled + the sheet
--      cakes have moved in from cake_templates), AND
--   3. the design-reading API (routes/cakeShapes.js selecting `design`, not family/config/tiers) is
--      deployed and verified.
--
-- Order matters: the route stops selecting these columns before they are dropped, and the backfill
-- fills `design` before this removes the only other source of a shape's geometry. Reverse the order and
-- a live designer would resolve every shape to a bare round cylinder.
--
-- `family`/`config` (the geometry) and `tiers` (the starter stack) all now live inside `design`.
alter table cake_shapes
  drop column if exists family,
  drop column if exists config,
  drop column if exists tiers;
