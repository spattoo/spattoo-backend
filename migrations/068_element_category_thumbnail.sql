-- ── 068: a category's own picture ────────────────────────────────────────────────────────────────
--
-- The decorations menu shows a picture per category, because people recognise a lion far faster than
-- they read "Animals". Until now that picture was BORROWED: the category list picked the first
-- element in the category that happened to have a thumbnail (see GET /element-categories).
--
-- Borrowing works, and it stays as the fallback — a new category is never a blank square and nobody
-- has to make an image before a category can exist. But it can only ever show ONE decoration, and a
-- category is a collection. A hand-made collage of three or four of its elements says "this is the
-- sort of thing in here" in a way a single lion cannot.
--
-- So: an optional picture of the category's own, and the borrowed one when there isn't one.
--
-- ── Why a key and not a URL ──────────────────────────────────────────────────────────────────────
-- Same as every other asset column: the row stores the R2 OBJECT KEY and the API expands it with
-- toPublicUrl on read. A stored absolute URL bakes today's asset host into the database, and moving
-- the bucket then means an UPDATE across every row that mentions it. (toPublicUrl passes an absolute
-- URL through untouched, so an old row that already holds one keeps working.)
ALTER TABLE public.element_categories
  ADD COLUMN IF NOT EXISTS thumb_key text;

COMMENT ON COLUMN public.element_categories.thumb_key IS
  'R2 object key for this category''s own menu picture (folder categories/thumbnails), uploaded in '
  'admin. NULL = borrow the first element in the category that has a thumbnail, which is what the '
  'menu did before this column existed. Expanded to a URL by toPublicUrl on read, never stored as one.';
