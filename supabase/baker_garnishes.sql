-- ── Garnishes: chocolate pieces a person piped in the studio and kept ────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Design + the argument behind it: spattoo-docs/plans/chocolate-garnish-studio.md
--
-- ── WHY NOT baker_uploads ───────────────────────────────────────────────────────────────────────
-- An upload is A PICTURE with a storage key, and its whole model — cutouts, frame photos, promotion,
-- shares — is about images. A garnish is a DRAWING: a list of polylines that gets swept into piped
-- chocolate at render time. Storing one in the other would mean a nullable storage_key, a nullable
-- payload, and a `kind` column deciding which half of the row is real — a table where half the columns
-- are always null is two tables wearing one name.
--
-- ── THE DRAWING IS THE PATHS, NOT A PICTURE ─────────────────────────────────────────────────────
-- ⚠️ A PNG would be nearly free and would be WRONG. It comes back as a flat sticker of chocolate: no
-- rope geometry, no gloss, not re-colourable, soft when scaled, and it can never stand up. The whole
-- reason a garnish looks like chocolate is that it is built the same way the pen builds chocolate, and
-- an image throws that away to save a column. The PNG here is the THUMBNAIL — the tile in the picker —
-- and is rendered FROM the paths, so it is a true sample of the piece rather than a drawing of one.
--
-- ── AND THE FILL IS NOT STORED ──────────────────────────────────────────────────────────────────
-- ⚠️ `payload` holds the outline strokes and the NAME of each one's fill pattern, never the generated
-- fill paths. Two reasons. It is most of the size: a scribble on a modest shape is hundreds of
-- generated points where the outline that produced it is twenty. And the fill is deterministic from a
-- seed, so it reproduces exactly — which means a later improvement to the fill generator improves
-- every piece already saved. `v` is the guard on the other side of that: if the generator ever changes
-- in a way that must NOT reach old pieces, the version says which recipe a payload was drawn for. It
-- costs nothing now and cannot be added cheaply later.
--
-- Shape of `payload` (v1):
--   { "v": 1, "plate": 420, "rope": 6, "color": "#4A2C1B",
--     "strokes": [ { "path": [[x, y], …], "fill": "hatch" | null }, … ] }
-- Coordinates are in the studio's own plate units (0…plate), not world units: a piece is a SHAPE, and
-- how big it comes out on a cake is decided when it is placed.

create table if not exists baker_garnishes (
  id               bigserial   primary key,

  -- TENANCY — whose bakery's world this lives in. Not authorship. (baker_uploads convention.)
  baker_id         uuid        not null references bakers (id) on delete cascade,

  -- AUTHORSHIP — who drew it. Same compact surrogate as baker_uploads.uploaded_by_type
  -- (1 = baker_appuser, 2 = customer), so the two tables answer "who made this" the same way.
  created_by_type  smallint    not null,
  created_by_id    uuid        not null,

  -- WHOSE piece it is: the customer whose design context it was drawn in. NULL for the baker's own.
  -- Same meaning, and the same deliberate silence about who is depicted, as baker_uploads.
  for_customer_id  uuid        references customers (id) on delete cascade,

  name             text        not null,

  -- The drawing. See the note above: outlines + fill NAMES, never generated fill paths.
  payload          jsonb       not null,

  -- The tile in the picker, rendered from `payload`. Nullable: a piece is usable without one, and a
  -- failed thumbnail must not cost the baker the drawing they just made.
  thumb_key        text,

  created_at       timestamptz not null default now(),

  -- Soft delete, for the same reasons as uploads: moderation and erasure both want a trail, and a hard
  -- delete leaves none. ⚠️ Also because a DESIGN carries its own copy of the paths — deleting a garnish
  -- from the library must never change a cake that was already made with it.
  deleted_at       timestamptz
);

-- HOT PATH — "my garnishes" for one tenant, newest first. Partial: deleted rows are never listed.
create index if not exists baker_garnishes_tenant_idx
  on baker_garnishes (baker_id, created_at desc) where deleted_at is null;

-- The owner's own shelf, which is what the picker actually asks for.
create index if not exists baker_garnishes_owner_idx
  on baker_garnishes (baker_id, created_by_type, created_by_id) where deleted_at is null;

-- ⚠️ A CAP, because `payload` is user-generated and unbounded. A dense scribble on a large shape is a
-- lot of points, and nothing else stops one row from being a megabyte. 256 KB is far above any real
-- piece (a filled leaf measures in single-digit KB) and far below anything that would hurt.
alter table baker_garnishes drop constraint if exists baker_garnishes_payload_size;
alter table baker_garnishes add  constraint baker_garnishes_payload_size
  check (pg_column_size(payload) <= 262144);

-- Verify:
--   select id, name, jsonb_array_length(payload->'strokes') as strokes, pg_column_size(payload) as bytes
--     from baker_garnishes where deleted_at is null order by created_at desc;
