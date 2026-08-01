-- ── 032: what a decoration is MADE OF ───────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── MATERIAL ONLY. TECHNIQUE ALREADY EXISTS. ────────────────────────────────────────
-- A first draft of this column mixed the two and listed 'piped' as a medium. That is wrong twice
-- over:
--
--   1. HOW a decoration is made is already in element_types — 'Cream Piping' and 'Palette knife
--      art' are separate types, and inspirationMaps.TYPE_MAP already routes on them. Repeating it
--      here creates a second place to disagree about the same fact.
--   2. It does not even hold: cream is not always piped. Palette-knife work is cream, spread with
--      a knife, and a 'piped' medium would have no way to say so.
--
-- So: medium answers WHAT IT IS MADE OF. The element's type answers how it is worked. A cream
-- rosette and cream palette-knife flowers share a medium and differ in type; a fondant bow and a
-- piped bow share a type family and differ in medium.
--
-- ── WHERE IT MATTERS ────────────────────────────────────────────────────────────────
-- Really only for STICKERS and toppers — flat placeables. A 'Cream Piping' element's material is
-- not in question, which is why this is nullable rather than required: the ambiguity is confined
-- to the 2D images where a picture alone genuinely cannot tell you whether it is fondant, an
-- edible-paper print, or an acrylic topper.
--
-- ── WHAT IT DECIDES, AND WHAT IT MUST NOT ───────────────────────────────────────────
-- It gates in ONE direction only, because the two media are not symmetric.
--
--   fondant        BOTH paths. Modelling guide AND print at actual size — a baker may look at a
--                  hand-modelled decoration and decide to print it instead, for time, for a
--                  customer's budget, or because the cake is going 400km in a car. That choice is
--                  theirs, made with the customer and often after the order is placed.
--   edible_paper   PRINT ONLY. There is no hand-modelled version of a printed sheet, so offering
--                  a modelling guide would be offering a way to make something that does not
--                  exist.
--   acrylic        NEITHER. It is bought, not made.
--   cream,
--   chocolate      Modelling guide once a format exists for them; the fondant guide format is
--                  written for sugar paste and would read wrongly here.
--   null           Offer both and let the model answer. It self-reports when something is not
--                  hand-made — empty steps and a tip saying so — which is why an unset medium is
--                  safe rather than a blocker.
--
-- The asymmetry is the point and it is easy to get backwards. Restricting a FONDANT element to
-- modelling would take away a substitution bakers make constantly; offering modelling on an
-- EDIBLE_PAPER one would invent a process. Neither is a matter of taste.

alter table cake_elements add column if not exists medium text;

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'cake_elements_medium_chk') then
    alter table cake_elements drop constraint cake_elements_medium_chk;
  end if;
  alter table cake_elements add constraint cake_elements_medium_chk
    check (medium is null or medium in (
      'fondant',       -- and gumpaste; hand-modelled sugar paste
      'cream',         -- buttercream/whipped. Piped OR palette-knifed — see element_types
      'chocolate',     -- modelling chocolate, transfers, shards
      'edible_paper',  -- printed icing/wafer sheet. The MATERIAL; "edible print" is what you do
      'acrylic',       -- and other non-edible toppers
      'other'
    ));
end $$;

comment on column cake_elements.medium is
  'MATERIAL only — technique lives in element_types (Cream Piping vs Palette knife art), and cream is not always piped. Mainly meaningful for stickers/toppers, where an image alone cannot say fondant vs edible paper vs acrylic. An admin HINT for what to pre-build, NEVER a gate on what a baker may do: the same 2D image can be printed or modelled and that choice is the baker''s. Null = not stated.';
