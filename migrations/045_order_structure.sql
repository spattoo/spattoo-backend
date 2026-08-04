-- ── 045: the SHAPE of the cake, on the order ────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Plan: spattoo-docs/plans/order-signals.md — "Weight is not only about people"
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- An order records weight_kg and nothing about the cake's FORM. Tier structure lives
-- only inside design_snapshot — a jsonb blob, and absent entirely on an enquiry that
-- has no design. So today:
--
--   * a customer who wants two tiers has nowhere to say so
--   * "how many of our orders are tiered?" cannot be asked at all
--   * the storefront cannot warn that 2 tiers will not work at 1kg, because it does
--     not know the answer is 2 tiers
--
-- The last one is the reason this is not just analytics. Weight is NOT purely a
-- function of how many people are eating: a two-tier cake has a structural minimum
-- regardless of the guest count, and a customer choosing "about 8 people, 1kg" and
-- separately wanting two tiers has chosen something nobody can bake.
--
-- ── WHY BOTH COLUMNS, AND WHY shape MAY BE NULL MORE OFTEN ──────────────────────────
-- tier_count is ASKED — the size facet's second step, and it is what makes the weight
-- floor possible.
--
-- shape is DERIVED, never asked: a template carries one, and so does a design snapshot,
-- so when either exists we know it for free. A flavour-only enquiry has no shape and
-- the column stays null. Storing it when we know it costs nothing; asking a customer to
-- choose between "round" and "square" before they have a price is another question in a
-- flow that just had three removed.
--
-- Not a foreign key to cake_shapes: a design snapshot's shape is a string inside jsonb
-- and a template's is a plain text column, so a FK here would be stricter than either
-- source it copies from — and would fail an insert over a shape somebody renamed.

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS tier_count integer,
  ADD COLUMN IF NOT EXISTS shape      text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_tier_count_sane') THEN
    -- A ceiling as well as a floor. Six tiers is already a wedding centrepiece; a typo'd
    -- 20 is not an order, and an unbounded integer here would be a weight floor nobody
    -- could ever satisfy.
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_tier_count_sane CHECK (tier_count IS NULL OR tier_count BETWEEN 1 AND 6);
  END IF;
END $$;

COMMENT ON COLUMN public.orders.tier_count IS
  'How many tiers the customer asked for. ASKED on the storefront (the size facet''s second step) or derived from a picked template. Drives the weight floor — a two-tier cake has a structural minimum whatever the guest count. NULL = never established.';
COMMENT ON COLUMN public.orders.shape IS
  'Round, square, heart… DERIVED, never asked: copied from the template or design snapshot when one exists, NULL otherwise. Deliberately not a FK to cake_shapes — a snapshot''s shape is a string inside jsonb, so a FK would be stricter than the source it copies.';

-- "How many of this baker's orders are tiered?" is the question this exists for.
CREATE INDEX IF NOT EXISTS orders_baker_tier_count_idx
  ON public.orders (baker_id, tier_count) WHERE tier_count IS NOT NULL;

COMMIT;
