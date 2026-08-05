-- ── 052: the morning delivery digest ───────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/plans/notifications.md
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- Every notification so far is EVENT-triggered: something happened, one person hears
-- about it. "You have 3 orders to deliver today" is not that. Nothing happened — the
-- date arrived — and the message is about a SET of orders, not one.
--
-- That makes it the first notification with two properties nothing here has needed:
-- it is produced on a schedule, and it must be produced exactly once per baker per day.

INSERT INTO notification_types (slug, label) VALUES
  ('delivery_digest_baker', 'Deliveries due today — baker morning digest')
ON CONFLICT (slug) DO NOTHING;

-- ── Idempotency for anything not triggered by an event ──────────────────────────────
-- An event-triggered notification is naturally once-only: the event happens once. A
-- SCHEDULED one is not. The job can be retried by BullMQ, re-run after a deploy that
-- lands mid-tick, or executed twice if a second worker ever joins — and each of those
-- would send a baker the same 7am digest again.
--
-- Guarding in the job (query first, insert second) is a race, and the window is exactly
-- when two runs overlap — the case worth guarding. So the guarantee lives in the DATABASE:
-- a unique key the inserter chooses, and a duplicate simply fails to insert.
--
-- NULLABLE, and unique only WHERE NOT NULL, because event-triggered notifications have
-- nothing sensible to put here. Two "quote accepted" notifications minutes apart are two
-- real events, and forcing them to invent a key would make the column a lie.
--
-- Format is the caller's business; the digest uses 'delivery_digest:<baker_id>:<date>'.
-- Anything scheduled or broadcast should adopt the same idea — the alternative is every
-- future job inventing its own guard, and getting it wrong in its own way.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_idx
  ON notifications (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

COMMENT ON COLUMN notifications.dedupe_key IS
  'Optional caller-chosen uniqueness key for notifications NOT triggered by a one-off event '
  '(scheduled digests, broadcasts). A duplicate insert fails on notifications_dedupe_key_idx '
  'instead of sending twice, which makes the producing job safely re-runnable. NULL for '
  'event-triggered notifications, where the event itself is the guarantee.';
