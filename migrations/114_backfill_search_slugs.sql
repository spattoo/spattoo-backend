-- ── 114: fill search_slugs, and reconcile template_elements, from the designs already stored ────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run — see below.
--
-- 112 added the column and left it NULL. Every template that already existed can be found only by
-- its name and its own tags; what the cake CONTAINS and what it SAYS is sitting inside `design`
-- jsonb and nothing has ever read it. This is the one-time catch-up, the same shape as 111.
--
-- ── WHY THIS EXISTS WHEN scripts/backfill-template-elements.mjs ALREADY DOES IT ──────────────────
-- The script needs SUPABASE_SERVICE_KEY for the target database. Prod credentials are deliberately
-- not kept in the environment (see scripts/migrations.mjs — "Sandeep does not keep prod credentials
-- in the environment"), so prod SQL is run by pasting into the Supabase editor. On dev, run the
-- script. On prod, paste this.
--
--   ⚠️ IT IS A SECOND IMPLEMENTATION OF THE RULE, IN ANOTHER LANGUAGE. Exactly the cost 111 names
--   about itself, and the same warning applies: IF THE RULE EVER CHANGES, THIS FILE DOES NOT KNOW.
--   It is a one-off, and should not be re-run years later expecting today's semantics. For
--   repairing drift, use the script — it imports the runtime's own walk and is always current.
--
-- ── ⚠️ DEPLOY BEFORE BACKFILLING. THIS IS NOT THE SAME BRANCH ON PROD ────────────────────────────
-- `syncTemplateDerived` is what keeps both outputs current from the next template save onward. It
-- is on the `dev` branch. render.yaml points the PROD service at `main`, and prod is a separate
-- deliberate deploy — a dev push is not a shipped event.
--
-- So on prod the order is: get the API carrying syncTemplateDerived onto main and deployed, THEN
-- paste this. Backfilling first makes it a SNAPSHOT — correct at the instant it runs and quietly
-- wrong from the next save, with nothing to say so. Dev was done in that order and verified.
--
-- ── WHY IT RE-WALKS THE DESIGN RATHER THAN JOINING template_elements ─────────────────────────────
-- ⚠️ THE CHEAP VERSION IS WRONG, AND IT WAS MEASURED WRONG RATHER THAN SUSPECTED. Joining
-- template_elements to get element names looks obviously right — 111 already filled that table. But
-- 111 only ever ADDS (`on conflict do nothing`), so a template created or edited after it ran is
-- missing rows. On dev, before this backfill:
--
--   templates 36   fresh walk 130 elements   template_elements 127   differing 1
--     "special day": walk 3, stored 0
--
-- A join would have given that template ONE term instead of four. So the walk is done here, from
-- the design, the same way 111 does it — and the same reasoning about anchoring applies: `$.**`
-- yields every member at any depth and returns object VALUES, never keys, and each string node is
-- matched WHOLE against an element id. A global regex over `design::text` would also match a uuid
-- sitting inside a longer string (an asset URL, a storage key) and invent rows the runtime would
-- never write.
--
-- Because it walks anyway, it also RECONCILES template_elements — delete-then-insert, like the
-- script, not 111's add-only. That repairs the drift above rather than preserving it.
--
-- ── WHAT GOES INTO A TERM ───────────────────────────────────────────────────────────────────────
-- Mirrors lib/templateElements.js exactly. The two disagreeing is what would make this table look
-- right and be wrong:
--
--   element names           cake_elements.name for every element the design references
--   element tag vocabulary  both the slug and the display name — they diverge exactly where
--                           somebody is most likely to type
--   the cake's own text     design.writings[].text and design.texts[].content
--
--   ⚠️ `writings` IS THE ONE THAT CARRIES THE WORDS. A first cut read only `texts[].content` and
--   produced ZERO text terms across the whole catalogue, because every template's `texts` is empty
--   — a message on a cake is a `writings[]` entry with a `text` field. It looked healthy and was
--   missing half of what this exists to index; caught only because the term count came back exactly
--   equal to the element count. `texts` is still read: an older saved design may carry one.
--
--   ⚠️ `'Your Text'` IS SKIPPED — the content a freshly added TEXT block carries. Without it every
--   design whose text block was ever touched answers to a search for "your text".
--
--   ⚠️ `{name}` / `{number}` ARE STRIPPED. Those are SLOTS a customer fills in, not words the
--   template says. "Happy {name}" contributes "happy"; a slot left whole would make every
--   personalised template match a search for "name".
--
--   ⚠️ `nameBlocks` IS DELIBERATELY NOT READ. Fondant letter blocks spell a PERSON'S NAME — the
--   least useful thing to find a catalogue template by, and the closest this design comes to
--   personal data. It is geometry here anyway.
--
-- ── ⚠️ WHY `collate "C"` AND NOT A PLAIN ORDER BY ───────────────────────────────────────────────
-- The script sorts with JavaScript's `.sort()`, which is raw code-unit order. A bare `order by`
-- here uses the database collation, which ignores punctuation and spaces at the first pass. Our
-- real terms include `reverse shell,`, `you & me`, `we are engaged !` and `and thats very special
-- day!` — precisely the strings where the two orders disagree. Without `collate "C"` this file and
-- the script produce the same SET in a different ORDER, so every later script run rewrites rows
-- that have not actually changed, and a diff between two backfills stops meaning anything.
-- (C collation is byte order, which equals code-point order in UTF-8; that matches `.sort()` for
-- the ASCII these terms are made of.)

begin;

-- ── Guards: the columns this depends on must already exist ──────────────────────────────────────
-- A clear failure beats a confusing one. Without 112 the UPDATE fails with "column does not exist"
-- partway through; without 110 the reconcile fails on a missing table.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'cake_templates' and column_name = 'search_slugs'
  ) then
    raise exception 'cake_templates.search_slugs is missing — run migration 112 first';
  end if;

  if not exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'template_elements'
  ) then
    raise exception 'public.template_elements is missing — run migration 110 first';
  end if;
