-- ── Is migration 157 applied here? ──────────────────────────────────────────────────────────────
--
-- READ-ONLY. Nothing here writes or locks. Safe on production.
--
-- 157 adds ai3d_generations.baker_id (nullable, FK to bakers) and backfills it from baker_appusers.

select
  case when exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai3d_generations' and column_name = 'baker_id')
  then 'APPLIED — baker_id exists'
  else '-- MISSING — apply migrations/157_ai3d_baker_id.sql (safe to re-run) --' end as verdict;

-- How the rows split. NULL is a staff run, not a fault.
select
  count(*)                                        as rows_total,
  count(*) filter (where baker_id is not null)    as owned_by_a_bakery,
  count(*) filter (where baker_id is null)        as staff_or_unmapped
from ai3d_generations;

-- ⚠️ A row that is NULL but whose creator IS a baker appuser means the backfill has not run (or the
-- row was written by code that predates 157). Should be zero.
select count(*) as unmapped_but_mappable
  from ai3d_generations g
  join baker_appusers a on a.auth_user_id = g.created_by
 where g.baker_id is null;
