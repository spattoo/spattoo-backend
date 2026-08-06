-- ── 059: five more occasions ────────────────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Plan: spattoo-docs/plans/order-signals.md — "occasion — a fixed vocabulary"
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- The list is not only a form field. It is the clearest place we tell a customer what a
-- cake is FOR, and a short list quietly says the answer is birthdays and weddings.
--
-- A baby shower with a cake was not a thing in India a few years ago and is now ordinary.
-- That did not happen because bakers waited for demand — it happened because the occasion
-- became visible. A list that names an occasion is a list that suggests it.
--
--   bridal_shower   the same normalisation as baby_shower, one step earlier in the sequence
--   new_home        see below
--   graduation      real, growing, and had nowhere to go but "Just because"
--   new_job         distinct from `corporate`, which is a TEAM event; this is one person
--   love            see below
--
-- ── new_home, NOT housewarming ──────────────────────────────────────────────────────
-- A Griha Pravesh is a long day of ritual, and cake is not yet part of it. "Housewarming"
-- names a PARTY that in many homes is not what happens. "New home" names the milestone,
-- which is true whether it is the traditional day, the evening afterwards, or friends
-- coming round to a new flat — the nudge without the assumption about format.
--
-- ── love IS NOT AN OCCASION, AND IS HERE ANYWAY ─────────────────────────────────────
-- Every other value is an event with a date. This one is a MOTIVE, and it earns its place
-- twice over: it covers Valentine's without pinning a date, and unlike `other` it is a
-- real signal — the suggester can argue from "rich and a little special" where "Just
-- because" tells it nothing at all. It sits last with `other`, since both are reasons
-- rather than events.
--
-- ── ⚠️ THE CONSTRAINT IS THE WHOLE POINT OF THIS FILE ───────────────────────────────
-- The storefront cannot add an occasion on its own. A value the CHECK does not know
-- reaches the insert and surfaces as an unreadable 500 on a customer's enquiry — the plan
-- doc warns about exactly this for /orders/manual. So the constraint widens FIRST, and
-- the client list follows.
--
-- Dropped and recreated rather than added to: a CHECK cannot be extended in place, and
-- naming it the same keeps 043's name as the one to look for.

BEGIN;

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_occasion_valid;

ALTER TABLE public.orders ADD CONSTRAINT orders_occasion_valid CHECK (
  occasion IS NULL OR occasion IN
  ('birthday','anniversary','wedding','engagement','bridal_shower','baby_shower',
   'new_home','graduation','new_job','festival','farewell','corporate','love','other'));

COMMENT ON COLUMN public.orders.occasion IS
  'What the cake is for. Fixed vocabulary, widened by 059: birthday | anniversary | wedding | engagement | bridal_shower | baby_shower | new_home | graduation | new_job | festival | farewell | corporate | love | other. `love` is a motive rather than an event — it covers Valentine''s without pinning a date, and unlike `other` it gives the flavour suggester something to argue from. Customer-facing labels live in spattoo-core cakeDraft.js OCCASIONS and must stay in step with this list.';

COMMIT;

-- Verify — the constraint accepts the new values:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'orders_occasion_valid';
