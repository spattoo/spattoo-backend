-- ── 104: a palette knife is not a piping bag ────────────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHAT WENT WRONG ─────────────────────────────────────────────────────────────────────────────
-- A buttercream flower pressed with a palette knife ("Piping flower", type `palette_knife_art`) had
-- no way to get a build guide in admin. `decorationPolicy` refused it:
--
--     const CREAM_TYPES = new Set(['Cream Piping', 'Palette knife art']);
--     if (CREAM_TYPES.has(type)) return { modelling: false, print: false,
--                                         reason: 'cream — nozzle guide covers this' };
--
-- The reason is true of piping and FALSE of palette-knife work. A nozzle recommendation answers
-- "which tip pipes this border"; it says nothing about loading a knife with a thin layer of cream,
-- pressing and dragging it from the outer edge to the centre, and leaving a raised edge with a
-- scraped middle. Two different crafts sharing one material.
--
-- The code even said so, in the comment directly above the refusal: *"palette-knife work needs a
-- guide format of its own, and the fondant one is written for sugar paste and would read wrongly."*
-- It was a known gap with no ticket and no route to being noticed except somebody opening one.
--
-- ── WHY A COLUMN ON element_types AND NOT ON decoration_mediums ─────────────────────────────────
-- Migration 032's rule, restated by 101: `medium` is MATERIAL, `element_types` is TECHNIQUE.
-- 'Cream Piping' and 'Palette knife art' are the SAME material worked two ways, which is exactly
-- why the material column cannot carry the answer — `cream.build_note` has to describe both at
-- once, and today it does: *"piped through a nozzle or spread and shaped with a palette knife."*
-- That sentence is useless to a guide prompt, because it names two crafts and picks neither.
--
-- So the technique note goes where the technique already lives. The guide prompt then reads BOTH:
-- the material's note for how the stuff behaves, the type's note for how it is worked.
--
-- ⚠️ AND IT IS AUTHORED, NOT COMPILED IN. Same rule as 101: a technique described in code needs a
-- deploy to correct, and the person who knows it is wrong is an admin looking at a bad guide.

alter table element_types add column if not exists build_note text;

comment on column element_types.build_note is
  'How a decoration of this TYPE is worked — the technique, fed to the build-guide prompt beside '
  'the material''s own note. Material lives in decoration_mediums; this is the other half. Null '
  'means the type says nothing about technique and the material note stands alone.';

-- ── The two cream techniques ────────────────────────────────────────────────────────────────────
-- Only the types whose technique the prompt would otherwise get WRONG are seeded. A note that
-- merely restates what the picture already shows is noise in a prompt, and every line here is a
-- line the model must weigh.
update element_types set build_note =
  'Buttercream or whipped cream, PRESSED AND DRAGGED WITH A PALETTE KNIFE — never piped. Load the '
  'flat of a small palette knife or the back of a spoon with a thin layer of cream, press it down '
  'at the outer tip of the petal and pull towards the centre in one stroke, lifting as you go. That '
  'leaves the signature of the craft: a raised, slightly ragged outer edge and a thin scraped '
  'middle where the blade lifted. Petals are built one at a time, overlapping, working from the '
  'outside of the flower inwards. Use a crusting buttercream stiff enough to hold the ridge; if it '
  'slumps, chill it briefly. Work on parchment or a flower nail and chill until firm before lifting '
  'onto the cake. Do NOT describe nozzles, tips or piping bags — they are the wrong tools for this.'
where slug = 'palette_knife_art';

update element_types set build_note =
  'Buttercream or whipped cream piped through a shaped nozzle. The tip and the hand movement ARE '
  'the decoration, so the useful guidance is which nozzle and what consistency — which Spattoo '
  'answers with a curated nozzle recommendation, not a written build sheet.'
where slug = 'cream_piping';

-- Read back, so applying this by hand shows what it did.
select slug, name, left(build_note, 60) as build_note
  from element_types where build_note is not null order by slug;
