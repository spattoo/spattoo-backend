-- ── 017: track the one-time staff welcome email ───────────────────────────────
-- A staff member is invited (Supabase sends the activation email) → they confirm +
-- set a password → on their FIRST authenticated request we send a welcome email via
-- our own mailer (services/email.js). This column makes that send exactly-once and
-- race-safe: the profile route claims it with a conditional UPDATE ... WHERE
-- welcome_sent_at IS NULL before sending. NULL = not yet welcomed.
ALTER TABLE baker_appusers ADD COLUMN IF NOT EXISTS welcome_sent_at timestamptz;
