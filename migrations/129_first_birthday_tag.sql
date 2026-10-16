-- ── 129: a first birthday is its own cake, and now its own tag ──────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run — the insert is guarded.
--
-- Sandeep: *"we want to make 1st birthday cakes searchable. should we add 1st birthday as special
-- chip under occassions."*
--
-- ⚠️ A TAG, NOT AN OCCASION, AND 108 ALREADY DREW THAT LINE. Occasions are written twice for two
-- different jobs: `cakeDraft.js OCCASIONS` is what a CUSTOMER says the cake is for — 14 keys held in
-- step across the storefront, the API validator and a CHECK by check-occasions — and
-- `tags (category='occasion')` is how a BAKER files a template so it can be found. 108: *"They are
-- different jobs and should stay separate — a customer picking a motive wants a short list, a baker
-- filing a template wants the specific festival."* A first birthday is exactly that: more specific
-- than the customer's motive, which is still plain `birthday`.
--
-- Putting it in the customer list instead would have cost a three-file change plus a CHECK, and
-- bought a contradiction: `templateFilter` treats occasions as ALTERNATIVES — *"no cake is a
-- birthday AND an anniversary"* — and a first birthday IS a birthday. As a tag the two stack, so a
-- cake filed under both is found by either word and counted once.
--
-- ⚠️ THE VOCABULARY IS NOT NEW. `orders.celebration` has carried `first_birthday` since 079, as the
-- child branch beside `kids_party` and `teen_party`. This gives the baker's filing system the word
-- the ordering flow already uses, rather than inventing a second one.
--
-- WHAT MAKES IT SEARCHABLE: `searchableFields` (spattoo-core templateFilter.js) builds the haystack
-- from a template's name, every tag SLUG and every tag's DISPLAY NAME, and the query is tokenised —
-- every word must match something, substring per word, any word against any field. So all of
-- "1st birthday", "first birthday" and "1st" find it: "first" hits the slug, "1st" hits the label.
-- That is why the label carries the digit people actually type and the slug carries the word.
--
-- ⚠️ THIS ONLY ADDS THE WORD, IT DOES NOT FILE ANY CAKE UNDER IT. `tag_slugs` on a template is
-- curated by a baker in the template editor, and the filter's chips are built from it — so until
-- someone tags the actual first-birthday templates, searching "1st birthday" still returns nothing.
-- The row is the vocabulary; the filing is the next step and it is a human one.
--
-- ⚠️ `where not exists` rather than `on conflict`, exactly as 108: `tags` has no unique constraint on
-- slug to conflict against, and adding one now would be a schema change riding on a data migration.
-- A row already present — including one an admin typed by hand in Manage Tags — is left untouched.
--
-- ⚠️ SORT 15, between Birthday (10) and Wedding (20), under 108's one numbering scheme: life events
-- 10–99, festivals 100+. It sits next to the occasion it narrows, which is where a baker looks.
insert into tags (name, slug, category, ai_assignable, sort_order, is_active)
select v.name, v.slug, 'occasion', false, v.sort_order, true
from (values
  ('1st Birthday', 'first-birthday', 15)
) as v(name, slug, sort_order)
where not exists (select 1 from tags t where t.slug = v.slug);

-- What it should look like afterwards (both environments):
--   select name, slug, category, sort_order, is_active
--     from tags where category = 'occasion' order by sort_order;
--   → … Birthday 10, 1st Birthday 15, Wedding 20, Engagement 25 …
