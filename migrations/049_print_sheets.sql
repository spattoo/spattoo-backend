-- ── 049: saved sheets for the Edible Print Studio ──────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/plans/edible-print-studio.md
--
-- ── WHY A TABLE ─────────────────────────────────────────────────────────────────────
-- A baker who prints the same name banner every week should not rebuild it every week.
-- Three ways to remember it, and only one survives:
--
--   localStorage    dies with the browser. A baker lays a sheet out on the shop iPad and
--                   it is gone from the laptop, gone after a cache clear, gone on a new
--                   device. "Saved" that silently is not saved.
--   a jsonb blob    one column on `bakers` holding every sheet. Rewrites the whole array
--   on `bakers`     to rename one sheet, has no per-sheet timestamp to sort a library by,
--                   and makes two staff saving at once a last-write-wins race that loses
--                   somebody's work with no trace it existed.
--   this table      a row per sheet, which is what a sheet is.
--
-- ── WHY NOT cake_templates ──────────────────────────────────────────────────────────
-- A saved sheet is NOT a template, and reusing that table would be the expensive kind of
-- convenient. A cake template is a 3D design — tiers, frosting, stickers, geometry — that
-- a baker OFFERS TO CUSTOMERS on a storefront. A print sheet is images arranged on paper
-- that never leaves the kitchen. They share no columns, no lifecycle and no audience.
--
-- Fusing them would half-null the table for both AND force the storefront's curated
-- template list to start filtering print sheets out of what it shows customers — the
-- precise leak `invite_design_snapshot.sql` was written to avoid, arrived at from the
-- other direction.

create table if not exists print_sheets (
  id          bigserial   primary key,

  -- TENANCY — whose bakery's sheet this is. Every staff member of that bakery sees it:
  -- a print sheet is a shop-floor document, not private work, and the studio is reached
  -- from Chef's Desk which already requires store:manage.
  --
  -- No authorship column, deliberately. baker_uploads carries `uploaded_by_*` because
  -- who uploaded an image decides WHO MAY SEE IT; here there is no such question, so a
  -- column recording it would exist only to be read by nobody. If attribution is ever
  -- wanted it is a nullable add with no backfill — the cheap direction to be wrong in.
  baker_id    uuid        not null references bakers (id) on delete cascade,

  name        text        not null,

  -- THE LAYOUT. [{ uploadId, maskUrl, transform, x, y, w, h }] — see A4Sheet.jsx for the
  -- units (x of the sheet's width, y of its height, w and h BOTH of its width).
  --
  -- `uploadId`, NOT a url, and this is the one decision here with teeth. A sheet outlives
  -- the session that made it. Storing urls means a baker who deletes an upload reopens a
  -- sheet with silently broken images and exports a PDF with a hole in it. An id lets the
  -- API resolve the CURRENT url and mark a missing one, so the sheet can say "this image
  -- was deleted" in the slot where it was — which a baker can act on.
  --
  -- No FK to baker_uploads and no cascade: deleting an image must not delete the sheets
  -- it appeared on. The sheet is still most of a layout, and losing the whole thing
  -- because one rose was tidied up would be the worst possible reading of the baker's
  -- intent. The dangling id IS the feature.
  items       jsonb       not null default '[]'::jsonb,

  -- The cake-fit guide as it was left { shape, w, h } in inches, or null for off. Saved
  -- so reopening restores what the layout was being checked AGAINST — without it a baker
  -- returns to a sheet whose sizes look arbitrary and has to remember which cake it was for.
  guide       jsonb,

  created_at  timestamptz not null default now(),
  -- Set by the API on every save (no trigger — this codebase has none, and one added here
  -- would be the only one). The library sorts on it, so a stale value shows a sheet in the
  -- wrong place rather than merely lying.
  updated_at  timestamptz not null default now()
);

-- HOT PATH — the studio's front door: this bakery's sheets, most recently worked first.
create index if not exists print_sheets_tenant_idx
  on print_sheets (baker_id, updated_at desc);

comment on table print_sheets is
  'Saved layouts for the Edible Print Studio (Chef''s Desk). One row per sheet. items[].uploadId '
  'references baker_uploads WITHOUT a foreign key on purpose — a deleted image leaves a hole in the '
  'sheet, it does not delete the sheet. Not a cake_template: a template is a 3D design offered to '
  'customers, this is paper that never leaves the kitchen.';

-- No row cap here. The ceiling is enforced in the API (same reasoning as max_custom_elements:
-- a sheet costs essentially nothing to store, so a limit that bites is an arbitrary limit that
-- only generates support tickets — it exists so the write path is not unbounded, not to price
-- anything). A CHECK constraint could not express "per baker" anyway.

-- No soft delete. baker_uploads has `deleted_at` because an image may need removing for MODERATION
-- or ERASURE and both want a trail. A sheet holds no content of its own — only ids pointing at
-- images that carry their own erasure — so deleting one is a baker tidying their own desk, and
-- keeping a tombstone of it would be recording something nobody will ever ask about.
