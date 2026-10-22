-- ── 133: mermaid is a theme, and `beach` was never it ───────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run — the insert is guarded.
--
-- Sandeep, after naming two elements for it — a barnacle and a twisted kelp frond: *"yes pls add
-- the mermaid theme tag."*
--
-- ⚠️ THE GAP WAS FOUND BY TRYING TO FILE SOMETHING. Asked for search tags on the kelp, the live
-- vocabulary came back `beach, cars-vehicles, fairy-tale, music, nature, princess, space, sports,
-- superhero, unicorn` — and `beach` is a sandcastle, a parasol and a sun, which is a cake made
-- ABOVE the water. A mermaid cake is made below it: scales, shells, barnacles, kelp, coral, pearls,
-- a tail. Two different palettes, two different element sets, and a baker filing one under the
-- other loses both. `fairy-tale` is closer in spirit and worse in practice — it is castles and
-- crowns, and it already overlaps `princess`.
--
-- ⚠️ A ROW IS THE WHOLE CHANGE, and that is the point. The theme vocabulary is read from `tags` and
-- nothing in core, web, admin or the API carries a copy of it — grepped for `superhero` across all
-- four `src` trees before writing this: zero hits. Root CLAUDE.md rule 2, working as intended; the
-- filter chips, the AI tagger's prompt and the search haystack all derive from these rows.
--
-- ⚠️ `ai_assignable = true`, like every other theme. autoTag.js hands GPT-4o the vocabulary grouped
-- by category and asks it to tag a thumbnail at >= 0.75 confidence; a mermaid cake is about as
-- visually unambiguous as this list gets, and leaving it manual would mean every existing mermaid
-- template stays untagged until someone opens it. The emotion, relationship, gender and age_group
-- tags are the manual ones — none of them is visible in a photo.
--
-- ⚠️ SORT 85, between Beach (80) and Fairy Tale (90), under the themes' own numbering (tens, 10–100).
-- It sits beside the theme it is most often confused with, which is where a baker scanning the chips
-- will be looking when they realise `beach` is not what they meant.
--
-- WHAT MAKES IT SEARCHABLE: `searchableFields` (spattoo-core templateFilter.js) builds the haystack
-- from a template's name, every tag SLUG and every tag's DISPLAY NAME, then requires every word of
-- the query to substring-match some field. So "mermaid" finds it from either. ⚠️ "under the sea"
-- does NOT — `the` is dropped as filler but `under` and `sea` must still each hit something, and
-- neither is in this row. That is a deliberate choice of a short chip over a long one: the label
-- could read "Mermaid & Under the Sea" and catch both, the way 129 let "1st Birthday" catch the
-- digit people type. Widen the name if the phrase turns up in real searches; the slug stays.
--
-- ⚠️ `where not exists` rather than `on conflict`, exactly as 108 and 129: `tags` has no unique
-- constraint on slug to conflict against, and adding one now would be a schema change riding on a
-- data migration. A row already present — including one an admin typed by hand in Manage Tags — is
-- left untouched.
--
-- ⚠️ THIS ONLY ADDS THE WORD, IT DOES NOT FILE ANY CAKE UNDER IT. Until a baker tags the actual
-- mermaid templates (or autoTag runs over their thumbnails), the chip exists and matches nothing.
insert into tags (name, slug, category, ai_assignable, sort_order, is_active)
select v.name, v.slug, 'theme', true, v.sort_order, true
from (values
  ('Mermaid', 'mermaid', 85)
) as v(name, slug, sort_order)
where not exists (select 1 from tags t where t.slug = v.slug);

-- What it should look like afterwards (both environments):
--   select name, slug, category, sort_order, is_active
--     from tags where category = 'theme' order by sort_order;
--   → … Nature 40, Music 50, Princess 60, Superhero 70, Beach 80, Mermaid 85, Fairy Tale 90, Cars & Vehicles 100
