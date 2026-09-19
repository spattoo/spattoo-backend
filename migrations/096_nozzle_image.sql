-- ── 096: a picture of the nozzle, and a human who says it is the right one ───────────────────────
--
-- The X-Ray report tells a baker which nozzle to reach for by its MODEL NUMBER — "Wilton 1M/32".
-- That is precise and it is useless at 6am if you own the tip but have never learned its number.
-- Nozzles are recognised by their SHAPE: the star's teeth, the petal's flattened slot. So the
-- catalogue gets a photograph, and eventually the report shows it beside the number.
--
-- ── Why a second image column, and not the one already here ──────────────────────────────────────
-- `sample_image_url` (see supabase/nozzles_table.sql) was added for a DIFFERENT picture: a sample of
-- what the nozzle PIPES, for a future baker learning screen. A photo of the tool and a photo of its
-- output answer different questions and a learning screen would want both, side by side. Overloading
-- one column with either-of-two-meanings is how a column stops being answerable. That one stays
-- empty and reserved; this one is the nozzle itself.
--
-- ── Why a key and not a URL ──────────────────────────────────────────────────────────────────────
-- Same as every other asset column (see migration 068): the row stores the R2 OBJECT KEY and the API
-- expands it with toPublicUrl on read. A stored absolute URL bakes today's asset host into the
-- database. ⚠️ It is also a security boundary — the write path accepts only a key under
-- `nozzles/images/`, because a column that is expanded on read will pass an absolute URL through
-- untouched, which is exactly how a third-party image gets rendered inside our own catalogue.
--
-- ── Why an approval at all ───────────────────────────────────────────────────────────────────────
-- This catalogue is internal-admin curated, so the usual argument for a review step ("a model wrote
-- it") does not apply. The argument here is narrower and it is about the PICTURE, not the row: a
-- nozzle photo is only worth showing if the tip is legible, and whether a tip is legible cannot be
-- validated by any check — someone has to look. 121 rows will be filled in over time, from mixed
-- sources, and a half-filled catalogue must be able to say which pictures are ready to show.
--
-- ⚠️ Replacing the image CLEARS the approval (enforced in routes/nozzles.js, not by a constraint).
-- Otherwise the tick survives a swap and vouches for a picture nobody has seen.
--
-- ⚠️ `image_approved_by` has NO foreign key, deliberately. Every other `_by` column in this schema
-- references `baker_appusers`, but admins are not baker app-users and carry no baker context — an FK
-- there would be unfillable by exactly the people who use this screen. It holds the Supabase auth
-- user id, which is the only identity an admin request carries.
--
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.

ALTER TABLE public.nozzles
  ADD COLUMN IF NOT EXISTS image_key         text,
  ADD COLUMN IF NOT EXISTS image_approved    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS image_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS image_approved_by uuid;

COMMENT ON COLUMN public.nozzles.image_key IS
  'R2 object key for a photograph of the nozzle and its tip (folder nozzles/images), uploaded in '
  'admin and stored as a downscaled WebP. NULL = no picture yet, which is the starting state of '
  'every row. Expanded to a URL by toPublicUrl on read, never stored as one. Distinct from '
  'sample_image_url, which is reserved for a picture of what the nozzle PIPES.';

COMMENT ON COLUMN public.nozzles.image_approved IS
  'A human has looked at image_key and confirmed the nozzle and its tip are clearly visible. Only an '
  'approved picture may be shown outside admin. Reset to false whenever image_key changes, so the '
  'tick can never vouch for a picture nobody reviewed.';

COMMENT ON COLUMN public.nozzles.image_approved_at IS
  'When the current image was approved. NULL whenever image_approved is false.';

COMMENT ON COLUMN public.nozzles.image_approved_by IS
  'Supabase auth user id of the admin who approved the current image. Deliberately NOT a foreign key '
  'to baker_appusers: admins are not baker app-users and have no baker context.';

-- Partial index: the only question asked outside admin is "which nozzles have a picture we may
-- show", and that is a small slice of the table.
CREATE INDEX IF NOT EXISTS nozzles_image_approved_idx
  ON public.nozzles (image_approved)
  WHERE image_approved;
