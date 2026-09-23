-- ── 106: the catalogue's fondant hearts are red again ───────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run — see IDEMPOTENT below.
--
-- ── WHY A TEMPLATE'S HEART TURNED WHITE ─────────────────────────────────────────────────────────
-- The fondant heart GLB carries its artwork as baked vertex colours (`COLOR_0`, mean #bd0101).
-- three.js MULTIPLIES a material's colour by those, so whatever colour the designer asked for, the
-- heart rendered RED. Anyone authoring a template saw red and kept it.
--
-- spattoo-core fixed that on 2026-09-22: a recolourable element's baked hue is neutralised at load,
-- so the chosen colour finally arrives. Which means every heart placed during the broken period now
-- renders the colour that was actually stored — #F0DEB8, the element's default at the time — and
-- two catalogue templates went from red hearts to cream ones. Reported with screenshots:
-- "Anniversary cake" and "love".
--
-- The rows were wrong the whole time. Nothing about them changed; they simply became visible.
--
-- ── SCOPED BY RULE, NOT BY ID ───────────────────────────────────────────────────────────────────
-- Three things must all be true for a sticker to be touched:
--
--   1. it is THE fondant heart                    (elementId)
--   2. it holds the element's OLD DEFAULT         (#F0DEB8)
--   3. its template is OURS                       (baker_id is null)
--
-- (2) is what protects deliberate choices: a heart someone set to #ffffff on the "YOU & ME"
-- template, or to #bf3131 on another, is a decision and is left exactly as it is. (3) is the line
-- between the catalogue and a bakery's own work — one baker's "love" template has the same ten
-- cream hearts, and rewriting it is not ours to do. Sandeep: *"if its not catalogued, we dont have
-- to worry."*
--
-- Scoping by rule rather than by two template ids also means this is correct on prod without
-- knowing what prod holds.
--
-- ── THE TARGET COLOUR IS WRITTEN OUT, NOT READ FROM THE ELEMENT ─────────────────────────────────
-- `cake_elements.default_color` is #c41c1c on dev because it was corrected there by hand. Prod may
-- still hold the old cream, and reading it would turn this migration into a silent no-op that looks
-- like it worked — cream replaced by cream. The colour the hearts are meant to be is a fact about
-- these templates, so it is stated here.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────────────────────────────
-- The WHERE clause looks for stickers still holding the old colour, so a second run matches nothing
-- and updates no rows. Already applied to DEV by script on 2026-09-23 (2 hearts on "Anniversary
-- cake", 12 on "love"); running it there is a no-op and confirms as much.

update cake_templates t
set design = jsonb_set(
  t.design,
  '{stickers}',
  (
    select jsonb_agg(
      case
        when s->>'elementId' = 'e0d9180c-10ab-4e75-aa41-fa82773a6f52'
         and lower(s->>'color') = '#f0deb8'
        then jsonb_set(s, '{color}', to_jsonb('#c41c1c'::text))
        else s
      end
      -- ⚠️ ORDER BY, or jsonb_agg may hand the stickers back in a different order than it got them.
      -- A sticker's position in this array is its DRAW ORDER: shuffle it and a heart that sat in
      -- front of another can end up behind it. Nothing would error.
      order by ord
    )
    from jsonb_array_elements(t.design->'stickers') with ordinality as a(s, ord)
  )
)
where t.baker_id is null
  and jsonb_typeof(t.design->'stickers') = 'array'
  and exists (
    select 1
    from jsonb_array_elements(t.design->'stickers') s
    where s->>'elementId' = 'e0d9180c-10ab-4e75-aa41-fa82773a6f52'
      and lower(s->>'color') = '#f0deb8'
  );

-- Read back every catalogue template that uses the heart, and what colours its hearts now hold.
-- Expected after this runs: no '#F0DEB8' anywhere in the list.
select t.name,
       t.id,
       s->>'color' as heart_colour,
       count(*)    as hearts
from cake_templates t,
     jsonb_array_elements(t.design->'stickers') s
where t.baker_id is null
  and s->>'elementId' = 'e0d9180c-10ab-4e75-aa41-fa82773a6f52'
group by t.name, t.id, s->>'color'
order by t.name;
