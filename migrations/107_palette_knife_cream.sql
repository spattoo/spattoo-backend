-- ── 107: cream worked with a palette knife is its own thing ─────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── THE HOLE 105 LEFT ───────────────────────────────────────────────────────────────────────────
-- 105 renamed `cream` from "Buttercream / whipped" to "Cream piping", because the row's two
-- booleans (no guide, no print) are true of PIPED cream and false of buttercream in general — a
-- palette-knife flower is buttercream, hand-made one petal at a time, and 104 gave it a guide.
--
-- That fixed the false claim and left a gap: there was then no entry an admin could pick for
-- "buttercream, but not piped". Sandeep, looking for one in the picker: *"i still dont see the
-- palette knife type."*
--
-- ⚠️ THE COLUMN NOW CARRIES TECHNIQUE WHERE TECHNIQUE IS WHAT DISTINGUISHES THE MATERIAL, AND THAT
-- IS A DELIBERATE CHANGE OF RULE. Migration 032 kept material and technique apart, and for every
-- other material that still holds — fondant is fondant however it is worked. Cream is the exception
-- that broke the rule: piped and palette-knifed cream are the same stuff and different crafts, and
-- an admin picking from one list needs to say WHICH. Sandeep: *"lets just change 'Made of' to
-- 'Made with', so it can cover technique also."* The picker's label changes with it, so the column
-- and the question it answers stay honest about each other.
--
-- The element TYPE remains the authority for elements that have one — `palette_knife_art` carries
-- its technique note (104) and `decorationPolicy` never reads the medium for those. This row is for
-- the FLAT PLACEABLES, where the type says "sticker" and only the material can say what it is.

-- 'palette_knife' is a third guide shape: not the modelled build sheet (roll, cut, assemble) and
-- not the nozzle recommendation. The column exists to name exactly this distinction.
alter table decoration_mediums drop constraint if exists decoration_mediums_guide_format_check;
alter table decoration_mediums add constraint decoration_mediums_guide_format_check
  check (guide_format is null or guide_format in ('modelled', 'piping_nozzle', 'palette_knife'));

insert into decoration_mediums (key, label, can_model, can_print, guide_format, build_note, sort_order) values
  -- Sorted directly after `cream` (80) so the two creams sit together and the choice between them
  -- is made side by side rather than remembered.
  ('cream_knife', 'Cream — palette knife', true, false, 'palette_knife',
   'Buttercream or whipped cream PRESSED AND DRAGGED WITH A PALETTE KNIFE — never piped. Load the '
   'flat of a small palette knife with a thin layer of cream, press it down at the outer tip of the '
   'petal and pull towards the centre in one stroke, lifting as you go: that leaves the signature of '
   'the craft, a raised ragged outer edge and a thin scraped middle. Built one petal at a time, '
   'overlapping, working from the outside in. Needs a crusting buttercream stiff enough to hold the '
   'ridge; chill briefly if it slumps. Worked on parchment or a flower nail and chilled firm before '
   'lifting onto the cake. Do NOT describe nozzles, tips or piping bags.', 82)
on conflict (key) do update set
  label        = excluded.label,
  can_model    = excluded.can_model,
  can_print    = excluded.can_print,
  guide_format = excluded.guide_format,
  build_note   = excluded.build_note,
  sort_order   = excluded.sort_order,
  is_active    = true,
  updated_at   = now();

-- ⚠️ `can_print` is FALSE, and that is not an oversight. The decoration IS the relief the blade
-- leaves — a raised outer edge and a scraped middle — and a flat printed sheet cannot carry it.
-- Offering "print it at actual size instead" here would offer something that is not a substitute.

select key, label, can_model, can_print, guide_format from decoration_mediums order by sort_order;
