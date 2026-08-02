-- ── 037: flavour pricing, and who is allowed to see it ──────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run — see
-- "RE-RUN SAFETY" below, which is not boilerplate here: one step of this migration is
-- destructive if it runs twice unguarded.
--
-- Plan: spattoo-docs/plans/flavour-pricing.md
--
-- ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────
-- A baker puts a price per kg on each flavour they offer. That one number has two uses,
-- and they are independent:
--
--   published  (the baker's choice)  the storefront answers "how much is 1kg chocolate?"
--                                    without the baker touching it
--   internal   (always)              an enquiry arrives with a computed base, so issuing
--                                    a quote is closer to one tap
--
-- The second is why a baker who would never publish a price still fills this in, and it
-- is why `price_visibility` defaults to 'private': entering a price and publishing it are
-- separate acts, and only the second is a decision anyone has to make. If typing a rate
-- silently published it we would have broken that promise the moment it was used.
--
-- ── WHY THIS IS NOT A CUSTOMER-FACING ESTIMATE ──────────────────────────────────────
-- PRICING_AND_QUOTE_PLAN §1 bans showing the customer a SPATTOO estimate, because a wrong
-- computed number becomes a public wrong number that costs the baker an order. A per-kg
-- rate the baker typed is not that: nothing computes it and nothing infers it. It is the
-- baker's own published fact about their own business, like their flavour list or their
-- delivery areas. The ban stands, untouched, for anything derived — a total for a custom
-- cake, a price read off a photo, the suggested price the baker sees before quoting.
--
-- ── WHY THE EXCLUSIONS TABLE IS WIDENED, NOT REPLACED ───────────────────────────────
-- baker_flavour_exclusions is already a per-baker overlay on the global flavour list,
-- keyed (baker_id, flavour_id) with a unique constraint. It simply encodes its only
-- setting as ROW PRESENCE. A price is a second setting, so the row becomes a record and
-- presence stops meaning "excluded" — it now means "this baker has said something about
-- this flavour". The table is renamed to match, because a table called `exclusions`
-- holding "offered at 1200/kg" lies to whoever reads it next.
--
-- Sparse stays sparse: no row is written for a flavour the baker simply leaves on and
-- does not price. That is not an optimisation — a baker who saved last month has no row
-- for a flavour added yesterday either, so "no row" has to be a state the readers handle
-- correctly regardless. Keeping it common keeps it correct.
--
-- ── WHY `flavours` IS NOT TOUCHED ───────────────────────────────────────────────────
-- A baker's own flavours already have a home: baker_flavours, which GET /api/flavours
-- already unions in with source:'baker', and which baker_flavour_dietary_conflicts already
-- covers through its exclusive arc over (flavour_id, baker_flavour_id). So a custom
-- flavour carries its price DIRECTLY — the baker owns that row and there is nothing to
-- overlay. The overlay exists only because global flavours are shared.
--
-- ── RE-RUN SAFETY ───────────────────────────────────────────────────────────────────
-- Everything is guarded, and step 2 is guarded for a reason worth stating plainly: the
-- backfill `UPDATE ... SET offered = false` is correct exactly once, when every row in the
-- table is by definition an exclusion. Re-run later, unguarded, it would switch off every
-- flavour every baker has priced. So the backfill lives INSIDE the branch that adds the
-- column, and can only ever run in the same transaction that created it.

BEGIN;

-- ── 1 ── the exclusion set becomes a settings record ────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'baker_flavour_exclusions')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema = 'public' AND table_name = 'baker_flavour_settings')
  THEN
    ALTER TABLE public.baker_flavour_exclusions RENAME TO baker_flavour_settings;
    RAISE NOTICE 'baker_flavour_exclusions renamed to baker_flavour_settings.';
  END IF;
END $$;

-- Postgres does not rename constraints with their table. Left alone, a duplicate-key error
-- on the settings table reports "violates unique constraint
-- baker_flavour_exclusions_baker_id_flavour_id_key", which sends the next reader looking
-- for a table that no longer exists.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.baker_flavour_settings'::regclass
      AND conname LIKE 'baker_flavour_exclusions%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.baker_flavour_settings RENAME CONSTRAINT %I TO %I',
      r.conname,
      replace(r.conname, 'baker_flavour_exclusions', 'baker_flavour_settings')
    );
  END LOOP;
END $$;

