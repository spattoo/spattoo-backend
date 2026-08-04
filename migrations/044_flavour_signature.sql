-- ── 044: what this kitchen is known for ─────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Plan: spattoo-docs/plans/order-signals.md — "is_signature is scored and can never fire"
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- The storefront's flavour suggester already scores `isSignature` and gates a whole
-- fallback branch on it ("What this kitchen is known for."). There has never been a
-- column, and lib/flavourList.js has never emitted the field — so the weight has never
-- applied in production and that branch has never run. The tests passed only because
-- they construct the field by hand: a fixture asserting a contract nothing implemented.
--
-- This is the half that was missing. A baker marking two or three flavours as theirs is
-- the ONE piece of per-baker taste knowledge worth collecting, because it is the one
-- thing they know and we never can: the rules are global by design, and personalisation
-- otherwise comes only from WHICH flavours they stock.
--
-- ── WHY A CAP, ENFORCED IN THE ROUTE ────────────────────────────────────────────────
-- "What this kitchen is known for" means nothing if it is everything. A baker who ticks
-- all twenty-six has told us the same as a baker who ticked none, except that now the
-- suggester quietly prefers their whole catalogue over the rules. So the API refuses
-- more than three.
--
-- Not a CHECK constraint: the rule is about a SET of rows, which needs a trigger or a
-- statement-level constraint, and both are harder to read and to change than a guard in
-- the one route that writes here. If a second writer ever appears, revisit — that is the
-- honest trade being made.
--
-- ── WHY IT SITS ON BOTH TABLES ──────────────────────────────────────────────────────
-- A global flavour is shared, so the baker's opinion of it is an overlay row. A baker's
-- own recipe has no global row to overlay, so the flag sits on it directly — the same
-- shape price_per_kg already takes, for the same reason.

BEGIN;

-- The baker's opinion of a GLOBAL flavour. Sparse: a row exists only where they have
-- said something.
ALTER TABLE public.baker_flavour_settings
  ADD COLUMN IF NOT EXISTS is_signature boolean NOT NULL DEFAULT false;

-- Their OWN recipe. They made it; the flag lives on the row itself.
ALTER TABLE public.baker_flavours
  ADD COLUMN IF NOT EXISTS is_signature boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.baker_flavour_settings.is_signature IS
  'Has this baker marked this global flavour as one of theirs? Feeds the storefront suggester as a TIEBREAK (it cannot overturn a rule) and the "what this kitchen is known for" fallback. Capped at 3 per baker in PUT /api/baker/flavours — the claim means nothing if it is everything. Default false.';
COMMENT ON COLUMN public.baker_flavours.is_signature IS
  'Has this baker marked their own recipe as a signature? Same meaning and same cap as baker_flavour_settings.is_signature — counted together, since a baker has one set of signatures, not one per table.';

-- Every read is "this baker's signatures", and the set is tiny.
CREATE INDEX IF NOT EXISTS baker_flavour_settings_signature_idx
  ON public.baker_flavour_settings (baker_id) WHERE is_signature;
CREATE INDEX IF NOT EXISTS baker_flavours_signature_idx
  ON public.baker_flavours (baker_id) WHERE is_signature;

COMMIT;
