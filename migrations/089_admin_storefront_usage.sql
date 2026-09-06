-- Storefront usage, per baker, for the admin view. The read side of migration 088.
--
-- ⚠️ THE WHOLE POINT IS THE BAKERS WITH NO ROWS. `storefront_views` only holds days that HAD
-- traffic, so a dormant storefront is represented by ABSENCE. Aggregating the views table alone
-- answers "how busy are the busy ones", which is the question nobody asked — the dormant bakers,
-- the entire reason this exists, simply would not appear in the result at all.
--
-- Hence LEFT JOIN FROM bakers, not from storefront_views. Every active baker comes back, with zero
-- and a null last_seen when nothing was ever recorded.
--
-- WHY A FUNCTION AND NOT TWO QUERIES JOINED IN THE API: supabase-js cannot express a left join with
-- aggregation, so the alternative is fetching every baker plus every view row and joining in JS.
-- That works today and stops working quietly — and `last_seen` is the part that breaks first: it
-- must look at ALL history, not the window, or a baker dormant for 60 days is indistinguishable
-- from one that never had a single visit. Those are different problems and want different actions.
--
-- `p_since` is passed IN rather than computed as `current_date - n`. The database runs in UTC and
-- `storefront_views.day` is written in the baker's timezone (config.storefront.viewsTz), so a
-- cutoff derived here would drift from the dates it is comparing against by up to a day. The API
-- computes it with the SAME helper that writes the rows (services/storefrontViews.js), which is
-- what keeps the two from disagreeing.

create or replace function admin_storefront_usage(p_since date)
returns table (
  baker_id             uuid,
  slug                 text,
  name                 text,
  storefront_published boolean,
  views                integer,
  active_days          integer,
  last_seen            date
)
language sql
stable
as $$
  select
    b.id,
    b.slug,
    b.name,
    b.storefront_published,
    -- Windowed: what happened lately.
    coalesce(sum(v.views) filter (where v.day >= p_since), 0)::int   as views,
    -- How many distinct days saw ANY traffic — separates "one big spike" from "steady trickle",
    -- which a single total cannot.
    count(v.day) filter (where v.day >= p_since)::int                as active_days,
    -- Deliberately NOT windowed. "Never" and "not since July" are different answers.
    max(v.day)                                                       as last_seen
  from bakers b
  left join storefront_views v on v.baker_id = b.id
  where b.is_active
  group by b.id, b.slug, b.name, b.storefront_published
$$;

-- Same lockdown as 088: the API reads this with the service role, and the anon key ships in the
-- browser bundle. Supabase's default privileges grant execute to anon + authenticated, so revoking
-- from `public` alone would not be enough; they are named. Without this, anyone could enumerate
-- every baker's traffic — and the slug and name come back with it.
revoke all on function admin_storefront_usage(date) from public, anon, authenticated;
grant execute on function admin_storefront_usage(date) to service_role;
