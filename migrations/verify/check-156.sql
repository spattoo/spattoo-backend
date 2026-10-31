-- ── Is migration 156 applied here? ──────────────────────────────────────────────────────────────
--
-- READ-ONLY. Nothing here writes or locks. Safe on production.
-- Paste into the Supabase SQL editor of the environment you are checking.
--
-- 156 sets `generate_3d_decorations` in subscription_plans.features: true on blaze and forge, false
-- on spark and flame. There is no migration ledger, so the only honest question is whether the
-- database actually carries the flag.
--
-- `features -> 'generate_3d_decorations' is not null` rather than `features ? '...'` on purpose:
-- some SQL clients read `?` as a parameter placeholder and mangle the query.
--
-- ⚠️ A MISSING FLAG IS NOT AN OPEN DOOR. The registry fallback is false, so an environment where
-- this never ran refuses everybody rather than allowing everybody. What it costs is a paying Blaze
-- baker being refused — a support ticket, not a bill.

select
  name,
  features -> 'generate_3d_decorations'          as generate_3d,
  case
    when features -> 'generate_3d_decorations' is null then '-- MISSING --'
    when name in ('blaze','forge') and (features ->> 'generate_3d_decorations') = 'true'  then 'APPLIED'
    when name in ('spark','flame') and (features ->> 'generate_3d_decorations') = 'false' then 'APPLIED'
    else '-- WRONG VALUE --'
  end                                            as status
from subscription_plans
where name in ('spark','flame','blaze','forge')
order by name;

-- One line: has 156 fully landed?
select
  count(*) filter (where features -> 'generate_3d_decorations' is not null) as plans_with_flag,
  count(*)                                                                  as plans_checked,
  case when count(*) filter (where features -> 'generate_3d_decorations' is not null) = count(*)
       then 'APPLIED — 156 has run here'
       else '-- MISSING — apply migrations/156_generate_3d_is_blaze.sql (safe to re-run) --'
  end as verdict
from subscription_plans
where name in ('spark','flame','blaze','forge');
