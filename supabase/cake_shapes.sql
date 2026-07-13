-- Master data: the catalog of FOOTPRINTS a cake tier can have (round, sheet, heart, butterfly, …).
--
-- Why a table and not a code constant: a shape is authored, not engineered. Its FAMILY (the outline
-- generator: circle | rounded_rect | heart | butterfly | polygon | oval) is code — a curve has to be
-- drawn by something — but a shape's proportions are data, and a NEW shape is very often just a new
-- config against an existing family (an octagon is `polygon` with sides=8). Those must not need a
-- deploy. Same seam and same seed+overlay contract as cake_textures / text_styles:
-- spattoo-core's designer/cakeShapes.js holds the SEED and applyCakeShapeConfig() overlays these rows,
-- so a host that cannot reach the API still renders every shape the code knows.
--
-- SCALE. This is a BOUNDED lookup — tens of rows, read once per designer session, never per-request
-- hot. So the readable `key` is the right identifier here and is what a design's tier stores INSIDE
-- its jsonb (`design.tiers[i].shape = 'heart'`), which is a blob, not an indexed column — no row or
-- index is widened by it. If a HIGH-VOLUME table ever needs to reference a shape as a real COLUMN
-- (say orders, for a "shapes sold" report), it must store `cake_shape_id uuid references
-- cake_shapes(id)` — the compact surrogate — never the text key.

create table if not exists cake_shapes (
  id          uuid        primary key default gen_random_uuid(),
  key         text        not null unique,        -- stable machine key; what design.tiers[i].shape stores
  label       text        not null,               -- picker label
  family      text        not null,               -- the data↔code seam: names an outline generator in core
  config      jsonb       not null default '{}',  -- the family's tunables (sides, plump, cleft, wing…)
  is_active   boolean     not null default true,
  sort_order  integer     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table cake_shapes is
  'Master list of cake footprints. `family` names an outline generator in spattoo-core (geometry/shapes.js); `config` is that family''s data. Seeded in code (designer/cakeShapes.js) and overlaid from here.';

create index if not exists cake_shapes_active_order on cake_shapes (is_active, sort_order);

-- ── Seed rows — MUST match the code seed in spattoo-core/src/designer/cakeShapes.js ────────────────
-- `round` and `rect` are LOAD-BEARING: existing designs already store them (or nothing, which means
-- round). They are the two ANALYTIC families and must never be renamed or removed.
insert into cake_shapes (key, label, family, config, sort_order) values
  ('round',     'Round',     'circle',       '{}',                              1),
  ('rect',      'Rectangle', 'rounded_rect', '{}',                              2),
  ('square',    'Square',    'rounded_rect', '{"square": true}',                3),
  ('heart',     'Heart',     'heart',        '{"plump": 1, "cleft": 1}',        4),
  ('butterfly', 'Butterfly', 'butterfly',    '{"wing": 1}',                     5),
  ('hexagon',   'Hexagon',   'polygon',      '{"sides": 6, "rotation": 0}',     6),
  ('oval',      'Oval',      'oval',         '{}',                              7)
on conflict (key) do nothing;

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table cake_shapes enable row level security;

create policy "cake_shapes readable by authenticated"
  on cake_shapes for select to authenticated using (true);

create policy "cake_shapes writable by authenticated"
  on cake_shapes for all to authenticated using (true) with check (true);
