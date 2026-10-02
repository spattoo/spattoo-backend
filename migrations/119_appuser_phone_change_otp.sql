-- ── 119: proof-of-possession codes for an app-user changing their own phone ───────────────────
--
-- ⚠️ THIS IS NOT AUTHENTICATION, AND THAT IS THE WHOLE REASON IT EXISTS.
--
-- Every other OTP in this system is Supabase's: storefront.js calls signInWithOtp/verifyOtp, and
-- what comes back is a SESSION (see config.js, "the OTP itself is minted and checked by Supabase").
-- That contract is exactly wrong for a phone change. The baker is ALREADY signed in; the question
-- is not "who are you" but "can the person holding this session receive SMS at this number".
-- Running it through signInWithOtp would answer the question by logging them in as whoever owns
-- that number — or, with shouldCreateUser default-true, by minting a fresh empty auth user and
-- signing them in as that. Either way they lose the session they started with.
--
-- The Supabase-native alternative, verifyOtp({ type: 'phone_change' }), is real but costs more than
-- it saves: it writes the phone onto auth.users, and phone sign-in is enabled on this project
-- (the storefront depends on it), so from that moment the SIM is a password-free door into the
-- baker account. auth.users.phone is also globally unique, and our own storefront mints
-- phone-bearing auth users — so any baker who ever verified their number on a Spattoo shop would
-- be permanently unable to change it.
--
-- So: we mint the code, we check it, and nothing here grants anything. MSG91 is the pipe it always
-- was — services/msg91.js already sends a code it did not generate.
--
-- The code is stored HASHED. A row in this table is a password for one phone number for ten
-- minutes; a leaked backup or an over-broad read should not hand anyone a working code.

BEGIN;

CREATE TABLE IF NOT EXISTS public.appuser_phone_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The auth user is the subject, not baker_appusers.id: the session is what we are binding to, and
  -- it is the one identifier the confirm step gets from the token rather than from the request body.
  auth_user_id  uuid NOT NULL,
  -- The number being PROVED. Written to baker_appusers.phone only after a matching code arrives;
  -- until then it lives here and nowhere else, so an abandoned attempt changes nothing.
  new_phone     text NOT NULL,          -- E.164, via lib/phone.js
  new_country   text,                   -- ISO-3166 alpha-2
  code_hash     text NOT NULL,          -- sha256(code), never the code
  expires_at    timestamptz NOT NULL,
  -- Attempts are counted on the ROW, not in Redis. The rate limiter is about traffic and fails open
  -- by design (middleware/rateLimit.js); a brute-force ceiling on a six-digit code must not fail
  -- open, so it lives in the same transaction as the check.
  attempts      int  NOT NULL DEFAULT 0,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- The confirm step reads "the newest live attempt for this user". Without this it is a seq scan on a
-- table that only ever grows.
CREATE INDEX IF NOT EXISTS appuser_phone_changes_user_idx
  ON public.appuser_phone_changes (auth_user_id, created_at DESC);

-- ⚠️ SERVER-ONLY: RLS ON AND NO POLICIES, so only the service role (the API) can read or write it.
-- This is the same shape as notification_channels (migration 095) and it is not optional here.
--
-- Supabase serves every table in `public` through PostgREST, and the anon key that reaches it is
-- shipped to the browser. A table like this one left open is not an information leak, it is a
-- takeover: an attacker UPDATEs a pending row's `new_phone` to their own number, the victim
-- receives a code for the number THEY typed, types it back, and confirm writes the attacker's
-- number into the column migration 015 calls the subscription boundary. Zeroing `attempts` would
-- likewise defeat the brute-force ceiling, and `code_hash` over a six-digit space is an offline
-- lookup of a million candidates — hashing protects a leaked backup, not a published table.
--
-- No policy is added on purpose. A policy grants; absence of one denies. The API holds the service
-- role, which bypasses RLS, and nothing else has any business here.
ALTER TABLE public.appuser_phone_changes ENABLE ROW LEVEL SECURITY;

COMMIT;
