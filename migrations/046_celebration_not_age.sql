-- ── 046: the celebration, not the child's age ───────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Plan: spattoo-docs/plans/order-signals.md — "The celebration, not the age"
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- 043 added `age_band`, and the storefront asked "Roughly how old?". Both are about a
-- PERSON — usually a child, and usually not the person answering.
--
-- That put the schema at odds with our own Privacy Policy §10 ("not directed to
-- children… we do not knowingly collect personal data from children"), and put the
-- product inside the conversation DPDP Section 9 governs: children's personal data,
-- verifiable parental consent, and limits on monitoring or profiling directed at
-- children. We were storing an attribute of a child, keeping it, and using it to improve
-- recommendations across orders.
--
-- The recommender never needed the person. It needed the OCCASION:
--
--     "how old is the child?"        an attribute of a data principal
--     "is it a first birthday?"      a description of an event
--
-- A first birthday is a milder cake — smash cake, first taste, allergen caution — and
-- that is a fact about the OCCASION, not about the guest. Every rule that read `age_band`
-- reads the same signal from `celebration` and argues exactly as well.
--
-- ── WHAT THIS DOES AND DOES NOT CLAIM ───────────────────────────────────────────────
-- It does not pretend the inference disappears: "a first birthday" plainly implies a
-- one-year-old. What changes is what we ASK for, what we STORE, and what the column
-- MEANS — an event category rather than a person's age. We ask about the party, we keep
-- a party type, and no field on this table is an attribute of a child.
--
-- It also reads better: a customer knows what kind of party they are throwing without
-- having to estimate anybody's age.
--
-- ── WHY A RENAME AND NOT A SECOND COLUMN ────────────────────────────────────────────
-- 043 shipped the same day; there is little or no data, and two columns meaning almost
-- the same thing is how the ambiguity survives. The old values map cleanly, so the data
-- that does exist is carried over rather than dropped.

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS celebration text;

-- Carry over anything 043 collected. toddler/child both become a children's party — the
-- distinction was never used by a rule, and it is the one that most looked like an age.
UPDATE public.orders SET celebration = CASE age_band
    WHEN 'first_birthday' THEN 'first_birthday'
    WHEN 'toddler'        THEN 'kids_party'
    WHEN 'child'          THEN 'kids_party'
    WHEN 'teen'           THEN 'teen_party'
    WHEN 'adult'          THEN 'grown_ups'
    WHEN 'senior'         THEN 'elders'
    ELSE NULL
  END
 WHERE age_band IS NOT NULL AND celebration IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_celebration_valid') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_celebration_valid CHECK (
      celebration IS NULL OR celebration IN
      ('first_birthday','kids_party','teen_party','grown_ups','elders'));
  END IF;
END $$;

-- age_band goes. Keeping it would leave the exact field the change exists to remove
-- sitting in the table, and a future reader would not know which one to write.
ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_age_band_valid;
ALTER TABLE public.orders DROP COLUMN IF EXISTS age_band;

COMMENT ON COLUMN public.orders.celebration IS
  'What KIND of celebration this cake is for: first_birthday | kids_party | teen_party | grown_ups | elders. Replaces 043''s age_band, which was an attribute of a person — usually a child. This describes the EVENT, which is what the flavour suggester actually needs: a first birthday is a milder cake because of the occasion, not because of the guest. NULL = not asked or not answered.';

CREATE INDEX IF NOT EXISTS orders_baker_celebration_idx
  ON public.orders (baker_id, celebration) WHERE celebration IS NOT NULL;

COMMIT;
