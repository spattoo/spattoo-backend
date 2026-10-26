-- ── Sand: Biscuit by default, and the board gets its own span ───────────────────────────────────
--
-- Sandeep, on the sand card: *"for sand can you set the default size around 30%"*, and *"set
-- default colour is Biscuit"*.
--
-- ⚠️ THE ROW IS WHERE A DEFAULT LIVES. Both of these are values an admin must be able to retune in
-- Manage Elements without a deploy (rule 3). Core carries the same two numbers as the SEED a row
-- with nothing authored falls back to — SAND_COLORS.biscuit and SAND_PLACEMENTS — and they are set
-- together here so the two cannot disagree.
--
-- ── Why `size` is authored PER SURFACE and not once ─────────────────────────────────────────────
-- `sandSpan` reads it differently on each, and the two are not comparable numbers:
--
--     top     outerFrac = size         the patch reaches `size` of the cake's own reach
--     board   outerFrac = 1 + size     the ring starts AT the cake's edge and reaches `size` BEYOND
--
-- So the top's 0.8 — chosen by eye, and recorded in 134 as generous on purpose because 0.55 "reads
-- as a mistake" — becomes a collar nearly as wide as the cake once it is carried onto the board.
-- That is exactly what happened: the designer moved the drift untouched, and the 30% asked for here
-- is the board's own answer, not a correction to the top's. The top is deliberately UNCHANGED.
--
-- `placement_config.sand.zones` mirrors `placement_config.gyp.zones`, which solved the same problem
-- first for a filler that sits on four surfaces. One spelling, not two.
--
-- Idempotent: keyed on the name, and it overwrites only these two values.

BEGIN;

-- Biscuit. The palette itself is unchanged — this only moves which entry a new drift starts on.
update public.cake_elements
   set default_color = '#c89a63'
 where name = 'Sand';

-- Per-surface span. jsonb_set would need the path to exist; a merge is simpler and does not care.
update public.cake_elements
   set placement_config = coalesce(placement_config, '{}'::jsonb)
     || jsonb_build_object(
          'sand',
          coalesce(placement_config->'sand', '{}'::jsonb)
            || jsonb_build_object(
                 'zones', jsonb_build_object(
                   -- Unchanged from 134, written explicitly so both surfaces are visible in one place.
                   'top',   jsonb_build_object('size', 0.8),
                   'board', jsonb_build_object('size', 0.3)
                 )
               )
        )
 where name = 'Sand';

COMMIT;

-- Verify:
--   select name, default_color,
--          placement_config->'sand'->'zones' as zones
--     from public.cake_elements
--    where name = 'Sand';
