-- cake_shapes: a shape is the cake you START with, not just the outline it is cut from.
--
-- Two additions, one migration.
--
-- 1. `tiers` — the STACK. The catalog was a footprint-only model, and it could not tell "Cylinder" from
--    "2T Cylinder": both are family=circle with an empty config, so the two rows were byte-identical and
--    the picker drew the same circle twice. Tier count was never persisted — the Cake Shape Studio's tier
--    sliders were explicitly throwaway ("not saved with the shape — for judging it"). A shape that means
--    "a two-tier heart" therefore could not exist. Now it can: `tiers` is the cake this shape starts you
--    with, and `New` seeds the whole stack.
--
--    EMPTY IS THE OLD BEHAVIOUR. `[]` (the default, and what every existing row gets) means "one tier, at
--    the designer's default size" — byte-identical to today. No backfill, no reshaped cake.
--
--    Each entry is `{width, depth, height}` in world units. It does NOT carry its own footprint: every
--    tier of a shape is that shape (a "2 tier heart" is the heart outline, stacked twice, at these two
--    sizes). A mixed stack — a round tier on a square base — is something the customer builds in the
--    designer, where the renderer already supports it per-tier. If a mixed PRESET is ever wanted, an
--    optional `shape` key inside these objects adds it with no further migration, which is exactly why
--    this is jsonb and not three numeric columns.
--
-- 2. `thumbnail_key` — the PICTURE. A picker tile has to show a cake, and the honest way to draw a cake
--    is to render one: the studio already previews through the real designer renderer, so on save it
--    captures that view and stores it in R2. The alternative — a live 3D canvas per tile — costs one
--    WebGL context per shape, and browsers cap concurrent contexts (~16), so the grid would start
--    blanking tiles as the catalog grew. An <img> costs nothing at any N. Same `*_key`-in-R2 convention
--    as cake_elements.thumb_key and templates.thumbnail_key.
--
-- SCALE. cake_shapes remains a BOUNDED lookup (tens of rows, read once per designer session). jsonb and
-- a storage key on it widen nothing hot: a design still stores only the shape KEY per tier, inside its
-- jsonb blob. No high-volume table is touched by this.

alter table cake_shapes
  add column if not exists tiers         jsonb not null default '[]'::jsonb,
  add column if not exists thumbnail_key text;

comment on column cake_shapes.tiers is
  'The cake this shape starts you with: [{width, depth, height}, …] in world units. [] = one tier at the designer default (the pre-existing behaviour). Every tier uses this row''s own family/config as its footprint.';

comment on column cake_shapes.thumbnail_key is
  'R2 key of a FRONT VIEW of this shape, captured through the real designer renderer when the shape is saved. The picker renders it as an <img> — one image per shape rather than one WebGL context per shape.';