-- ── 2 ── the settings themselves ────────────────────────────────────────────────────
-- `offered` and its backfill are one indivisible step. See RE-RUN SAFETY above.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'baker_flavour_settings'
                   AND column_name = 'offered')
  THEN
    ALTER TABLE public.baker_flavour_settings
      ADD COLUMN offered boolean NOT NULL DEFAULT true;

    -- Every row in existence at this instant was an exclusion. This is the ONLY moment
    -- that is true, which is why it cannot live outside this branch.
    UPDATE public.baker_flavour_settings SET offered = false;

    RAISE NOTICE 'offered added; % pre-existing exclusion row(s) set to false.',
      (SELECT count(*) FROM public.baker_flavour_settings WHERE offered = false);
  END IF;
END $$;

ALTER TABLE public.baker_flavour_settings
  ADD COLUMN IF NOT EXISTS price_per_kg numeric(10,2),
  ADD COLUMN IF NOT EXISTS display_name text,
  ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'baker_flavour_settings_price_non_negative')
  THEN
    ALTER TABLE public.baker_flavour_settings
      ADD CONSTRAINT baker_flavour_settings_price_non_negative
      CHECK (price_per_kg IS NULL OR price_per_kg >= 0);
  END IF;
END $$;

COMMENT ON TABLE public.baker_flavour_settings IS
  'Sparse per-baker overlay on the global flavours list. A row means this baker has said something about this flavour — switched it off, priced it, or renamed it for their menu. No row = offered, unpriced, under its global name. Renamed from baker_flavour_exclusions in migration 037, where presence alone meant excluded.';

COMMENT ON COLUMN public.baker_flavour_settings.price_per_kg IS
  'What this baker charges per kg for this flavour. NULL = not priced; the storefront says "ask" and never guesses. Whether a customer ever SEES it is bakers.price_visibility, not this column.';

COMMENT ON COLUMN public.baker_flavour_settings.display_name IS
  'Optional per-baker name override ("Choco Truffle" for "Chocolate Truffle"). NULL = use the global name. Exists so a baker can match their own menu without the global list being cloned per baker.';

-- ── 3 ── the two visibility settings, on the baker ──────────────────────────────────
-- Deliberately two, not one three-way switch. "Here is what I make" and "here is what it
-- costs" are different disclosures, and the common case is a baker who wants the first
-- without the second: the flavour list is a menu that wins them work, the price is a
-- conversation they want to have themselves.
--
-- The defaults ARE the safety property. show_flavours = true is today's behaviour, so
-- nothing regresses for anyone. price_visibility = 'private' means no baker publishes a
-- number by accident.

ALTER TABLE public.bakers
  ADD COLUMN IF NOT EXISTS show_flavours boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS price_visibility text NOT NULL DEFAULT 'private';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'bakers_price_visibility_valid')
  THEN
    ALTER TABLE public.bakers
      ADD CONSTRAINT bakers_price_visibility_valid
      CHECK (price_visibility IN ('private', 'verified', 'public'));
  END IF;
END $$;

COMMENT ON COLUMN public.bakers.show_flavours IS
  'Does the storefront list this baker''s flavours at all? Default true — that is what the storefront already did. Exists for the bespoke-only baker, not as a question most bakers need to answer.';

COMMENT ON COLUMN public.bakers.price_visibility IS
  'Who sees per-kg prices: private (nobody — the default, and still useful because the baker''s own quote drafting reads them), verified (customers who have proved a phone/email), public (anyone). Gated by show_flavours: there is nowhere to show a price for a list you are not showing.';

-- ── 4 ── a custom flavour carries its own price ─────────────────────────────────────
-- No overlay: the baker owns this row outright. baker_flavours has existed and been read
-- by GET /api/flavours for some time without DDL in this repo — see the note in
-- supabase/flavour_dietary.sql, which guards its foreign key for exactly that reason.
-- Confirmed present and empty before this migration was written.

ALTER TABLE public.baker_flavours
  ADD COLUMN IF NOT EXISTS price_per_kg numeric(10,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'baker_flavours_price_non_negative')
  THEN
    ALTER TABLE public.baker_flavours
      ADD CONSTRAINT baker_flavours_price_non_negative
      CHECK (price_per_kg IS NULL OR price_per_kg >= 0);
  END IF;
END $$;

COMMENT ON COLUMN public.baker_flavours.price_per_kg IS
  'What this baker charges per kg for their own flavour. Direct, not overlaid — they own the row. Same NULL semantics as baker_flavour_settings.price_per_kg.';

COMMIT;
