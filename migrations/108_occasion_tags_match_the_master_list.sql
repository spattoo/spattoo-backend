-- ── 108: a template can be filed under every occasion a customer can name ───────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run — inserts are guarded.
--
-- ── TWO VOCABULARIES, AND NOTHING KEEPING THEM HONEST ───────────────────────────────────────────
-- Occasions are written in two unrelated places, for two different jobs:
--
--   cakeDraft.js OCCASIONS      what a CUSTOMER says the cake is for. 14 keys, guarded across three
--                               files by check-occasions (storefront, API validator, CHECK).
--   tags (category='occasion')  how a BAKER files a template so it can be found. Free-form, edited
--                               in admin's Manage Tags. 11 rows.
--
-- They are different jobs and should stay separate — a customer picking a motive wants a short
-- list, a baker filing a template wants the specific festival. What was missing is any relationship
-- at all: `engagement` has been a customer occasion since 059 and there was never a tag for it, so
-- "Save as Template" simply did not offer it. Found by screenshot: *"we should add occassion
-- engagement as well. and i think many occassions are missing here."*
--
-- So the rule, from here: EVERY master-list occasion that a template could be filed under has a tag
-- of the same slug. Three do not, and each is named rather than forgotten — see the gate.
--
-- ⚠️ SLUGS ARE HYPHENATED HERE AND UNDERSCORED THERE. `baby_shower` is the customer key,
-- `baby-shower` the tag slug, and that was true before this migration. Both spellings stay; the gate
-- normalises rather than forcing a rename, because renaming a tag slug breaks whatever already
-- points at it for no gain.
--
-- ⚠️ THE LABELS ARE THE MASTER LIST'S, DELIBERATELY. "New home", never "Housewarming" — a Griha
-- Pravesh is a long day of ritual and cake is not yet part of it, so "housewarming" names a party
-- that in many homes is not what happens. "Office do" rather than "Corporate", because it is a TEAM
-- event and the other one sounds like a procurement category. Those decisions were made once in
-- cakeDraft.js and are not re-made here.

-- ── THE WHOLE LIST, not just the six that were missing ──────────────────────────────────────────
-- The eleven that already existed were created by hand in admin and written down nowhere, which is
-- why the gate could not see them: it reads migrations, because a migration is the thing a reviewer
-- can read. Seeding all seventeen makes the vocabulary visible AND gives a fresh environment the
-- tags it would otherwise be missing entirely.
--
-- ⚠️ `where not exists` rather than `on conflict`: the table has no unique constraint on slug to
-- conflict against, and adding one now would be a schema change riding on a data migration. Every
-- row already present is left exactly as it is — this cannot overwrite a label an admin has edited.
--
-- ⚠️ ONE NUMBERING SCHEME: life events 10–99, festivals 100+. The two kinds were interleaved, so a
-- baker filing "engagement" found it after Diwali.
insert into tags (name, slug, category, ai_assignable, sort_order, is_active)
select v.name, v.slug, 'occasion', false, v.sort_order, true
from (values
  -- Life events. Labels are the MASTER LIST's, deliberately: "New home", never "Housewarming" — a
  -- Griha Pravesh is a long day of ritual and cake is not yet part of it, so "housewarming" names a
  -- party that in many homes is not what happens. "Office do" rather than "Corporate", because it
  -- is a TEAM event. Those decisions were made once in cakeDraft.js and are not re-made here.
  ('Birthday',             'birthday',       10),
  ('Wedding',              'wedding',        20),
  ('Engagement',           'engagement',     25),
  ('Anniversary',          'anniversary',    30),
  ('Baby Shower',          'baby-shower',    40),
  ('Bridal shower',        'bridal-shower',  45),
  ('Graduation',           'graduation',     50),
  ('New home',             'new-home',       60),
  ('New job or promotion', 'new-job',        70),
  ('Farewell',             'farewell',       80),
  ('Office do',            'corporate',      90),
  -- Festivals. These have no master-list key of their own — a customer picks `festival` and the
  -- tags are how a TEMPLATE says which one. See TAG_ONLY in check-occasions.
  ('Christmas',            'christmas',     100),
  ('Easter',               'easter',        102),
  ('Halloween',            'halloween',     104),
  ('Eid',                  'eid',           106),
  ('Diwali',               'diwali',        108),
  ('Valentine''s',         'valentines',    110)
) as v(name, slug, sort_order)
where not exists (
  select 1 from tags t where t.slug = v.slug and t.category = 'occasion'
);

-- Renumber the ones that were already here, so the scheme above actually holds on a database that
-- had them. Display order only; nothing references sort_order but the pickers.
update tags t set sort_order = v.sort_order
from (values
  ('birthday', 10), ('wedding', 20), ('engagement', 25), ('anniversary', 30),
  ('baby-shower', 40), ('bridal-shower', 45), ('graduation', 50), ('new-home', 60),
  ('new-job', 70), ('farewell', 80), ('corporate', 90),
  ('christmas', 100), ('easter', 102), ('halloween', 104), ('eid', 106),
  ('diwali', 108), ('valentines', 110)
) as v(slug, sort_order)
where t.category = 'occasion' and t.slug = v.slug and t.sort_order is distinct from v.sort_order;

select slug, name, sort_order from tags where category = 'occasion' order by sort_order;
