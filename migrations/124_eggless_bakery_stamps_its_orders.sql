-- ── 124: an eggless-only bakery's orders say so ──────────────────────────────────────────────────
--
-- Sandeep: "some bakers make only eggless cakes… if the baker chooses eggless cakes- we should
-- default all their orders to eggless."
--
-- The setting already exists — switching `egg` off in Dietary Options writes
-- baker_dietary_exclusions, and dietary.js says that row is exactly what makes "we are a pure-veg
-- bakery" sayable at all. What did not exist is the order carrying it: OrderModal states the fact on
-- screen and records NOTHING, so an order read anywhere outside the app — a print sheet, an export,
-- an accounting row — does not say eggless anywhere.
--
-- ⚠️ A THIRD `source`, AND NOT A REUSE OF 'baker'. The column's own comment defines the two it has:
-- "who made it (customer vs baker recording what the customer said)". An order stamped from the
-- bakery's standing policy is NEITHER. Nobody typed it on the customer's behalf and the customer
-- never asserted it.
--
-- Writing 'customer' is what the order form refuses to do today, for the reason it states: it would
-- "put words in their mouth, and source='customer' is precisely the column that must not be allowed
-- to lie". Writing 'baker' would be a smaller version of the same lie — it would read, in a dispute,
-- as the baker having recorded a conversation that never happened. So the honest answer is a value
-- that means what actually occurred.
--
-- Nothing branches on `source` today; it is provenance, read by humans. That is precisely why it has
-- to be accurate — it has no job except to be true.

BEGIN;

ALTER TABLE public.order_dietary_requirements
  DROP CONSTRAINT IF EXISTS order_dietary_requirements_source_check;

ALTER TABLE public.order_dietary_requirements
  ADD CONSTRAINT order_dietary_requirements_source_check
  CHECK (source IN ('customer', 'baker', 'bakery_policy'));

COMMENT ON COLUMN public.order_dietary_requirements.source IS
  'Who asserted this requirement. ''customer'' = they said it; ''baker'' = the baker recorded what '
  'the customer told them; ''bakery_policy'' = nobody said it — the bakery does not offer the '
  'alternative, so every order carries it (e.g. a fully eggless kitchen). Provenance only: no code '
  'branches on it, which is why it must be exact.';

COMMIT;
