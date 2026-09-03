-- ── 082: cake_elements records when it was last changed ──────────────────────────────────────────
--
-- "We would not know what element updated recently." The table stamped `created_at` and then only
-- two specific events — `optimized_at`, `promoted_at` — so an element edited months after it was
-- authored looked untouched, and there was no way to answer "what changed this week".
--
-- ── ⚠️ THE COLUMN ALONE WOULD BE WORSE THAN NOTHING ─────────────────────────────────────────────
--
-- 17 of the 69 tables in this schema carry `updated_at`. THREE of them have a trigger keeping it
-- current: bakers, orders, patterns. On the other fourteen the column is only as true as whoever
-- last wrote an UPDATE remembered to make it — and a timestamp that is sometimes maintained is
-- worse than an absent one, because it reads as fact either way. You cannot tell a row nobody has
-- touched since March from a row edited yesterday by a code path that forgot the column.
--
-- cake_elements is written from several places — the studios, Manage Elements, the optimizer, the
-- promotion flow, bulk imports — so "every writer remembers" was never going to hold. The trigger
-- is what makes the answer trustworthy, and it is BEFORE UPDATE so it cannot be bypassed by any of
-- them, including a hand-run SQL statement in the dashboard.
--
-- Reusing public.set_updated_at() and the <table>_updated_at naming, both already here. A second
-- function that does the same thing is how two tables end up disagreeing about what "updated" means.
--
-- ── Backfill is created_at, NOT now() ───────────────────────────────────────────────────────────
-- Stamping every existing row with now() would say the whole catalogue changed the day this ran,
-- which is false and would make the column useless for exactly the question it is being added to
-- answer. `created_at` is the honest answer: the last change we can actually evidence is that the
-- row was made. Rows genuinely edited before today will simply be understated until they are next
-- touched, which is a gap in knowledge rather than an invented fact.

ALTER TABLE public.cake_elements
  ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone;

UPDATE public.cake_elements
   SET updated_at = created_at
 WHERE updated_at IS NULL;

ALTER TABLE public.cake_elements
  ALTER COLUMN updated_at SET DEFAULT now();

-- Idempotent: re-running must not leave two triggers on the same table, both firing.
DROP TRIGGER IF EXISTS cake_elements_updated_at ON public.cake_elements;
CREATE TRIGGER cake_elements_updated_at
  BEFORE UPDATE ON public.cake_elements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Expect: every row stamped, and the most recently changed elements at the top.
SELECT name, created_at, updated_at
  FROM public.cake_elements
 ORDER BY updated_at DESC NULLS LAST
 LIMIT 10;
