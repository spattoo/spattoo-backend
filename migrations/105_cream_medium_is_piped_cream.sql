-- ── 105: the cream row describes PIPED cream, so it should say so ───────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHAT THE LABEL WAS CLAIMING ─────────────────────────────────────────────────────────────────
-- `cream` was labelled "Buttercream / whipped" with can_model = false and can_print = false, which
-- admin renders as "Buttercream / whipped — no guide, no print". Read plainly, that says buttercream
-- is a material nobody hand-makes anything from. It is not: a palette-knife flower is buttercream,
-- hand-made one petal at a time, and 104 gave it a guide.
--
-- Sandeep: *"using cream we can do many things like palette knife which needs guide."*
--
-- The two booleans were never wrong about the case they were written for — PIPED cream, whose
-- guidance is the nozzle recommendation and not a build sheet. The LABEL was wrong, because it
-- named the material and described the technique's consequence.
--
-- ⚠️ THIS IS THE ONE PLACE TECHNIQUE APPEARS IN A MATERIAL LABEL, AND IT IS DELIBERATE. Migration
-- 032's rule stands — material in `decoration_mediums`, technique in `element_types` — and the
-- palette-knife guide follows it: its technique note lives on the TYPE (104) and it reads no medium
-- at all. What changes here is only what the row CALLS ITSELF, so an admin choosing it is told which
-- cream they are choosing. A label that produces a wrong inference is not neutral just because the
-- columns behind it are correct.
--
-- Nothing in code reads `label` for a decision. `decorationPolicy` reads can_model / can_print, and
-- the prompt reads build_note.

update decoration_mediums set
  label      = 'Cream piping',
  build_note = 'Buttercream or whipped cream piped through a shaped nozzle: the tip and the hand '
               'movement are the decoration. Cream worked ANY OTHER WAY is a different craft — '
               'palette-knife work is pressed and dragged with a blade and carries its own '
               'technique note on the element type (migration 104).'
where key = 'cream';

-- The legacy key means the same thing and is kept only because the column already holds it. Said
-- here too, so the two rows do not drift into describing different crafts.
update decoration_mediums set
  label      = 'Cream piping (legacy key)',
  build_note = 'Retained because the column already holds this value. Same material and the same '
               'technique as `cream`; prefer `cream` for new elements.'
where key = 'piped';

select key, label, can_model, can_print, guide_format from decoration_mediums order by sort_order;
