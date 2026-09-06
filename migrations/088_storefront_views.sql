-- Storefront usage, per baker per day. A COUNTER, not an event log: one row per baker per day,
-- incremented in place. 100 bakers is ~36,500 rows a year, 1,000 bakers ~365,000 — a rounding error.
--
-- WHY THIS EXISTS: "is this baker's storefront being used at all" had no answer. Nothing counted an
-- anonymous visit — `source: 'storefront_visit'` on a customer row only appears once somebody has
-- VERIFIED a contact, which is a prospect, not a pageview. So the whole top of the funnel, and every
-- dormant storefront, was invisible.
--
-- WHY NOT GOOGLE ANALYTICS: ad blockers, GA4 data thresholding and (other)-bucketing all corrupt the
-- long tail, which is exactly the part we care about — a baker with three real visits can record
-- ZERO, and zero is the answer we would act on. GA's BigQuery export fixes what Google does to data
-- after collecting it; it cannot recover a hit that was never sent. It also keeps Google off the
-- bakers' own branded pages, which is the call SEC-WEB-7 already made when it removed the font CDNs.
-- Full reasoning: spattoo-docs/plans/analytics.md.
--
-- WHY NOT A ROW PER VIEW: a daily total answers the question completely. A per-view log would grow
-- without bound to answer a question nobody is asking, and would hold a visitor-level record of
-- anonymous people we have no other reason to keep (DPDP storage limitation).
--
-- ⚠️ ABSENCE OF A ROW IS THE SIGNAL. Days with no traffic have NO ROW — we never write zeros. So
-- "which bakers got nothing in the last 30 days" is a LEFT JOIN from bakers, not a `where views = 0`.
-- Written the obvious way, the query silently returns only bakers who had traffic and the dormant
-- ones — the entire point — never appear.

create table storefront_views (
  baker_id   uuid        not null references bakers(id) on delete cascade,
  day        date        not null,
  views      integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (baker_id, day)
);

-- The composite primary key IS the upsert target, so no extra unique index is needed. This one
-- serves the other direction: "everything across the last 30 days", which the admin view reads.
create index storefront_views_day_idx on storefront_views(day desc);

-- ── Atomic increment ─────────────────────────────────────────────────────────────────────────────
-- supabase-js `.upsert()` can only SET values, never `views = views + 1`, and a read-then-write from
-- the API would lose counts under concurrency. So the increment is one statement in the database.
--
-- `p_day` is passed IN rather than computed here: which day it is depends on the baker's timezone,
-- and that lives in config (config.storefront.viewsTz) so it is tunable per environment — the same
-- reasoning as jobs.deliveryDigestTz, which carries a long comment about exactly this bug.
create or replace function increment_storefront_view(p_baker_id uuid, p_day date)
returns void
language sql
as $$
  insert into storefront_views (baker_id, day, views)
  values (p_baker_id, p_day, 1)
  on conflict (baker_id, day)
  do update set views = storefront_views.views + 1, updated_at = now();
$$;

-- ── Access ───────────────────────────────────────────────────────────────────────────────────────
-- RLS ON WITH NO POLICIES: the service role bypasses RLS, and the service role is the ONLY thing
-- that touches this table — the API writes it (services/storefrontViews.js) and the API reads it for
-- the admin view. spattoo-admin uses Supabase for AUTH ONLY and fetches its data over the API with a
-- bearer token (spattoo-admin/src/lib/api.js), so nothing in a browser needs direct access.
--
-- This deliberately does NOT follow the text_styles pattern (`for select to authenticated using
-- (true)`). That is right for a bounded lookup table everyone may read; this is PER-TENANT data, and
-- the same policy here would let any signed-in baker read every other baker's traffic numbers.
alter table storefront_views enable row level security;

-- RLS does not govern FUNCTION EXECUTION, so the grant has to be revoked separately — otherwise
-- anyone holding the anon key (it ships in the browser bundle) could call the RPC directly and
-- inflate any baker's count. Supabase's default privileges grant execute to anon + authenticated, so
-- revoking from `public` alone is not enough; they are named explicitly.
revoke all on function increment_storefront_view(uuid, date) from public, anon, authenticated;
grant execute on function increment_storefront_view(uuid, date) to service_role;
