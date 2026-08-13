-- ── 016: correct 015 — move the owner-phone guarantee from bakers → baker_appusers ──
-- 015 added phone_e164/phone_country + a unique index on the BAKERS table. Wrong home:
-- onboarding collects the primary OWNER's phone (stored on baker_appusers), and
-- bakers.phone is a separate BUSINESS phone (profile screen, later). This migration:
--   1. reverts the 015 bakers-table change, and
--   2. puts the guarantee where the data lives — the owner's baker_appusers row, scoped
--      to is_primary (staff rows, is_primary=false, are intentionally excluded, so a
--      former staffer can start their own baker with the same phone).
-- Idempotent and safe to run whether or not 015 was applied.

-- 1. Revert 015 (drop the index first, then the columns).
DROP INDEX IF EXISTS bakers_phone_e164_uidx;
ALTER TABLE bakers DROP COLUMN IF EXISTS phone_e164;
ALTER TABLE bakers DROP COLUMN IF EXISTS phone_country;

-- 2. Owner-scoped guarantee on baker_appusers.
ALTER TABLE baker_appusers ADD COLUMN IF NOT EXISTS phone_country text;  -- ISO-3166 alpha-2

-- ⚠️ The index below FAILS if two PRIMARY rows already share a phone. Check first:
--   SELECT phone, count(*) FROM baker_appusers
--   WHERE is_primary AND phone IS NOT NULL GROUP BY phone HAVING count(*) > 1;
-- Resolve any dupes (or NULL the extras), then create the index.
CREATE UNIQUE INDEX IF NOT EXISTS baker_owner_phone_uidx
  ON baker_appusers (phone)
  WHERE is_primary AND phone IS NOT NULL;
