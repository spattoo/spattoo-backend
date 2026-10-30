-- ── 151: the questions go generic; categories did not survive contact with "bat" ─────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- 149 keyed the question set to `element_categories`, so a lion was asked how it sits and a rose
-- was asked how open it is. Sandeep, on trying to use it:
--
--   *"i think making these categories does not making any sense to me.. we can only ask generic
--    questions. if they type bat- how do you know which bat is it? there are many sports use bat."*
--
-- He is right, and "bat" is the clean counter-example: cricket, baseball, table tennis, or the
-- animal. Nothing can classify that from one word. A category PICKER does not fix it either — it
-- moves the guess onto the operator and asks them to answer a question about taxonomy before they
-- are allowed to describe their cake decoration.
--
-- ── WHAT ACTUALLY DISAMBIGUATES IT ──────────────────────────────────────────────────────────────
-- The baker's own words. "bat" is ambiguous; "cricket bat, worn willow with a taped handle" is not.
-- So the thing to ask for is not a category, it is a DESCRIPTION — and a description cannot be
-- chips, which is why it is free text and why this migration adds no options for it.
--
-- ── WHAT IS LEFT, AND WHY SO LITTLE ─────────────────────────────────────────────────────────────
-- Only two things the baker owns:
--   · Made of — closed, 8 rows, resolved from decoration_mediums where can_model
--   · How it should look — open, free text, theirs
-- Everything else that makes a generation fail is OURS and is applied every time without asking:
-- cake-topper scale, a flat base, untextured (so parts stay recolourable), and the triangle cap.
--
-- ⚠️ TWO QUESTIONS DROPPED, NOT RENAMED:
--   · `placement` ("Where it goes") asked at GENERATION time something decided at DESIGN time —
--     generated stickers carry `allowedActions: { move, tilt, resize }`, so the gizmo already owns
--     placement. Sandeep: *"we actually allow free hand placement (gizmo) for the generated."*
--   · `detail` offered Simple/Moderate/Detailed, which I wrote as a triangle-budget control and
--     presented to the baker. Sandeep: *"i did not [mean] the number of traingles or any technical
--     detail. its the detail on how they want it to look."* The budget is ours to enforce, silently
--     — nobody wants "Simple", they want it to look good — and the look detail is the free-text
--     box, not a three-way chip.
--
-- The per-category rows go with them. `decoration_prompt_questions.category_id` STAYS: it is one
-- nullable FK, dropping it would be churn, and the day a question genuinely only makes sense for
-- one category it is there. Nothing uses it today and the seed sets it nowhere.

delete from decoration_prompt_options
 where question_id in (select id from decoration_prompt_questions where category_id is not null);
delete from decoration_prompt_questions where category_id is not null;

delete from decoration_prompt_options
 where question_id in (select id from decoration_prompt_questions where key in ('placement', 'detail'));
delete from decoration_prompt_questions where key in ('placement', 'detail');

-- `source = 'free_text'` is the third kind, beside 'options' and 'mediums': a question with no
-- answers to choose from, whose value IS what the baker typed. It carries a placeholder rather than
-- options, because the useful thing to show someone staring at an empty box is an example.
alter table decoration_prompt_questions drop constraint if exists decoration_prompt_questions_source_check;
alter table decoration_prompt_questions
  add constraint decoration_prompt_questions_source_check
  check (source in ('options', 'mediums', 'free_text'));

alter table decoration_prompt_questions add column if not exists placeholder text;
comment on column decoration_prompt_questions.placeholder is
  'Shown inside a free_text box. An example teaches what is useful here far faster than a label.';

insert into decoration_prompt_questions (category_id, key, label, help, source, required, sort_order, placeholder) values
  (null, 'look', 'How should it look',
   'Pose, style, details — whatever you can picture. This is also what tells us WHICH thing you mean: "bat" could be cricket, baseball or the animal.',
   'free_text', false, 20,
   'sitting, with a big fluffy mane and a small crown')
on conflict (key) where category_id is null do update
  set label = excluded.label, help = excluded.help, source = excluded.source,
      placeholder = excluded.placeholder, sort_order = excluded.sort_order, is_active = true;

update decoration_prompt_questions set sort_order = 10 where key = 'medium' and category_id is null;
