-- ── 015: one phone number per baker (subscription boundary) ───────────────────
-- ⚠️ SUPERSEDED BY 016. This version put phone_e164/phone_country + a unique index on
-- the BAKERS table. That was the wrong home: onboarding collects the OWNER's phone
-- (stored on baker_appusers), while bakers.phone is a separate BUSINESS phone set later
-- via the profile screen. 016 reverts everything below and moves the guarantee onto
-- baker_appusers (owner-scoped). Kept here unchanged because it was already applied —
-- do NOT edit an applied migration; correct forward in 016.

ALTER TABLE bakers ADD COLUMN IF NOT EXISTS phone_e164    text;
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS phone_country text;  -- ISO-3166 alpha-2

-- Best-effort backfill from the owner appuser, only for already-E.164 values.
UPDATE bakers b
SET phone_e164 = au.phone
FROM baker_appusers au
WHERE au.baker_id = b.id
  AND au.is_primary
  AND au.phone ~ '^\+[1-9][0-9]{6,14}$'
  AND b.phone_e164 IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bakers_phone_e164_uidx
  ON bakers (phone_e164)
  WHERE phone_e164 IS NOT NULL;
