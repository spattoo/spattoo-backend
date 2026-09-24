-- ── 111: fill template_elements from the designs already stored ─────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run — see below.
--
-- 110 created the table empty. New saves populate themselves through syncTemplateElements, but
-- every template that already existed references its decorations only inside its `design` jsonb.
-- This is the one-time catch-up. A DATA migration, following 108's precedent.
--
-- ── THE EQUIVALENT OF scripts/backfill-template-elements.mjs ────────────────────────────────────
-- Either will do. The script imports `uuidsIn` — the SAME walk the runtime uses — so it cannot
-- disagree with what a save writes. This is a second implementation of that rule in another
-- language, which is a real cost and the reason the script exists at all:
--
--   ⚠️ IF THE RULE EVER CHANGES, THIS FILE DOES NOT KNOW. It is a one-off, already applied,
--   and should not be re-run years later expecting today's semantics. For repairing drift, use
--   the script — it is idempotent and always current.
--
-- ── WHY IT IS NOT A REGEX OVER design::text ─────────────────────────────────────────────────────
-- ⚠️ THE OBVIOUS ONE-LINER IS WRONG, and quietly. `UUID_RE` in lib/assetKeys.js is ANCHORED:
--
--     /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
--
-- so uuidsIn collects a string only when the WHOLE string is a uuid. Scanning the serialised json
-- with a global regex would also match a uuid sitting INSIDE a longer string — an asset URL, a
-- storage key — and insert rows the runtime would never write. The table would look fuller and be
-- wrong, which is the one failure mode this table exists to remove.
--
-- So it walks to string NODES and matches each one whole. `$.**` yields every member at any depth
-- and returns object VALUES, never keys — matching uuidsIn, which iterates Object.values().

-- ⚠️ THE SYNC THAT KEEPS THIS CURRENT HAS TO BE DEPLOYED, or the table starts decaying from the
-- next template save. `syncTemplateElements` ships in spattoo-api `afbe9fe`; until that reaches an
-- environment, this backfill is a SNAPSHOT rather than a starting point — correct at the instant it
-- runs and quietly wrong afterwards. Per environment the order is: deploy, then backfill.
--
-- If it was backfilled first, repair with scripts/backfill-template-elements.mjs and NOT by
-- re-running this file: it only ever ADDS (see the on-conflict note below), so a template that has
-- since LOST an element keeps its stale row. The script deletes before inserting, so it reconciles.

insert into public.template_elements (template_id, element_id)
select distinct t.id, e.id
from public.cake_templates t
cross join lateral jsonb_path_query(t.design, '$.**') as node
join public.cake_elements e
  -- lower(), because uuidsIn lowercases before comparing and a design may carry either case.
  on e.id::text = lower(node #>> '{}')
where t.design is not null
  and jsonb_typeof(node) = 'string'
on conflict (template_id, element_id) do nothing;

-- ⚠️ `on conflict do nothing` is what makes this re-runnable, and it is NOT the same as the
-- script's delete-then-insert. This only ADDS. A template whose design has since lost an element
-- keeps the stale row, because nothing here removes one. That is correct for a one-time catch-up
-- against designs nobody has edited in between, and wrong as a repair tool — which is the other
-- reason drift is the script's job, not this file's.

-- ── What landed ─────────────────────────────────────────────────────────────────────────────────
select
  (select count(*) from public.template_elements)                                  as rows_total,
  (select count(distinct template_id) from public.template_elements)               as templates_with_elements,
  (select count(*) from public.cake_templates where design is not null)            as templates_total,
  (select count(distinct element_id) from public.template_elements)                as elements_referenced;

-- ── Templates that reference NO catalogue element ───────────────────────────────────────────────
-- ⚠️ READ THIS ONE. A long list here is not necessarily a bug — a plain iced cake with piping and
-- text genuinely uses no catalogue decoration — but if MOST templates appear, the designs reference
-- elements by something other than a catalogue uuid and this table is empty for a real reason
-- rather than a missing run. That is the difference between "nothing to record" and "recorded
-- nothing", and only this query tells them apart.
select t.id, t.name
from public.cake_templates t
where t.design is not null
  and not exists (select 1 from public.template_elements te where te.template_id = t.id)
order by t.name;
