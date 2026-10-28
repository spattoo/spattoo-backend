-- ── 146: the baker dresses the room they design in ───────────────────────────────────────────────
--
-- The take panels already let a baker choose a ground colour, a graded backdrop and a grid floor
-- for a video. None of it survived the panel closing. Sandeep: "now the samething we should also
-- give as baker settings. so a baker can customize the studio. we would save these settings and the
-- baker would see theie selected look&feel."
--
-- ── WHY baker_appusers AND NOT bakers ───────────────────────────────────────────────────────────
-- Migration 120 argued this for the rail skin, borrowing 060's wording for the designer tour: "a
-- tour is a fact about a PERSON, not about a bakery." So is the room you like working in. `bakers`
-- is the shop; two people in one shop can disagree about a backdrop and both be right.
--
-- It is also what keeps this clear of `storefront_theme_id`, which is per-BAKERY and
-- CUSTOMER-FACING. A customer never sees this room: it is the editing canvas and the baker's own
-- take panels, and nothing else. Thumbnails and photos render on alpha with no ground at all.
--
-- ── WHY ONE jsonb AND NOT SIX COLUMNS ───────────────────────────────────────────────────────────
-- ⚠️ THIS IS A PREFERENCE, NOT MASTER DATA, which is the line root CLAUDE.md rule 3 draws. The
-- rule says every value an ADMIN would tune is seeded in code and overlaid from the DB — and the
-- things this picks FROM are exactly that: the ground palette (`TAKE_GROUNDS`) and the backdrop
-- looks are authored in core and would become rows the day an admin wants to tune them. What a
-- PERSON chose out of that palette is not master data, and giving it six columns would mean a
-- migration every time the take panel grows a dial.
--
-- The shape is validated in core (`studioLook.js` `normaliseStudioLook`), field by field, on the
-- way in and on the way out — because a jsonb column accepts anything and a bad value here does
-- not throw, it paints the room a colour nobody chose.
--
--   { "ground": "#2b2b2b" | null,   -- null (and the default) means the plain editing room
--     "backdrop": "flat" | "sweep" | "pool" | "duo",
--     "backdropStrength": 0..1,
--     "grid": bool, "gridWall": bool, "gridStrength": 0.05..1 }
--
-- ⚠️ NULL IS THE DEFAULT AND MEANS "LEAVE IT ALONE", not "a look that happens to match today's
-- constants". A baker who never opens the setting must see exactly the room they saw yesterday, and
-- the editing floor's painted horizon stays theirs until they choose otherwise.

BEGIN;

ALTER TABLE public.baker_appusers
  ADD COLUMN IF NOT EXISTS studio_look jsonb;

COMMENT ON COLUMN public.baker_appusers.studio_look IS
  'The room this person designs in: ground colour, backdrop look and grid, chosen in Settings. '
  'NULL = the plain editing studio. Validated in core/src/designer/studioLook.js — see migration 146.';

COMMIT;
