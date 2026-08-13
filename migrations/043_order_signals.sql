-- ── 043: what an order was FOR ──────────────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Plan: spattoo-docs/plans/order-signals.md — "Phase 0 — capture"
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- The storefront already ASKS the occasion and who the cake is for. Both are then
-- flattened into special_instructions as English:
--
--     Occasion: Birthday
--     For: A child
--
-- Those two are the strongest predictors a cake recommender has, and they are being
-- written as a sentence. Recovering them later means parsing baker-visible free text
-- that mixes our generated lines with whatever the customer typed — text whose wording
-- has already changed several times, and which a baker can edit. It will not aggregate
-- in SQL and it will not survive a rewording.
--
-- So this is urgent in a way most schema work is not: every enquiry that lands before
-- it is a sample we cannot get back. The recommender that uses this does not exist yet;
-- the history it will need only starts accruing once these columns do.
--
-- ── THE RULE THAT DECIDED THESE COLUMNS ─────────────────────────────────────────────
--   Structure what we AGGREGATE.  Prose what the baker READS.
--
-- Occasion and recipient are aggregated, so they are columns. The MESSAGE is read, so
-- it stays free text in special_instructions — forcing structure on it would be worse
-- than useless. special_instructions keeps rendering all of it either way, because the
-- baker still needs one place to read. Structured for us, prose for them.
--
-- ── WHY NOT A NEW TABLE ─────────────────────────────────────────────────────────────
-- One row per order, one value each, always queried with the order. A side table would
-- buy nothing and cost a join on every read.

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS occasion    text,
  ADD COLUMN IF NOT EXISTS recipient   text,
  ADD COLUMN IF NOT EXISTS age_band    text,
  ADD COLUMN IF NOT EXISTS cake_number integer;

-- ── occasion ────────────────────────────────────────────────────────────────────────
-- A FIXED vocabulary. Free text cannot be aggregated — "bday", "Birthday" and "b'day"
-- are three rows and no chart. `other` is honest and stops the enum growing a tail
-- nobody queries. Customer-facing labels stay warm ("Just because"); this is the key.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_occasion_valid') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_occasion_valid CHECK (
      occasion IS NULL OR occasion IN
      ('birthday','anniversary','wedding','baby_shower','engagement',
       'farewell','corporate','festival','other'));
  END IF;

  -- ── recipient ─────────────────────────────────────────────────────────────────────
  -- WHO it is for. Note what is NOT here: "crowd". The old vocabulary mixed two axes —
  -- child/adult is a recipient, crowd is an audience SIZE — and size is already on the
  -- order as weight_kg. A conflated axis is harder to reason about than any of the
  -- questions this migration is meant to answer.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_recipient_valid') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_recipient_valid CHECK (
      recipient IS NULL OR recipient IN
      ('child','adult','couple','family','friends','colleagues'));
  END IF;

  -- ── age_band ──────────────────────────────────────────────────────────────────────
  -- Coarse, deliberately, and NOT an exact age:
  --
  --   * exact age + delivery_date is a DATE OF BIRTH, and the message on the cake is
  --     nearly always the recipient's name. A number would make this table name + DOB
  --     of a minor, held indefinitely — a materially different obligation under DPDP
  --     for a small modelling gain.
  --   * the decision boundary is coarse. Six versus seven is noise; one versus six is
  --     real, which is why first_birthday is its own value rather than part of a 0-5
  --     bucket — a smash cake with allergen caution is a different cake.
  --   * coverage beats precision. A band is one tap; a typed number gets skipped or
  --     guessed. Precision you do not collect is worth nothing.
  --   * cake_template_attrs already chose min_age/max_age over an exact age.
  --
  -- The honest cost: a number cannot be recovered from a band. Mitigated by choosing
  -- bands that are meaningful rather than arbitrary.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_age_band_valid') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_age_band_valid CHECK (
      age_band IS NULL OR age_band IN
      ('first_birthday','toddler','child','teen','adult','senior'));
  END IF;

  -- ── cake_number ───────────────────────────────────────────────────────────────────
  -- What goes ON the cake, and it is NOT an age. 25 on an anniversary cake is years
  -- married; on a birthday it is an age; it could be a jersey number. Store what the
  -- baker has to pipe, and never silently record it as an age.
  --
  -- The privacy objection above largely does not apply here: a number the customer asks
  -- to be piped in icing and displayed at a party is volunteered FOR PUBLICATION, and
  -- the cake cannot be made without it. Operational necessity is a different basis from
  -- asking a parent for a child's age in order to model them.
  --
  -- Bounded 0-9999: a year (2026) is a legitimate value, a negative one never is, and
  -- an unbounded integer is a decoration nobody can pipe.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_cake_number_sane') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_cake_number_sane CHECK (
      cake_number IS NULL OR cake_number BETWEEN 0 AND 9999);
  END IF;
END $$;

COMMENT ON COLUMN public.orders.occasion IS
  'What the cake is for: birthday | anniversary | wedding | baby_shower | engagement | farewell | corporate | festival | other. Fixed vocabulary so it aggregates; also rendered into special_instructions for the baker to read. NULL = not asked or not answered.';
COMMENT ON COLUMN public.orders.recipient IS
  'WHO the cake is for: child | adult | couple | family | friends | colleagues. Deliberately NOT an audience size — that is weight_kg. NULL = not answered.';
COMMENT ON COLUMN public.orders.age_band IS
  'Coarse age of the recipient: first_birthday | toddler | child | teen | adult | senior. Never an exact age — exact age plus delivery_date is a date of birth, and the cake message is usually the name. NULL = not answered.';
COMMENT ON COLUMN public.orders.cake_number IS
  'The number to put ON the cake (a 6, a 50, a 2026). Production data the baker pipes — NOT an age: 25 on an anniversary cake is years married. Only readable as an age when occasion = birthday, and even then it is an inference.';

-- Aggregation is the whole point, and every question starts "for this baker".
CREATE INDEX IF NOT EXISTS orders_baker_occasion_idx  ON public.orders (baker_id, occasion)  WHERE occasion  IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_baker_recipient_idx ON public.orders (baker_id, recipient) WHERE recipient IS NOT NULL;

COMMIT;
