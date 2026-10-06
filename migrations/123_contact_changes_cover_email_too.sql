-- ── 123: one table proves a contact, whichever contact it is ─────────────────────────────────────
--
-- `bakers.email` is where Spattoo writes — orders, quotes, invoices, trial reminders — and until now
-- changing it was a bare PATCH: shape-checked and saved. Sandeep: "are we sending a email OTP when
-- user changes email? i meam, are we verifying new email?" We were not.
--
-- That is the same silent failure the phone was protected from a day earlier, and it was argued
-- away at the time with "a typo is recoverable because the field is visible". Recoverable by
-- somebody who goes back and LOOKS. Nothing on any screen says the address stopped working, so the
-- real failure is a bakery that quietly stops receiving its own orders.
--
-- ── WHY THIS RENAMES RATHER THAN ADDING A SECOND TABLE ──────────────────────────────────────────
-- An email proof needs exactly what a phone proof needs: a pending value, a hashed code, an expiry,
-- an attempt ceiling and a consumed-at. Two tables would be two copies of one policy, and the ten
-- minutes and five attempts would drift apart the first time either was tuned — rule 2's "a second
-- variant of an existing thing is a NEW ROW, not a second component", applied to a table.
--
-- `kind` is that row. The columns stop naming the phone: `new_phone` becomes `new_value`, because a
-- column called phone holding an email address is a lie that reads as correct.
--
-- ⚠️ 119 IS APPLIED AND IS NOT EDITED — corrected forward, per migration 015's rule. Renames are
-- used rather than add-and-copy so the two live dev rows travel with their table instead of being
-- re-inserted by hand.

BEGIN;

ALTER TABLE public.appuser_phone_changes RENAME TO appuser_contact_changes;
ALTER TABLE public.appuser_contact_changes RENAME COLUMN new_phone TO new_value;

-- 'phone' as the default backfills the existing rows correctly: everything written before today was
-- a phone change, because nothing else could write here.
ALTER TABLE public.appuser_contact_changes
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'phone';

ALTER TABLE public.appuser_contact_changes
  DROP CONSTRAINT IF EXISTS appuser_contact_changes_kind_chk;
ALTER TABLE public.appuser_contact_changes
  ADD CONSTRAINT appuser_contact_changes_kind_chk CHECK (kind IN ('phone', 'email'));

-- The confirm step reads "the newest live attempt of THIS KIND for this user". Without `kind` in the
-- index that read is a scan, and without it in the QUERY a baker changing both at once would confirm
-- whichever they started last with either code — which is why the route filters on it.
DROP INDEX IF EXISTS appuser_phone_changes_user_idx;
CREATE INDEX IF NOT EXISTS appuser_contact_changes_user_kind_idx
  ON public.appuser_contact_changes (auth_user_id, kind, created_at DESC);

COMMENT ON COLUMN public.appuser_contact_changes.new_value IS
  'The contact being proved — E.164 when kind=phone, a lowercased address when kind=email. '
  'Written to its destination column only after a matching code arrives.';

COMMIT;
