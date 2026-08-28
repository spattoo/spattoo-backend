-- ── 078: ask for egg or eggless, instead of inferring it from silence ───────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ⚠️ ONE ROW, and it is the only row in this table that does not RESTRICT anything.
--
-- The order form asked "dietary requirements?" and offered Eggless among the exceptions. Against
-- that question a customer who eats egg correctly answers "none" — so the commonest attribute of an
-- Indian cake order was decided by SILENCE, and nothing downstream could tell "they want egg" from
-- "nobody asked them". Meanwhile the customer who wants eggless arrives EXPECTING the choice, and
-- finds half of it filed under dietary requirements: here egg-vs-eggless sits closer to flavour
-- than to an allergy — it moves the price, the flavour list and often the lead time.
--
-- ── WHY THIS BELONGS IN dietary_requirements AT ALL ────────────────────────────────────
-- It is a fair objection that a table of requirements should not carry a non-requirement. Two
-- things are bought by putting it here, and both are unavailable any other way:
--
--   1. baker_dietary_exclusions can now say "WE ARE A PURE-VEG BAKERY" — a row against `egg`.
--      That fact was previously UNSAYABLE. The table could already carry "we don't do eggless"
--      and had no way to carry its mirror, so a fully-eggless kitchen (very common in this
--      market) was invisible to us and had to show its customers a choice it would then refuse.
--      No new table, no new pattern: the existing hide-a-diet-option rule does exactly the
--      right thing in both directions.
--
--   2. "With egg" becomes DISTINGUISHABLE FROM UNASKED. The "no dietary requirements" chip
--      (2026-08-27) exists precisely because silence meant two things at once. Storing the egg
--      answer as the ABSENCE of `eggless` would have reintroduced that, one question later.
--
-- ⚠️ THE COST, AND WHERE IT IS PAID. Every surface that flags a DEVIATION must exclude this key,
-- or it fires on nearly every order and stops being read — taking the eggless and nut-free
-- warnings down with it. That is one helper, `restrictions()` in spattoo-core/src/orders/dietary.js,
-- applied at the bench sheet, the printed band and the order-list row. The order DETAIL still shows
-- it: that surface is the record of what the customer actually said. Gated by
-- `npm run check:dietary-egg`.
--
-- ⚠️ EXPLICIT id, matching supabase/seed-lookups.sql. The join table stores the smallint, so dev
-- and prod drifting to different ids for the same key would make every dump and every hand-written
-- fix silently wrong. The identity sequence is bumped afterwards so the next insert does not
-- collide with the id claimed here.
insert into dietary_requirements (id, key, label, kind, sort_order, is_active) values
  (7, 'egg', 'With egg', 'diet', 5, true)
on conflict (key) do update set
  label      = excluded.label,
  kind       = excluded.kind,
  sort_order = excluded.sort_order,
  is_active  = excluded.is_active;

select setval(
  pg_get_serial_sequence('public.dietary_requirements', 'id'),
  coalesce((select max(id) from public.dietary_requirements), 1)
);

-- ── NOT DONE HERE, deliberately ────────────────────────────────────────────────────────
-- 1. No backfill. Orders placed before this carry no egg answer and must not be given one:
--    inventing `egg` for every old order would write an assertion into `source='customer'`
--    that no customer ever made, which is the single thing this feature is built not to do.
--    They read as "not asked", which is exactly what happened.
-- 2. No `implies` column. Vegan and Jain both CONTAIN the eggless rule, and the form enforces
--    that (a vegan cake cannot be ordered with egg). Two rows is not enough to justify a
--    column and a resolution path; the pair is named once, in dietary.js, with a note. A third
--    case is what would earn the migration — halal and kosher, the obvious candidates, do not
--    imply eggless, so that day may not come.
