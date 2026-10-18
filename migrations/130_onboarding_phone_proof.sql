-- ── Proving the phone number BEFORE it becomes the subscription boundary ─────────────────────────
--
-- Sandeep: "during the baker onboarding process, we are collecting baker's phone number, but we are
-- not validating it with OTP… we should let user go to next step only after verification."
--
-- ⚠️ THE HARM IS NOT THE OWNER, IT IS THE STRANGER. A baker who mistypes their own number can
-- already fix it: /api/baker/account/phone/start texts the NEW number and is authorised by the
-- PASSWORD, so nothing is ever sent to the wrong one. What cannot be fixed is the other side of the
-- typo — `baker_appusers.phone` is unique across is_primary rows and migration 015 calls it "one
-- phone number per baker (subscription boundary)", so a mistyped number that happens to belong to a
-- REAL person silently occupies it. When that person signs up, they are told the number "is already
-- registered to another bakery", and no screen anywhere lets them release it.
--
-- So the proof has to happen before the row is written, which is POST /api/bakers/self.

-- ── 1. Which attempt actually PROVED something ──────────────────────────────────────────────────
--
-- ⚠️ `consumed_at` CANNOT ANSWER THIS, and reusing it would have been the quiet bug in this change.
-- It is stamped in two completely different situations: when a correct code is accepted (burn it
-- so a replay cannot reuse it) AND when a newer attempt supersedes an older one (so two live codes
-- never exist at once). Four call sites set it in routes/account.js, and only two of them mean
-- success. A gate reading "consumed_at is not null" as proof would accept the number a baker typed,
-- abandoned and replaced — the exact number they corrected.
ALTER TABLE public.appuser_contact_changes
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

COMMENT ON COLUMN public.appuser_contact_changes.verified_at IS
  'Set only when a correct code was accepted. consumed_at also marks superseded attempts, so it is not proof.';

-- The onboarding gate asks "has THIS user proved THIS number, recently" on every brand-setup
-- submission. Partial, because only proven rows are ever read this way.
CREATE INDEX IF NOT EXISTS appuser_contact_changes_verified_idx
  ON public.appuser_contact_changes (auth_user_id, kind, verified_at DESC)
  WHERE verified_at IS NOT NULL;

-- ── 2. Whether the number on the account has ever been proved ───────────────────────────────────
--
-- ⚠️ DEFAULT FALSE, AND THE EXISTING ROWS STAY FALSE. Every baker who signed up before this
-- migration gave a number nobody checked, and back-filling `true` would be inventing a fact about
-- several hundred real people — the one thing a verification flag must never do. False here means
-- "not proven", not "known bad"; nothing is taken away from them, and the account screen's existing
-- change flow sets it true the first time they prove one.
ALTER TABLE public.baker_appusers
  ADD COLUMN IF NOT EXISTS phone_verified boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.baker_appusers.phone_verified IS
  'A code was texted to this number and typed back. False on every row that predates migration 130 — unproven, not invalid.';
