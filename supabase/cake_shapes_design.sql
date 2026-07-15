-- cake_shapes: collapse `family` + `config` + `tiers` into ONE self-contained `design`.
--
-- A shape is now stored as a DESIGN — byte-for-byte the same shape a cake_templates.design has (see
-- spattoo-core designSnapshot.js). "New cake → this shape" loads it exactly as a template does, so the
-- starter catalog and the template system are one model, not two. Geometry is self-describing PER TIER:
-- each `design.tiers[i]` carries its own `shapeFamily` (the outline generator) + `shapeConfig` (that
-- family's proportions). Consequences:
--   • a cake can MIX shapes per tier (a round tier on a square base) — the picture the customer actually
--     draws, and the direction real cakes go (tiered cakes with a different-shaped separator);
--   • a saved cake renders identically FOREVER, even if its catalog row is later retuned or retired —
--     the geometry lives in the design, not in a lookup the design merely points at.
--
-- The old `family`/`config` (geometry) and `tiers` (the starter stack) columns are now REDUNDANT with
-- the design and are dropped — but in a SEPARATE step (cake_shapes_drop_legacy_cols.sql), AFTER the
-- backfill script has run and the design-reading code is deployed. Expand → backfill → contract, so no
-- window exists where a row has neither the old columns nor a real design.
--
-- SCALE unchanged: cake_shapes is still a BOUNDED lookup (tens of rows, read once per designer session).
-- A design's tier still names its shape by KEY inside its own jsonb blob — no hot/indexed column widens.

-- ── Step 1 (EXPAND): add the column ────────────────────────────────────────────────────────────────
-- Defaulted to '{}' so existing rows are valid immediately; the backfill script
-- (scripts/migrate_cake_shapes_to_design.js) then fills each row's real design from its family/config/
-- tiers. During the window between this and the backfill, applyCakeShapeConfig() still reads the legacy
-- family/config columns (they are not dropped yet), so the designer keeps rendering throughout.
alter table cake_shapes
  add column if not exists design jsonb not null default '{}'::jsonb;

comment on column cake_shapes.design is
  'The self-contained starter design for this shape — the SAME shape as cake_templates.design. Each tier carries its own shapeFamily + shapeConfig, so geometry travels with the design and a cake can mix shapes per tier. "New cake → this shape" loads this via the designer''s loadDesign(), exactly like a template.';
