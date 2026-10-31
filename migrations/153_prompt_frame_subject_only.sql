-- ── 153: stop asking for a cake, and say so out loud ────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- A "fondant flute" run came back as a teddy bear SITTING ON A CAKE. Sandeep: *"it generated with
-- color, not SHOULD NOT HAVE A CAKE. pls add that to prompt that there should not be cake or ano
-- other prop."*
--
-- ⚠️ THE CAKE WAS OUR OWN CLAUSE. 152 seeded `scale` as *"sized to sit on top of a cake"*, meaning
-- "make it ornament-proportioned, not statue-proportioned". A generator does not read intent — it
-- reads nouns, and the sentence contains the noun "cake". So it modelled one. Every prompt we have
-- sent since 152 has been asking for a cake we then have to look past.
--
-- The scale cue therefore has to carry proportion WITHOUT naming an object, and the exclusion has
-- to be explicit rather than implied: a generator fills space it has not been told to leave empty,
-- so "a flute" becomes a flute on a stand, a bear becomes a bear on a cake.
--
-- ⚠️ "FLAT BASE" HAS THE SAME SHAPE OF PROBLEM and is reworded with it. We mean "the underside is
-- flat so it stands up"; "base" is also a word for a plinth to put something on. Said as
-- "underside" it cannot be read as a second object.

update decoration_prompt_frame
   set phrase = 'a small ornament, hand-sized, not a life-sized object',
       note   = 'Proportion, NOT a literal size — the designer normalises scale anyway. ⚠️ It said "sized to sit on top of a cake" and a generator read the noun: a "fondant flute" came back as a teddy bear sitting on a cake. Never name an object here that we do not want modelled.',
       updated_at = now()
 where key = 'scale';

update decoration_prompt_frame
   set phrase = 'a single solid closed shape with a flat underside so it stands upright',
       note   = 'MEASURED: without a flat underside the model floats, and a decoration that cannot sit on a cake is not a decoration. Says "underside" rather than "base" because a base is also a plinth, and a generator will happily model one.',
       updated_at = now()
 where key = 'standable';

insert into decoration_prompt_frame (key, phrase, applies_to, position, sort_order, note) values
  ('subject_only',
   'the subject on its own, isolated on a plain background — no cake, plate, stand, plinth, table, scenery or other objects',
   'always', 'tail', 45,
   'A generator fills space it has not been told to leave empty. Asked for a flute it returns a flute on a stand; asked for a bear it returns a bear on a cake — which is exactly what happened, helped along by our own scale clause naming one. The exclusion has to be explicit, and it has to list the props we actually see rather than say "no props".')
on conflict (key) do update
  set phrase = excluded.phrase, applies_to = excluded.applies_to, position = excluded.position,
      note = excluded.note, sort_order = excluded.sort_order, is_active = true, updated_at = now();
