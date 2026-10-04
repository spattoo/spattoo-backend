-- ── 121: the default skin must BE the rail, not a near-miss of it ────────────────────────────────
--
-- Sandeep: "lets stil keep the cuurect black spatula as the default one."
--
-- It already was the default — free, is_default, and the thing every downgrade falls back to. What
-- it was not, is IDENTICAL. 120 seeded chrome with four stops:
--
--     #121214 #08080a #08080a #020203
--
-- and spattoo-core's renderer spreads a row's stops evenly, so those land at 0 / 0.333 / 0.667 / 1.
-- The rail's own gradient is shared/chrome.js, which is THREE stops at 0 / 0.5 / 1. Same colours,
-- different curve: the seeded version holds the mid tone a third longer and ramps late. Nobody would
-- have called it wrong, and it would have been a different rail the moment the DB answered — on
-- every baker, including the ones who never choose a skin.
--
-- ⚠️ CORRECTED FORWARD, NOT EDITED. 120 is applied on dev. Migration 015 states the rule and 016 is
-- the worked example: "do NOT edit an applied migration; correct forward."
--
-- ⚠️ THE REAL LESSON IS THE DUPLICATION, not the offsets. shared/chrome.js's own header says an
-- approximation of this surface "would be wrong by definition" — panel headers render it as CSS and
-- the spatula as SVG, and they only match because both read one definition. Writing the stops into
-- a seed made a third copy, by hand, and it was wrong on the first try. check:rail-skins now asserts
-- the default row against those three colours so the next hand-copy fails the build.

BEGIN;

update public.rail_skins
   set stops = '["#121214","#08080a","#020203"]'::jsonb
 where key = 'chrome';

COMMIT;
