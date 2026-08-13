-- Add cake_elements.thumb_key: R2 key of the optimised WebP picker thumbnail
-- (<=256px, q80, served DIRECT — no /cdn-cgi/image transform).
--
-- The existing thumbnail_url column is RETAINED unchanged as the full-res raw
-- source (re-thumbnail source, esp. for 3D renders). thumb_key is the field the
-- picker reads going forward. Additive + nullable until backfilled.
--
-- Backfill existing rows with:  node scripts/backfillThumbnails.mjs
alter table public.cake_elements
  add column if not exists thumb_key text;

comment on column public.cake_elements.thumb_key is
  'R2 key of the optimised WebP picker thumbnail (<=256px, served direct). Full-res raw source kept in thumbnail_url.';
