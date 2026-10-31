-- ── Is migration 158 applied here? ──────────────────────────────────────────────────────────────
--
-- READ-ONLY. Nothing here writes or locks. Safe on production.
--
-- 158 adds promoted_by / promoted_by_baker_id / promoted_at to ai3d_generations.

select
  count(*) filter (where column_name in ('promoted_by','promoted_by_baker_id','promoted_at')) as cols_present,
  case when count(*) filter (where column_name in ('promoted_by','promoted_by_baker_id','promoted_at')) = 3
       then 'APPLIED — 158 has run here'
       else '-- MISSING — apply migrations/158_ai3d_promoted_by.sql (safe to re-run) --' end as verdict
from information_schema.columns
where table_schema = 'public' and table_name = 'ai3d_generations';

-- Who has promoted what. All NULL is CORRECT until a promotion action exists.
select
  count(*)                                              as rows_total,
  count(*) filter (where promoted_element_id is not null) as promoted,
  count(*) filter (where promoted_by_baker_id is not null) as promoted_by_a_baker,
  count(*) filter (where promoted_at is not null
                     and promoted_by_baker_id is null)    as promoted_by_staff
from ai3d_generations;

-- ⚠️ Should be zero: a row that became an element but recorded nobody doing it.
select count(*) as promoted_without_evidence
  from ai3d_generations
 where promoted_element_id is not null and promoted_at is null;
