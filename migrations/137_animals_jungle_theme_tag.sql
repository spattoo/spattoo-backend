-- ── 137: animals and the jungle are a theme ──────────────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run — the insert is guarded.
--
-- Sandeep, from the Save as Template sheet: *"while saving template we need a new theme
-- 'Animal'/'Jungle'."* The theme chips there read Unicorn, Sports, Space, Nature, Music, Princess,
-- Superhero, Beach, Mermaid, Fairy Tale, Cars & Vehicles — and a baker saving a giraffe cake, a
-- lion cake or a safari cake has nowhere to file it.
--
-- ⚠️ ONE ROW, NOT TWO, AND THE NAME CARRIES BOTH WORDS. The slash in the request is a real
-- ambiguity — "Animal" and "Jungle" are not the same word — and 133 already solved this shape: *"the
-- label could read 'Mermaid & Under the Sea' and catch both."* `searchableFields`
-- (spattoo-core/templateFilter.js) builds its haystack from the template name, every tag SLUG and
-- every tag's DISPLAY NAME, so a two-word label makes both terms findable without splitting a small
-- vocabulary into two chips that compete for the same cake. A baker searching "jungle" and a baker
-- searching "animals" both land here.
--
-- ⚠️ AND SPLITTING THEM WOULD BE THE WRONG CUT ANYWAY. 133 split Beach from Mermaid because they
-- are two palettes and two element sets — above the water and below it. Animals and the jungle are
-- the SAME cake: the leaves, the vines and the giraffe arrive together. Where they genuinely differ
-- — a puppy cake, a farm cake — the broader word is the one that still fits, which is why `animals`
-- is the slug and the durable half of the name.
--
-- ⚠️ `ai_assignable = true`, like every theme. autoTag.js hands GPT-4o the vocabulary grouped by
-- category and asks it to tag a thumbnail at >= 0.75 confidence; a jungle cake is as visually plain
-- as this list gets. Leaving it manual would mean every animal template already saved stays
-- untagged until someone opens it.
--
-- ⚠️ SORT 45, between Nature (40) and Music (50), under the themes' own numbering (tens, 10–100).
-- Beside Nature for 133's reason — it sits next to the theme it is most often confused with, which
-- is where a baker scanning the chips will be looking when they realise `nature` is leaves and
-- flowers rather than the animals in them.
--
-- ⚠️ A ROW IS THE WHOLE CHANGE. Re-checked before writing this, not taken from 133 on trust:
-- grepping `superhero`, `'mermaid'` and `cars-vehicles` across the `src` trees of core, web, admin
-- and the API returns ZERO hits in all four. The chips, the AI tagger's prompt and the search
-- haystack all derive from these rows. Root CLAUDE.md rule 2, working as intended.
--
-- ⚠️ `where not exists` rather than `on conflict`, exactly as 108, 129 and 133: `tags` has no unique
-- constraint on slug to conflict against, and adding one now would be a schema change riding on a
-- data migration. A row already present — including one an admin typed into Manage Tags — is left
-- untouched.
--
-- ⚠️ THIS ONLY ADDS THE WORD, IT DOES NOT FILE ANY CAKE UNDER IT. Until a baker tags the animal
-- templates, or autoTag runs over their thumbnails, the chip exists and matches nothing.
insert into tags (name, slug, category, ai_assignable, sort_order, is_active)
select v.name, v.slug, 'theme', true, v.sort_order, true
from (values
  ('Animals & Jungle', 'animals', 45)
) as v(name, slug, sort_order)
where not exists (select 1 from tags t where t.slug = v.slug);

-- What it should look like afterwards (both environments):
--   select name, slug, category, sort_order, is_active
--     from tags where category = 'theme' order by sort_order;
--   → Unicorn 10 … Space 30, Nature 40, Animals & Jungle 45, Music 50, Princess 60, Superhero 70,
--     Beach 80, Mermaid 85, Fairy Tale 90, Cars & Vehicles 100
