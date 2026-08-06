-- ── 057: the notification centre ───────────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/plans/notifications.md
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- A bell in the header with an unread count, and a list a baker can read back.
--
-- Almost nothing new is stored: `notifications` has recorded every event since the
-- beginning, with its type, payload and timestamp. The bell is a READ of data already
-- being written. Three columns are what it lacks.

-- ── 1. Was it READ ──────────────────────────────────────────────────────────────────
-- Separate from `status`, which is about DELIVERY (pending → sent → failed). The two
-- diverge the first time an email is accepted by the provider and nobody opens it, and
-- collapsing them would make "sent" mean two things that disagree.
--
-- PER BAKERY, not per person: one row, one read_at. A bakery is a shop floor — if one
-- person deals with an enquiry it is dealt with, and a second unread badge on a
-- colleague's screen is noise about work already done. Per-person would need a join
-- table and would be the more "correct" model of a fact nobody has asked for.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS read_at timestamptz;

-- ── 2. WHOSE bell it belongs on ─────────────────────────────────────────────────────
-- `recipient_email` addresses a person and stays the delivery address. It is a poor
-- OWNER: bakerNotifyEmail() prefers `bakers.email` (the bakery's contact address), which
-- frequently exists nowhere in baker_appusers — the exact resolution that silently sent
-- zero pushes until services/fcm.js learned to union the two lookups.
--
-- Doing that union again for the bell would be two places deriving the same fact from a
-- string. The owner is a column now, and the push path can move onto it next.
ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS baker_id uuid REFERENCES bakers (id) ON DELETE CASCADE;

-- Best-effort backfill for rows written before the column existed: match the recipient
-- to a bakery, either as its contact address or as one of its app users. Rows that match
-- neither stay null and simply never appear in a bell — correct, since we cannot say
-- whose they were.
UPDATE notifications n SET baker_id = b.id
  FROM bakers b WHERE n.baker_id IS NULL AND n.recipient_email = b.email;

UPDATE notifications n SET baker_id = a.baker_id
  FROM baker_appusers a WHERE n.baker_id IS NULL AND n.recipient_email = a.email;

-- THE bell query: this bakery's notifications, newest first, and the unread count.
CREATE INDEX IF NOT EXISTS notifications_baker_idx
  ON notifications (baker_id, created_at DESC)
  WHERE baker_id IS NOT NULL;

-- ── 3. WHO a type is for ────────────────────────────────────────────────────────────
-- `order_placed_customer` must never appear in a baker's bell. Today that is implied by
-- the slug suffix — a NAMING CONVENTION, which holds only while everyone keeps following
-- it and fails silently the first time somebody does not.
ALTER TABLE notification_types
  ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'baker'
    CHECK (audience IN ('baker', 'customer'));

-- Derived from the convention while it is still reliably true — every existing slug ends
-- in _baker or _customer. Doing this once, now, is what lets the convention stop being
-- load-bearing.
UPDATE notification_types SET audience = 'customer' WHERE slug LIKE '%\_customer' ESCAPE '\';
UPDATE notification_types SET audience = 'baker'    WHERE slug LIKE '%\_baker'    ESCAPE '\';
-- Named individually because they follow neither suffix.
UPDATE notification_types SET audience = 'customer' WHERE slug = 'customer_invite';

-- ── 4. The purge must not eat unread ────────────────────────────────────────────────
-- purge_old_notifications() deleted every `sent` row past the window. Harmless while
-- notifications were write-only; the moment there is a bell, an unread item vanishing
-- from it is a bug — and a silent one, because nobody misses what they never saw.
--
-- Read rows keep the 90-day window. Unread get a year: long enough that nothing is lost
-- to a holiday, bounded so the table cannot grow without limit on the strength of
-- somebody never clicking.
CREATE OR REPLACE FUNCTION purge_old_notifications(retain_days int DEFAULT 90)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE deleted int;
BEGIN
  DELETE FROM notifications
   WHERE status = 'sent'
     AND COALESCE(sent_at, created_at) < now() - make_interval(days => retain_days)
     AND (
       read_at IS NOT NULL
       OR COALESCE(sent_at, created_at) < now() - interval '365 days'
     );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END $$;

COMMENT ON COLUMN notifications.read_at IS
  'When the BAKERY marked this read (per bakery, not per person — a shop floor deals with an '
  'enquiry once). Distinct from `status`, which tracks delivery.';
COMMENT ON COLUMN notifications.baker_id IS
  'Whose bell this belongs on. recipient_email is the delivery ADDRESS and a poor owner: it is '
  'often bakers.email, which exists nowhere in baker_appusers.';
