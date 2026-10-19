-- ── The copy of a 2D decoration the CAKE is drawn from ───────────────────────────────────────────
--
-- A 2D sticker's `image_url` is its master: the full-resolution artwork, and the thing an edible
-- print is made from. The A4 sheet exports at 300 dpi, so 1024 px is 87 mm of printed decoration —
-- there is no headroom there to give away, and this column does not touch it.
--
-- ⚠️ THE COST OF A PICTURE ON A GPU HAS NOTHING TO DO WITH ITS FILE SIZE, which is the fact that
-- makes this worth a column. A 1024² sticker is maybe 300 KB of WebP on the wire and
-- 1024·1024·4·1.33 ≈ 5.3 MB of decoded RGBA once it is uploaded as a texture. Measured on a cake
-- with one relief sticker: 8.3 MB resident for that one decoration. At 512² the same arithmetic
-- gives 1.3 MB — a QUARTER, because the memory scales with area and the area is a square.
--
-- A busy cake is ten or twenty of these, and the device we are sized for is a 3 GB phone
-- (ASSET_OPTIMIZATION_PLAN.md §3, Floor B). Rendering at 512 is the single largest saving available
-- and nobody can see it: a decoration occupies a few hundred pixels of a phone screen.
--
-- ⚠️ A COLUMN, NOT A NAMING RULE. The key is derivable — `<master>` → `<master>-512.webp`, the same
-- suffix convention `thumb_key` has used since migration 031's `-256.webp` — so the renderer COULD
-- just compose it. It must not: a miss is a 404, and a 404 is a decoration that does not appear.
-- Null here means "no small copy exists, draw the master", which is correct on the day this lands
-- (every row is null) and correct for the cases that will never have one — a GLB, an SVG, a
-- calendar that carries no artwork at all.
--
-- ⚠️ NAMED FOR THE JOB, NOT FOR THE NUMBER. `render_key` is "the one the cake is drawn from"; if
-- 512 turns out to be 768 on a later device floor, the value changes and nothing is renamed. A
-- column called `image_512_key` would have to lie or be migrated.
--
-- Written by the API at ingest, never by hand: routes/elements.js → ensureRenderKey, the same
-- fire-and-forget shape ensureThumbKey already uses, so every path that creates an element — admin
-- upload, a baker's own decoration, a promotion import — gets one without a second copy of the rule.

alter table cake_elements add column if not exists render_key text;

comment on column cake_elements.render_key is
  'R2 key of the small (<=512 px) WebP copy of image_url that the 3D cake is TEXTURED from. Null = none exists, draw image_url instead. Never used for printing: an edible sheet is always made from the master (see chefsdesk/a4/cutoutSource.js).';
