-- ── bakers.first_paid_at — "has this baker EVER paid?" as a one-way fact ──────
-- Run once in the Supabase SQL editor. Idempotent.
--
-- WHY THIS COLUMN EXISTS
--   The lapsed-access gate must tell three situations apart, because showing the wrong
--   one tells the baker a false story about their own account:
--     1. never paid, trial ran out        → "Your trial has ended"
--     2. paid, then cancelled on purpose  → "Your subscription has ended"
--     3. paid, then a renewal FAILED      → "We couldn't renew your subscription"
--   Until now the gate showed (1) for all three — so a paying customer whose card
--   failed was told their *trial* was over and pushed toward the free plan.
--
-- WHY A COLUMN ON `bakers` AND NOT A QUERY ON `payments`
--   Business rule (product decision): a baker who has entered a paid subscription NEVER
--   returns to trial. That makes "has ever paid" a ONE-WAY, permanent fact — exactly the
--   kind of thing to store, not to re-derive.
--   Scale: `payments` is HIGH-VOLUME (one row per charge, per baker, forever) while
--   `bakers` is BOUNDED (one row per tenant). The gate is on the profile load — a hot
--   path — so this must be an O(1) column read, never an existence probe against a table
--   that grows without limit. Reading a column on the row we already fetched costs nothing.
--
--   timestamptz rather than boolean: same storage cost in practice, strictly more
--   information (when they became a paying customer — useful for cohorts//lifecycle later),
--   and still a plain NULL check at the call site.
--
-- SEMANTICS
--   Set ONCE, on the first CAPTURED payment (fill-when-null in the billing webhook), and
--   never cleared — not on cancel, not on lapse, not on downgrade to trial. NULL means
--   "never paid".
--
-- No index: this is only ever read for a single already-identified baker (by primary key),
-- never filtered or sorted across bakers.

ALTER TABLE bakers
  ADD COLUMN IF NOT EXISTS first_paid_at timestamptz;

COMMENT ON COLUMN bakers.first_paid_at IS
  'Instant of this baker''s FIRST captured payment. Set once by the billing webhook '
  '(fill-when-null), never cleared — a baker who has paid never returns to trial. '
  'NULL = has never paid. Drives the lapsed-access gate copy (trial ended vs '
  'subscription ended vs renewal failed).';

-- ── Backfill existing paying bakers ───────────────────────────────────────────
-- Without this, a baker who already paid before this column existed would read as
-- "never paid" and be shown the trial message — the exact bug being fixed.
-- status_id 1 = captured (see src/constants/paymentStatuses.js).
UPDATE bakers b
   SET first_paid_at = p.first_charge
  FROM (
    SELECT baker_id, MIN(charged_at) AS first_charge
      FROM payments
     WHERE status_id = 1
     GROUP BY baker_id
  ) p
 WHERE p.baker_id = b.id
   AND b.first_paid_at IS NULL;
