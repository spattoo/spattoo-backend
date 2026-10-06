-- ── 125: say out loud what Supabase has been doing for us ────────────────────────────────────────
--
-- From 2026-10-30 Supabase stops automatically granting Data API access to new tables in `public`.
-- Existing tables keep their grants, so a database that is already built is fine — and that is
-- exactly what makes this dangerous for us, because PRODUCTION IS NOT BUILT YET. Migrations 119
-- and 120 are unrun there, and between them they create two tables:
--
--   appuser_contact_changes   (119, renamed by 123)   the phone/email proof codes
--   rail_skins                (120)                   the baker's menu-bar look
--
-- Run those on 2026-10-29 and both tables work. Run them on 2026-10-31 and both are invisible to
-- PostgREST — which is how our API reaches the database (SUPABASE_SERVICE_KEY, i.e. `service_role`,
-- see config.js). The migration SUCCEEDS either way. The failure arrives later, as
-- "permission denied for table", from routes nobody connects to a migration run weeks earlier.
--
-- ⚠️ A LOOP RATHER THAN A LIST, because the point is to be correct in an environment we cannot
-- inspect from here. Prod is some unknown distance behind dev; naming the two tables above would
-- fix the two we happen to know about and miss whatever else that environment has never had
-- granted. Granting what is already granted is a no-op, so this is safe to run anywhere, twice.
--
-- ⚠️ service_role ONLY. Supabase's own advice opens with `grant select ... to anon`, and pasting
-- that here would hand the public anon key read access to every table in the database — including
-- `appuser_contact_changes`, which holds verification codes, and which migration 119 was rewritten
-- to protect by enabling RLS with no policies. Our browser code reads Supabase tables directly in
-- exactly two places (cake_templates, element_categories); both already have their grants as
-- existing tables. Nothing here changes who can read what from a browser.
--
-- ⚠️ This does NOT make future tables safe — a table created tomorrow still needs its own grant in
-- its own migration. `npm run check:migration-grants` is what enforces that; this file only brings
-- every environment to the same starting line.

do $$
declare
  t record;
begin
  for t in
    select tablename
      from pg_tables
     where schemaname = 'public'
  loop
    execute format(
      'grant select, insert, update, delete on public.%I to service_role', t.tablename);
  end loop;
end
$$;
