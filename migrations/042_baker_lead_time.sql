-- ── 042: how much notice a baker needs ──────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Plan: spattoo-docs/plans/storefront-facets.md — "Lead time"
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- The worst outcome in the whole enquiry funnel is a customer choosing a date, waiting a
-- day, and being told "sorry, we can't do the 14th". Every round-trip the storefront
-- facets remove is undone by that one — and it is entirely avoidable, because the baker
-- knows the answer before the customer ever asks.
--
-- So the date picker refuses dates inside the baker's window while they are still on the
-- page. That needs one number.
--
-- ── WHY IT DEFAULTS TO ZERO ─────────────────────────────────────────────────────────
-- Nothing captures this yet — there is no baker-facing field, by design. Shipping the
-- column now means the storefront can be built against the real thing rather than a
-- placeholder, and switching it on later is a form field writing to a column that is
-- already read. Zero is "no notice required", which is exactly today's behaviour, so no
-- baker's storefront changes the day this lands.
--
-- ── WHAT THIS IS NOT ────────────────────────────────────────────────────────────────
-- Not capacity, and not blackout dates. "I need two days" is a different fact from "I am
-- closed on the 15th" and from "I can only make four cakes on a Saturday". Those want
-- their own shapes and are deliberately left out — see the plan's open questions, which
-- also record the one rule that matters when they arrive: raising a lead time must never
-- retroactively invalidate a date somebody has already been given.

BEGIN;

ALTER TABLE public.bakers
  ADD COLUMN IF NOT EXISTS lead_time_days integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bakers_lead_time_days_sane') THEN
    -- A ceiling as well as a floor: a typo'd 300 would silently make a baker unbookable
    -- for most of a year, and nobody would look at this column to find out why.
    ALTER TABLE public.bakers
      ADD CONSTRAINT bakers_lead_time_days_sane CHECK (lead_time_days BETWEEN 0 AND 90);
  END IF;
END $$;

COMMENT ON COLUMN public.bakers.lead_time_days IS
  'Minimum notice in days before a delivery date this baker will accept — 0 means same-day is fine, which is the default and today''s behaviour. The storefront date picker refuses anything inside the window, so a customer learns on the page rather than a day later. Not capacity, not blackout dates.';

COMMIT;
