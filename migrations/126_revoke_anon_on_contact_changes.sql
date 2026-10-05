-- ── 126: the proof-code table stops being reachable with the public anon key ──────────────────────
--
-- `appuser_contact_changes` holds the hashed codes that prove a baker owns a phone number or an
-- email address before we change theirs. It is server-only: nothing in any browser bundle reads or
-- writes it, and nothing ever should — the whole point of migration 119 was that an OTP issued by
-- Supabase authenticates, while this table PROVES POSSESSION for somebody already signed in.
--
-- Measured on dev before writing this:
--
--   anon         →  SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE
--   service_role →  the same
--
-- Nobody granted that. It is Supabase's automatic grant on every table in `public`, the very thing
-- being withdrawn for NEW tables on 2026-10-30 (see 125) and left in place for existing ones.
--
-- ⚠️ SO THE TABLE'S ONLY DEFENCE TODAY IS RLS. 119 enables row-level security with no policies,
-- which denies everything to anon and authenticated, and that is genuinely sufficient — right up
-- until somebody disables RLS to debug something, or a future migration recreates the table and
-- forgets it. The grant is a loaded gun with the safety on; this unloads it. Defence in depth, for
-- a table where the failure is an attacker setting `new_value` to their own phone number and
-- taking over the account the codes protect.
--
-- ⚠️ service_role IS UNTOUCHED, and that is the whole reason this is safe. Our API reaches the
-- database as service_role (SUPABASE_SERVICE_KEY, config.js); every read and write to this table
-- goes through routes/account.js, which keeps working exactly as before. `revoke` here names anon
-- and authenticated only.
--
-- Not a sweep. This is the one table whose contents are a credential; a blanket revoke across
-- `public` would also hit `cake_templates` and `element_categories`, which browser code DOES read
-- directly (admin's CreateTemplate, CakeDesigner). Widening this needs the same per-table argument,
-- made per table.

do $$
begin
  -- Guarded so a fresh environment replaying 119 → 126 in order cannot trip on the rename in 123,
  -- and so a re-run is a no-op rather than an error.
  if to_regclass('public.appuser_contact_changes') is not null then
    execute 'revoke all on public.appuser_contact_changes from anon';
    execute 'revoke all on public.appuser_contact_changes from authenticated';
  end if;
end
$$;
