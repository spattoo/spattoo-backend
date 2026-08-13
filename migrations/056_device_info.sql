-- ── 056: what kind of device is this ───────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/plans/notifications.md
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- "Notifications don't work" is unanswerable without knowing what it is not working
-- ON. Three fields, chosen because each answers a question that is currently guesswork:
--
--   device_model  Xiaomi, Oppo, Vivo and Realme kill background delivery, and whitelist
--                 WhatsApp where they will not whitelist us. That is currently a claim
--                 from the internet. Recorded, it becomes something to check: does
--                 non-delivery actually correlate with those brands, or not.
--   os_version    Android and iOS both changed background rules between versions.
--   app_version   Once the Capacitor apps ship, "notifications are broken" from someone
--                 three builds behind is a different conversation entirely.
--
-- COLUMNS, not a jsonb blob, because the whole point is GROUPING by them — "how many
-- Xiaomi devices have we failed to reach" is the question, and a blob makes it a scan.
--
-- ── THE PURPOSE, STATED NARROWLY ────────────────────────────────────────────────────
-- To REPRODUCE A BAKER'S ISSUE ON THE SAME TYPE OF DEVICE. That is the whole of it, and
-- writing it here rather than only in a policy is deliberate: purpose limitation is a
-- DPDP obligation, and a purpose that lives only in a document nobody opens is one that
-- drifts.
--
-- Covered by the existing Privacy Policy §2.3 ("browser/device type", "error/diagnostic
-- logs") and §110 ("address ... technical issues"), so this needed no new consent —
-- which matters, because `privacy` is a CONSENT_REQUIRED_DOC_KEY and republishing it
-- puts a re-consent gate in front of every baker.
--
-- ⚠️ THE DAY THIS FEEDS ANYTHING ELSE, THE POLICY CHANGES FIRST. Segmentation, a
-- marketing decision, a "which handsets do our bakers use" deck — all outside the stated
-- purpose. §2.3 says "for diagnostics only. If this changes, we will update this Policy",
-- and that sentence is the one being relied on here.
--
-- ── AND DELIBERATELY NOTHING MORE ───────────────────────────────────────────────────
-- Not the user-agent string, not screen size, not timezone, not language. Those four
-- together are a fingerprint, and a fingerprint is a tracking capability we would then
-- have to justify holding. Three fields answer real questions; the fourth starts
-- answering questions nobody asked.
--
-- ⚠️ These are PERSONAL DATA — they describe an identified person's device. They are
-- therefore erasable, and 056 ships alongside the fix that makes `device_tokens` rows
-- actually go on erasure (see jobs/processors/eraseExpiredAccounts.js). Before that fix
-- the rows survived, because erasure MARKS `bakers.deletion_status = ERASED` rather than
-- deleting the row, so the `on delete cascade` on baker_id never fired.

ALTER TABLE device_tokens
  -- e.g. 'Redmi Note 12', 'iPhone 14'. Nullable and expected to STAY null on web: a
  -- browser cannot reliably report a model (navigator.userAgent is coarse and Chrome
  -- freezes the version). Capacitor's Device plugin reports it properly, so this column
  -- mostly fills once the native apps ship — which is fine, and cheaper than adding it
  -- then.
  ADD COLUMN IF NOT EXISTS device_model text,
  -- e.g. 'Android 14', 'iOS 17.4', or a coarse browser/OS string on web.
  ADD COLUMN IF NOT EXISTS os_version   text,
  -- The Spattoo build this device is running. On web, the release SHA; in the apps, the
  -- app version. Answers "is this fixed for them yet".
  ADD COLUMN IF NOT EXISTS app_version  text;

COMMENT ON COLUMN device_tokens.device_model IS
  'Handset model, for diagnosing non-delivery (Indian OEMs kill background delivery aggressively). '
  'Null on web, where a browser cannot report one. Personal data — erased with the account.';

-- Answering "which manufacturers are we failing to reach" is a grouped count over a small
-- table, so no index: at bakery scale this is a seq scan on a few thousand rows, and an
-- index on a low-cardinality text column would cost writes to save nothing measurable.
