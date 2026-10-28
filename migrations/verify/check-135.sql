-- ── Is migration 135 applied here? ──────────────────────────────────────────────────────────────
--
-- READ-ONLY. Nothing here writes or locks. Safe on production.
-- Paste into the Supabase SQL editor of the environment you are checking.
--
-- 135 sets a `build_film` flag in subscription_plans.features: true on blaze and forge, false on
-- spark and flame. There is no migration ledger, so the only honest question is whether the
-- database actually carries the flag.
--
-- `features -> 'build_film' is not null` rather than `features ? 'build_film'` on purpose: some
-- SQL clients read `?` as a parameter placeholder and mangle the query.

select
  name,
  features -> 'build_film'                       as build_film,
  case
    when features -> 'build_film' is null then '-- MISSING --'
    when name in ('blaze','forge') and (features ->> 'build_film') = 'true'  then 'APPLIED'
    when name in ('spark','flame') and (features ->> 'build_film') = 'false' then 'APPLIED'
    else '-- WRONG VALUE --'
  end                                            as status
from subscription_plans
where name in ('spark','flame','blaze','forge')
order by name;

-- One line: has 135 fully landed?
select
  count(*) filter (where features -> 'build_film' is not null) as plans_with_flag,
  count(*)                                                     as plans_checked,
  case when count(*) filter (where features -> 'build_film' is not null) = count(*)
       then 'APPLIED — 135 has run here'
       else '-- MISSING — apply migrations/135_build_film_entitlement.sql (safe to re-run) --'
  end as verdict
from subscription_plans
where name in ('spark','flame','blaze','forge');
