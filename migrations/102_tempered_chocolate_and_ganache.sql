-- ── 102: tempered chocolate is not modelling chocolate ──────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHAT WENT WRONG ─────────────────────────────────────────────────────────────────────────────
-- Five real cakes carrying chocolate garnishes — a lattice dome, a fanned loop arc, curls and
-- shards, moulded leaves, ruffled fans — were read by X-Ray on 2026-09-22. All five came back
-- `modelling_chocolate`, and none of them is.
--
-- Modelling chocolate is chocolate and glucose worked into a PLIABLE PASTE, kneaded like fondant.
-- Every decoration in those photographs is TEMPERED COUVERTURE: melted, brought through temper,
-- spread thin on acetate and then combed, curled, cut or piped and set. Different material,
-- different temperature discipline, different tools, different failure modes.
--
-- The guide showed the cost. For the fanned loop arc it said: "warm the modelling chocolate until
-- pliable · roll into a flat sheet about 2mm thick · cut strips 1cm x 15cm · bend each into a
-- semi-circle". Nobody makes that arc by rolling paste; it is piped onto an acetate strip and set
-- curved. A baker following those steps would waste an afternoon and a kilo of chocolate.
--
-- ⚠️ THE MODEL DID NOT MISJUDGE — IT PICKED THE ONLY CHOCOLATE IT WAS OFFERED. `modelling_chocolate`
-- was the single chocolate key in `decoration_mediums`, and 101 generates the vision prompt's enum
-- from that table. This is the same failure as the wafer-paper flower that came back as "sugar":
-- the vocabulary is the constraint, and it is invisible in the output, because a forced choice and
-- a considered one look identical once written down.
--
-- ⚠️ AND IT IS A ROW, WHICH IS THE POINT OF 101. No schema change, no code change, no deploy — the
-- enum, the policy and the admin picker all read this table, so adding a material teaches all three
-- at once. That is exactly what the CHECK constraint made impossible.

insert into decoration_mediums (key, label, can_model, can_print, guide_format, build_note, sort_order) values
  -- ⚠️ SORTED ABOVE modelling_chocolate (which is 20). When two keys could both fit, the model
  -- tends toward the one it meets first, and tempered work is far more common on a finished cake
  -- than modelled chocolate paste is.
  ('chocolate', 'Tempered chocolate', true, false, 'modelled',
   'Couverture chocolate melted and brought through temper, then spread thin on acetate or marble and worked as it sets — combed, curled with a scraper, cut into shards or panels, or piped into shapes and left to crystallise. Snaps and shines when tempered correctly; it is never rolled or kneaded, and it blooms dull and soft if the temper is lost. Worked cool and handled with gloves or a palette knife so fingers do not mark it.', 15),

  -- The model reached for this twice, unprompted, for drips on cakes it was reading — and it was
  -- not in the list, so the value could not resolve and the read was wasted. Offering it means the
  -- word it already uses lands somewhere.
  --
  -- ⚠️ `can_model` FALSE, and that is not a slight. A ganache drip is a FINISH poured over a
  -- chilled cake, not a piece made separately and placed — there is no object to write build steps
  -- for, and a "modelling guide" would invent one. The drip already has its own handling as a
  -- cake-level type.
  ('ganache', 'Ganache', false, false, null,
   'Chocolate and warm cream emulsified to a pouring or spreading consistency. A coating and a drip rather than a piece that is made separately — it is poured or spread onto the cake itself.', 17)
on conflict (key) do update set
  label        = excluded.label,
  can_model    = excluded.can_model,
  can_print    = excluded.can_print,
  guide_format = excluded.guide_format,
  build_note   = excluded.build_note,
  sort_order   = excluded.sort_order,
  updated_at   = now();

-- ── The one already there, corrected ────────────────────────────────────────────────────────────
-- Its note described the material accurately but said nothing to separate it from tempered work,
-- which is the distinction that actually decides which guide a baker gets.
update decoration_mediums
   set build_note = 'Chocolate and glucose worked into a pliable paste, kneaded and modelled like fondant — for figures, flowers and shapes built by hand. Warms and softens in the hands, so it is shaped in short sessions and chilled to hold detail. NOT the same as tempered chocolate: nothing here is melted, spread or curled.',
       updated_at = now()
 where key = 'modelling_chocolate';

-- Expect: 13 materials, with `chocolate` sorted between fondant (10) and modelling_chocolate (20).
select key, label, can_model, can_print, sort_order
  from decoration_mediums where is_active order by sort_order;