end $$;

-- What it looked like before, so the tail can report a real delta rather than just a total.
create temporary table _before on commit drop as
select
  (select count(*) from public.template_elements)                                as element_rows,
  (select count(*) from public.cake_templates where search_slugs is not null)    as templates_with_terms;

-- ── 1. The walk: which catalogue elements each design actually references ───────────────────────
create temporary table _walk on commit drop as
select distinct t.id as template_id, e.id as element_id
from public.cake_templates t
cross join lateral jsonb_path_query(t.design, '$.**') as node
join public.cake_elements e
  -- lower(), because uuidsIn lowercases before comparing and a design may carry either case.
  on e.id::text = lower(node #>> '{}')
where t.design is not null
  and jsonb_typeof(node) = 'string';

create index on _walk (template_id);
create index on _walk (element_id);

-- ── 2. Reconcile template_elements ──────────────────────────────────────────────────────────────
-- Delete-then-insert, NOT 111's add-only. A design can change under an existing template
-- (`PATCH /admin/templates/:id` allows `design`), and an element removed from it must lose its row
-- or the table goes on describing a cake that no longer exists.
delete from public.template_elements te
where not exists (
  select 1 from _walk w
  where w.template_id = te.template_id and w.element_id = te.element_id
);

insert into public.template_elements (template_id, element_id)
select w.template_id, w.element_id from _walk w
on conflict (template_id, element_id) do nothing;

-- ── 3. Every term, per template ─────────────────────────────────────────────────────────────────
create temporary table _terms on commit drop as
with element_terms as (
  -- The decoration's own name. Carries the feature today: every element in use is UNTAGGED in both
  -- environments (56 of 56 dev, 48 of 48 prod), so the two tag branches below are written and
  -- currently yield nothing. They cost one join and start working the day somebody tags the
  -- catalogue, without another deploy.
  select w.template_id, lower(btrim(e.name)) as term
  from _walk w
  join public.cake_elements e on e.id = w.element_id
  where e.name is not null and btrim(e.name) <> ''

  union all
  select w.template_id, lower(btrim(g.slug))
  from _walk w
  join public.element_tags et on et.element_id = w.element_id
  join public.tags g on g.id = et.tag_id
  where g.slug is not null and btrim(g.slug) <> ''

  union all
  select w.template_id, lower(btrim(g.name))
  from _walk w
  join public.element_tags et on et.element_id = w.element_id
  join public.tags g on g.id = et.tag_id
  where g.name is not null and btrim(g.name) <> ''
),
raw_text as (
  -- ⚠️ The jsonb_typeof guard is load-bearing: jsonb_array_elements ERRORS on a non-array, so one
  -- malformed design would abort the whole backfill rather than contributing nothing.
  select t.id as template_id, w ->> 'text' as s
  from public.cake_templates t
  cross join lateral jsonb_array_elements(t.design -> 'writings') as w
  where t.design is not null and jsonb_typeof(t.design -> 'writings') = 'array'

  union all
  select t.id, x ->> 'content'
  from public.cake_templates t
  cross join lateral jsonb_array_elements(t.design -> 'texts') as x
  where t.design is not null and jsonb_typeof(t.design -> 'texts') = 'array'
),
text_terms as (
  -- Same order of operations as the JS: trim, reject empty and 'Your Text', strip {slots},
  -- collapse whitespace, trim again, lowercase.
  select
    template_id,
    lower(btrim(
      regexp_replace(
        regexp_replace(btrim(s), '\{[^}]*\}', ' ', 'g'),
        '\s+', ' ', 'g'
      )
    )) as term
  from raw_text
  where s is not null
    and btrim(s) <> ''
    and btrim(s) <> 'Your Text'
)
select template_id, term from element_terms where term <> ''
union all
select template_id, term from text_terms   where term <> '';

-- Deduped and sorted once — see the collate "C" note at the top.
create temporary table _agg on commit drop as
select template_id, array_agg(term order by term collate "C") as terms
from (select distinct template_id, term from _terms) d
group by template_id;

-- ── 4. Store them ───────────────────────────────────────────────────────────────────────────────
-- ⚠️ WRITTEN EVEN WHEN EMPTY — `{}`, never left NULL. Otherwise a re-run cannot tell "nothing to
-- record" from "never processed", which is the same distinction 112's tail query exists to make.
--
-- `is distinct from` makes the re-run free: a second paste writes zero rows and reports zero
-- changed, rather than rewriting all of them and bloating the table.
update public.cake_templates t
set search_slugs = coalesce(a.terms, '{}')
from public.cake_templates base
left join _agg a on a.template_id = base.id
where t.id = base.id
  and t.search_slugs is distinct from coalesce(a.terms, '{}');

commit;

-- ── What landed ─────────────────────────────────────────────────────────────────────────────────
-- Dev, for comparison — prod has a smaller catalogue, so expect lower numbers, not equal ones:
--   templates 36, search_slugs filled 36, total terms 142, 1 template with none,
--   template_elements 127 -> 130.
select
  count(*)                                                  as templates,
  count(*) filter (where search_slugs is not null)          as with_terms,
  count(*) filter (where cardinality(search_slugs) = 0)     as stored_empty,
  coalesce(sum(cardinality(search_slugs)), 0)               as total_terms,
  coalesce(round(avg(cardinality(search_slugs)), 1), 0)     as avg_terms,
  (select count(*) from public.template_elements)           as element_rows
from public.cake_templates
where design is not null;

-- ── Templates that end up with NO terms at all ──────────────────────────────────────────────────
-- ⚠️ READ THIS ONE. A short list is normal — a plain iced cake with no catalogue decoration and no
-- writing genuinely has nothing to index (dev has exactly one, `wedding`). If MOST templates appear
-- here, the designs reference elements by something other than a catalogue uuid, or the text lives
-- under a key this file does not read — and the difference between "nothing to record" and
-- "recorded nothing" is only visible here.
select t.id, t.name
from public.cake_templates t
where t.design is not null
  and coalesce(cardinality(t.search_slugs), 0) = 0
order by t.name;
