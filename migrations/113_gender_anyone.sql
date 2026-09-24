-- ── 113: a cake that suits anyone ───────────────────────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run — the insert is guarded.
--
-- ── WHY A THIRD VALUE ───────────────────────────────────────────────────────────────────────────
-- The gender vocabulary holds exactly `girls` and `boys`. That is fine while the tag is optional
-- and a baker ticks it when it applies — and it stops being fine the moment the tag is REQUIRED at
-- authoring time, which is where this is going.
--
-- Most cakes are not gendered. A vintage tier, a chocolate drip, an anniversary cake suits anyone.
-- With two values and a requirement, an author has no truthful answer: tick both, tick one falsely,
-- or be blocked. And "ticked both" is indistinguishable from "did not think about it" — which is
-- the exact failure the required age range exists to remove, reintroduced in another field.
--
-- So: a third value that is a real answer rather than an absence. `anyone` means the author
-- CONSIDERED it and this cake is for everybody; no tag at all still means nobody has said.
--
-- ⚠️ THIS IS AN ATTRIBUTE OF THE DESIGN, NOT OF A PERSON, and that distinction is the whole DPDP
-- position. A template tagged `girls` says "this design suits a girl", exactly as min_age/max_age
-- says "this design suits a four-year-old". It records nothing about anybody: there is no data
-- principal, and the order side stays ungendered — `RECIPIENTS` in cakeDraft.js is
-- child/adult/couple/family/friends/colleagues on purpose.
--
-- The line this must not cross is asking the CUSTOMER the recipient's gender. That is personal data
-- about a third party, usually a child, and squarely what DPDP s.9 governs — the same mistake
-- `age_band` was, removed in migration 046 for its tension with Privacy Policy §10. Tag the
-- template; never the customer's answer.
--
-- ⚠️ Guarded on SLUG ALONE, not slug + category — `tags_slug_key` is UNIQUE across the whole table,
-- so a category-scoped guard would fail to skip a slug already owned elsewhere and then fail the
-- constraint. Same reasoning as 109.

insert into tags (name, slug, category, ai_assignable, sort_order, is_active)
select v.name, v.slug, 'gender', false, v.sort_order, true
from (values
  -- Sorted last of the three: it is the "no strong signal" answer, and a picker reads better with
  -- the specific choices first. `girls` is 10 and `boys` 20 in the rows already seeded by hand.
  ('Anyone', 'anyone', 30)
) as v(name, slug, sort_order)
where not exists (select 1 from tags t where t.slug = v.slug);

-- ⚠️ ai_assignable = false, like everything in 109. The vision tagger can see a pink unicorn; it
-- cannot see who a cake is FOR, and inviting it to guess a gender from a thumbnail is the one
-- inference this vocabulary should never make automatically.

-- ── What the gender vocabulary is now ───────────────────────────────────────────────────────────
select slug, name, sort_order, is_active
from tags where category = 'gender'
order by sort_order;

-- ── How many templates say anything about it ────────────────────────────────────────────────────
-- ⚠️ Expect ZERO tagged today. The vocabulary has existed all along and nothing carries it, which
-- is why a search for "girl" currently finds nothing however many girl-ish cakes the catalogue
-- holds. Making the tag required fixes new templates; the existing ones need tagging in admin.
select count(*) filter (where te.tag_id is not null) as templates_with_a_gender,
       count(distinct t.id)                          as templates_total
from cake_templates t
left join template_tags te on te.template_id = t.id
  and te.tag_id in (select id from tags where category = 'gender')
where t.is_active;
