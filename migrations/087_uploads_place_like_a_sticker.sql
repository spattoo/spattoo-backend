-- ── 087: a placed upload behaves like a sticker, not like a standing topper ──────────────────────
--
-- Reported: tapping an uploaded image in the designer stood it UPRIGHT on the cake top, like a
-- cardboard topper on prongs. A picture is a flat thing — it should lie ON the surface, and a baker
-- should be able to stand it up if they want to, not be forced to.
--
-- ── WHY THIS IS DATA AND NOT CODE ───────────────────────────────────────────────────────────────
-- A directly-placed upload inherits its zones and its per-zone mode from whichever element_type is
-- flagged `default_for_uploads` (UploadsPanel.place → placement_rules). That row is `image_topper`,
-- and it said:
--
--     {"zones": ["top_surface","side"], "placement": {"side":"hug", "top_surface":"stand"}}
--
-- `top_surface: stand` is the whole bug. Nothing in the renderer was wrong.
--
-- ⚠️ MULTIPLE MODES PER ZONE ARE ALREADY SUPPORTED, and were simply not used here. placement.js
-- documents the three shapes it accepts:
--
--     "top_surface": "stand"                        → ['stand']
--     "top_surface": { "mode": "stand" }             → ['stand']
--     "top_surface": { "modes": ["stand","hug"] }    → ['stand','hug']   ← FIRST ONE IS THE DEFAULT
--
-- So this needs no renderer change and no new vocabulary: it uses the form that was always there.
-- `hug` is listed first on the top because a picture lying flat is the ordinary case and standing it
-- up is the exception — the baker can still pick either.
--
-- ── The zones ───────────────────────────────────────────────────────────────────────────────────
-- top_surface, side and board: the three places a flat printed or drawn piece actually goes. We do
-- not know what any given upload IS — that is exactly why it inherits a permissive default rather
-- than an authored one — so withholding a zone would be guessing on the baker's behalf.
--
-- `rim` and `middle_tier` are deliberately NOT included. They are not "one fewer zone"; they carry
-- their own geometry (a rim piece straddles an edge, a middle tier is a specific wall) and a picture
-- dropped there with no authored placement would land somewhere odd. Add them when something asks
-- for them, with a placement that means something.
--
-- Only `image_topper` is touched, and only its placement_rules. Any element type an admin authored
-- deliberately keeps whatever they set.

update element_types
   set placement_rules = jsonb_build_object(
         'zones',     jsonb_build_array('top_surface', 'side', 'board'),
         'placement', jsonb_build_object(
           -- hug first: flat on the cake is what a picture does. stand stays available.
           'top_surface', jsonb_build_object('modes', jsonb_build_array('hug', 'stand')),
           'side',        'hug',
           -- On the board there is nothing to lie against, so standing is the sensible default —
           -- placement.js already coerces a board `hug` to `stand` for exactly this reason.
           'board',       jsonb_build_object('modes', jsonb_build_array('stand', 'hug'))
         )
       )
 where default_for_uploads is true;

-- Expect one row, and a top_surface that offers hug first.
select slug, name, placement_rules
  from element_types
 where default_for_uploads is true;
