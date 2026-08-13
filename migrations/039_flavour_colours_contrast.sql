-- ── 039: seven slices that read as a solid block ────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run, and a
-- no-op on any database where 038 seeded the corrected values in the first place.
--
-- ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────────────
-- 038 shipped with seven colour pairs whose sponge and filling were too close to
-- separate when actually drawn: Belgian Dark, Chocolate Truffle, Coconut, Litchi,
-- Rasmalai, Vanilla and White Forest rendered as a single flat rectangle. That does not
-- read as a subtle cake, it reads as a broken renderer — the layers are simply missing.
--
-- The pairs were corrected in 038 before it was committed, but by then the file had
-- already been applied once with the original values. 038's seed is deliberately
-- COALESCE-guarded and skips any row whose colours are already set, so that re-applying
-- it can never stomp a colour someone has since corrected in admin. That guard did
-- precisely its job here and, on this one occasion, kept the wrong values.
--
-- Hence a separate migration rather than an edit to 038: a file that has already run
-- somewhere cannot be relied on to run again.
--
-- ── WHY IT IS SAFE ──────────────────────────────────────────────────────────────────
-- Each row is matched on BOTH its name and the exact superseded value. So it corrects
-- only rows still holding what the first seed wrote, and silently skips:
--   • a database where 038 seeded the corrected values (nothing matches)
--   • any flavour whose colours a human has since changed in admin — their judgement
--     against a real slice beats this file's, which is the same principle 038 encoded.

BEGIN;

WITH fix(name, old_sponge, old_filling, new_sponge, new_filling) AS (VALUES
  ('belgian dark',      '#3B2415', '#2A1810', '#3B2415', '#23130B'),
  ('chocolate truffle', '#3F2617', '#2E1A0E', '#3F2617', '#22110A'),
  ('coconut',           '#F6EFE0', '#F7F3EA', '#F3EAD6', '#FFFFFF'),
  ('litchi',            '#F5EBDA', '#F3E3E0', '#F7EFE2', '#E9C9CE'),
  ('rasmalai',          '#F6E9CC', '#F0DFC0', '#FBF3DA', '#EED9A0'),
  ('vanilla',           '#F6EAD0', '#F7F0DE', '#F2E3BC', '#FBF5E6'),
  ('white forest',      '#F6EDD9', '#E8DCC6', '#F7F0DE', '#DCC7A6')
)
UPDATE public.flavours f
   SET sponge_color  = fix.new_sponge,
       filling_color = fix.new_filling
  FROM fix
 WHERE lower(f.name) = fix.name
   AND upper(f.sponge_color)  = upper(fix.old_sponge)
   AND upper(f.filling_color) = upper(fix.old_filling);

DO $$
DECLARE flat int;
BEGIN
  -- Anything left where the two layers are still identical is invisible by definition,
  -- and worth naming rather than leaving to be noticed on the storefront.
  SELECT count(*) INTO flat FROM public.flavours
   WHERE is_active AND sponge_color IS NOT NULL AND sponge_color = filling_color;
  RAISE NOTICE '039: applied. % active flavour(s) still have identical sponge and filling.', flat;
END $$;

COMMIT;
