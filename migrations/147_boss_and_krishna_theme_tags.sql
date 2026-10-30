-- ── 147: two themes the list could not file — the boss's cake, and Krishna ───────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run — the inserts are guarded.
--
-- Sandeep, from the Save as Template sheet: *"while saving template, add a new theme 'Boss' - boss
-- theme"*, then *"also add 'krishna theme'"*, and on what Boss means: *"yeah its more like
-- team/boss birthday etc."*
--
-- The theme chips read Unicorn, Sports, Space, Nature, Animals & Jungle, Music, Princess, Superhero,
-- Beach, Mermaid, Fairy Tale, Cars & Vehicles. Every one of them is a CHILD'S cake. A bakery whose
-- weekday work is office birthdays and festival orders has nowhere to file either of these.
--
-- ⚠️ BOSS IS A LOOK, NOT AN OCCASION, AND THE OCCASION HALF ALREADY EXISTS. `occasion` carries
-- 'New job or promotion' (70), 'Farewell' (80) and 'Office do' (90) since 109 — so "why the cake is
-- being bought" was already answerable, and what was missing is what it LOOKS like: the tie, the
-- desk, the laptop, the "#1 Boss" mug. The two axes are meant to be used together; a leaving cake
-- for a manager is `corporate` + `boss`, and neither tag is redundant.
--
-- ⚠️ KRISHNA IS A THEME AND NOT A FESTIVAL ROW, for the same reason. Janmashtami is an occasion and
-- is NOT in that list (Christmas, Easter, Halloween, Eid, Diwali, Valentine's are) — but Sandeep
-- asked for a theme, and he is right that it is the durable half: the flute, the peacock feather,
-- the matki and the blue skin are a LOOK, ordered for Janmashtami and also for a first birthday, a
-- naming day or a temple order. If the festival itself turns out to be wanted as a date, that is a
-- second row in `occasion`, not a rename of this one.
--
-- ⚠️ THE LABELS ARE THE WORDS HE USED. 137 widened 'Animal'/'Jungle' into 'Animals & Jungle'
-- because the slash in the request was a genuine ambiguity between two words. There is no slash
-- here. `searchableFields` (spattoo-core/templateFilter.js) builds its haystack from the template
-- name, every tag SLUG and every tag's DISPLAY NAME, so a baker typing "team" or "janmashtami"
-- finds nothing from these rows today — widening either label to 'Boss & Team' or
-- 'Krishna & Janmashtami' is a one-word edit here if that proves to be wanted. Not guessed at now.
--
-- ⚠️ `ai_assignable = true` FOR BOTH, like every theme, BUT THEY WILL NOT BEHAVE ALIKE. autoTag.js
-- hands GPT-4o the vocabulary grouped by category and asks it to tag a thumbnail at >= 0.75
-- confidence. Krishna is as visually distinct as this list gets — peacock feather, flute, matki. A
-- boss's cake often is not: it is a plain cake carrying WORDS, and the words are what make it one,
-- so expect the tagger to assign `boss` rarely and `krishna` readily. Leaving `boss` manual would
-- have been the other option; it is left on because a missed tag costs nothing and the chip is
-- there for a baker to tick by hand either way.
--
-- ⚠️ SORT 105 AND 110, AFTER Cars & Vehicles (100). The existing run 10–100 is children's themes in
-- rough order of how often they are asked for, and neither of these belongs inside it: dropping an
-- office cake between Princess and Superhero would read as a mis-sort to anyone scanning the chips.
-- Appending keeps that run intact and puts the two grown-up themes together at the end.
--
-- ⚠️ A ROW IS THE WHOLE CHANGE. Re-checked before writing this rather than taken from 137 on trust:
-- grepping `superhero`, `'mermaid'`, `cars-vehicles` and `fairy-tale` across the `src` trees of
-- core, admin and the backend returns ZERO hits in all three. The chips, the AI tagger's prompt and
-- the search haystack all derive from these rows. Root CLAUDE.md rule 2, working as intended.
--
-- ⚠️ `where not exists` rather than `on conflict`, exactly as 108, 129, 133 and 137: `tags` has no
-- unique constraint on slug to conflict against, and adding one now would be a schema change riding
-- on a data migration. A row already present — including one an admin typed into Manage Tags — is
-- left untouched.
--
-- ⚠️ THIS ONLY ADDS THE WORDS, IT FILES NO CAKE UNDER THEM. Until a baker tags their templates, or
-- autoTag runs over the thumbnails, both chips exist and match nothing.
insert into tags (name, slug, category, ai_assignable, sort_order, is_active)
select v.name, v.slug, 'theme', true, v.sort_order, true
from (values
  ('Boss',    'boss',    105),
  ('Krishna', 'krishna', 110)
) as v(name, slug, sort_order)
where not exists (select 1 from tags t where t.slug = v.slug);

-- What it should look like afterwards (both environments):
--   select name, slug, category, sort_order, is_active
--     from tags where category = 'theme' order by sort_order;
--   → Unicorn 10, Sports 20, Space 30, Nature 40, Animals & Jungle 45, Music 50, Princess 60,
--     Superhero 70, Beach 80, Mermaid 85, Fairy Tale 90, Cars & Vehicles 100, Boss 105, Krishna 110
