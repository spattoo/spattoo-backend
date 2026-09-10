-- ── Card toppers: compositions someone made in the card topper studio and kept ──────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- ── WHY `baker_card_toppers` AND NOT `baker_toppers` ────────────────────────────────────────────
-- "Topper" already means four different things in this product: the `topper` element type (a GLB
-- standing on the cake), `image_topper` (a printed picture), number toppers, and acrylic toppers.
-- A table called `baker_toppers` would claim the general word for one particular kind, and the next
-- person would reasonably open it expecting the others. `baker_garnishes` gets away with the general
-- word because "garnish" has exactly one meaning here; "topper" does not.
--
-- If a single shelf for every kept topper is ever wanted, this becomes the narrow name and a `kind`
-- column arrives — a rename is a smaller cost than a table that lies about what is in it.
--
-- ── WHY NOT baker_garnishes WITH A `kind` COLUMN ────────────────────────────────────────────────
-- The columns genuinely would fit: both store a name, a JSON recipe and a thumbnail. But that file's
-- own argument is about MEANING rather than shape — a garnish is piped chocolate and a card topper is
-- a cut sheet, they are made by different studios, validated by different rules, and one of them will
-- grow columns the other never wants (a stick, an insertion depth). Two tables that happen to look
-- alike today is not the same as one thing.
--
-- ── WHAT IS STORED IS THE OBJECT LIST ───────────────────────────────────────────────────────────
-- ⚠️ THE WORDS, NEVER THE CUT CONTOURS. A topper is stored as "the word Mia, in this face, at this
-- size, on a heart" — not as the hundreds of points that word cuts into. The same call
-- baker_garnishes made about fills, for the same two reasons: it is most of the size, and it means a
-- later improvement to `topperShapes` or `offsetParts` reaches every topper already kept. `v` is the
-- guard on the other side — if a generator ever changes in a way that must NOT reach old pieces, the
-- version says which recipe a payload was drawn for.
--
-- ⚠️ AND IT IS NOT A PICTURE. A PNG comes back as a flat sticker: no card thickness, no offset layer
-- standing proud of the face, not re-colourable, never cuttable. The PNG here is the THUMBNAIL, and
-- it is rendered FROM the objects, so the tile is a true sample of the piece.
--
-- Shape of `payload` (v1):
--   { "v": 1, "objects": [
--       { "id": 1, "kind": "shape", "family": "heart", "size": 1.5, "x": 0, "y": 0,
--         "colour": "#F2AEC4", "offset": 0.06, "offsetColour": "#FFFFFF" },
--       { "id": 2, "kind": "text", "text": "Mia", "face": "__block", "size": 0.6, "x": 0, "y": 0,
--         "colour": "#4A2C1B", "offset": 0.06, "offsetColour": "#FFFFFF" } ] }
-- ORDER IS THE STACKING: later objects sit in front. Coordinates are the studio's own units — a
-- topper is a SHAPE, and how big it comes out on a cake is decided when it is placed.

create table if not exists baker_card_toppers (
  id               bigserial   primary key,

  -- TENANCY — whose bakery's world this lives in. Not authorship. (baker_uploads convention.)
  baker_id         uuid        not null references bakers (id) on delete cascade,

  -- AUTHORSHIP — who composed it. Same compact surrogate as baker_uploads.uploaded_by_type
  -- (1 = baker_appuser, 2 = customer), so every one of these tables answers "who made this" alike.
  created_by_type  smallint    not null,
  created_by_id    uuid        not null,

  -- WHOSE piece it is: the customer whose design context it was made in. NULL for the baker's own.
  for_customer_id  uuid        references customers (id) on delete cascade,

  name             text        not null,

  -- The composition. See above: the words and the shapes, never the contours cut from them.
  payload          jsonb       not null,

  -- The tile in the picker, rendered from `payload`. Nullable: a piece is usable without one, and a
  -- failed thumbnail must not cost the baker the composition they just made.
  thumb_key        text,

  created_at       timestamptz not null default now(),

  -- Soft delete, for the same reasons as uploads and garnishes: moderation and erasure both want a
  -- trail. ⚠️ And because a DESIGN carries its own copy of the objects — removing a topper from the
  -- shelf must never change a cake that was already made with it.
  deleted_at       timestamptz
);

-- HOT PATH — "my card toppers" for one tenant, newest first. Partial: deleted rows are never listed.
create index if not exists baker_card_toppers_tenant_idx
  on baker_card_toppers (baker_id, created_at desc) where deleted_at is null;

-- The owner's own shelf, which is what the picker actually asks for.
create index if not exists baker_card_toppers_owner_idx
  on baker_card_toppers (baker_id, created_by_type, created_by_id) where deleted_at is null;

-- ⚠️ A CAP, because `payload` is user-generated and unbounded. Far smaller than the garnish's here:
-- a composition is a handful of objects with a word each, so a real one measures in hundreds of
-- BYTES. 64 KB is orders of magnitude above anything anyone would compose and well below anything
-- that would hurt. If this ever trips, the payload has started carrying contours — which is exactly
-- the thing the note above says it must never do.
alter table baker_card_toppers drop constraint if exists baker_card_toppers_payload_size;
alter table baker_card_toppers add  constraint baker_card_toppers_payload_size
  check (pg_column_size(payload) <= 65536);

-- Verify:
--   select id, name, jsonb_array_length(payload->'objects') as objects, pg_column_size(payload) as bytes
--     from baker_card_toppers where deleted_at is null order by created_at desc;
