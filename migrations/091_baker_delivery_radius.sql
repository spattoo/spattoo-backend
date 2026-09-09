-- ── 091: how far a baker will deliver ───────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Plan: spattoo-docs/plans/delivery-address.md
--
-- ── WHY A COLUMN, WHEN THE SETTING ALREADY EXISTS ───────────────────────────────────
-- Settings has had a Delivery Radius field for a while, writing `delivery.radius_km`
-- into the `settings` jsonb. That was fine while nobody could see it. It stops being
-- fine the moment the storefront SHOWS the number to customers, because a jsonb key has
-- no default, no type and no CHECK — the only thing standing between a typo and a public
-- promise is `min`/`max` on an <input>, which is a hint to a browser and nothing to an
-- API. Anything that can POST /baker/settings can store -5, "ten", or 99999.
--
-- This is the argument migration 042 already made for `lead_time_days`, in its own words:
-- a column because "it is queried and constrained, which a jsonb key cannot be".
--
-- ── WHY NOW IS THE CHEAP MOMENT ─────────────────────────────────────────────────────
-- Checked before writing this: NO baker has a `radius_km` in their settings blob. One
-- has `{"home_delivery": false}` and that is all. So there is nothing to migrate, no bad
-- data to clean, and no baker whose storefront changes. After the storefront starts
-- rendering the number, none of that stays true.
--
-- ── ⚠️ IT IS A PROMISE, NOT A GATE. Nothing can compute against it ──────────────────
-- `bakers` holds a postal address and NO latitude/longitude, so a radial distance has no
-- origin to measure from. The enquiry side is no better: it collects an AREA and a
-- PINCODE, and a pincode is a region rather than a point — a large one can sit partly
-- inside and partly outside a 5 km circle.
--
-- So this number is DISPLAYED to the customer ("delivers within 5 km") and JUDGED by the
-- baker, who reads the area and decides. Honest, and needs no geocoding. It must never be
-- worded in the UI as though the system were checking, and must never be filtered on.
-- Enforcement wants a served-pincodes list — exact, no geocoding, and in the same unit
-- the customer is already typing. Radius for the promise, list for the check.
--
-- ── NULL, AND WHY NOT A SECOND BOOLEAN ──────────────────────────────────────────────
-- NULL = pickup only, and is the default, so no baker's storefront changes the day this
-- lands. The existing `settings.delivery.home_delivery` toggle STAYS for now — retiring it
-- is a separate decision and this migration deliberately does not make it. But note the
-- redundancy: NULL already says "does not deliver", so the two can contradict each other,
-- and the API nulls the radius whenever the toggle is off to stop that reaching anyone.
--
-- ── RANGE ───────────────────────────────────────────────────────────────────────────
-- 0 < km <= 500, matching the <input min={1} max={500}> the screen already offers, so
-- this constrains what the UI always claimed rather than quietly changing a product
-- decision. 500 km is generous for a home baker; tightening it later is a one-line
-- migration and, until a storefront renders it, breaks nothing.
-- 0 is REJECTED deliberately: "delivers 0 km" is not how a baker says they do not
-- deliver — clearing the field is.

BEGIN;

ALTER TABLE public.bakers
  ADD COLUMN IF NOT EXISTS delivery_radius_km numeric(5,1);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bakers_delivery_radius_km_sane') THEN
    ALTER TABLE public.bakers
      ADD CONSTRAINT bakers_delivery_radius_km_sane
      CHECK (delivery_radius_km IS NULL OR (delivery_radius_km > 0 AND delivery_radius_km <= 500));
  END IF;
END $$;

COMMENT ON COLUMN public.bakers.delivery_radius_km IS
  'How far this baker will deliver, in km. NULL = pickup only, the default and today''s behaviour for every baker. DISPLAYED to the customer on the storefront and JUDGED by the baker — never computed: bakers carry no lat/lng and the enquiry collects an area + pincode, which is a region rather than a point. Do not filter on it; enforcement wants a served-pincodes list. Not a delivery fee, not served areas.';

COMMIT;
