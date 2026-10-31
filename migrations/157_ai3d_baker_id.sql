-- ── 157: a generation belongs to a bakery, not only to the person who pressed the button ─────────
--
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- `created_by` is the person (an auth user) and stays that way — Sandeep: *"created_by is the
-- person - yes. agreed."* What it cannot answer on its own is WHOSE it is.
--
-- ⚠️ DERIVING THE BAKERY FROM THE PERSON WORKS UNTIL THE PERSON IS GONE. `baker_appusers` is the
-- map, and it is a hard DELETE, not a flag (services/bakerProvisioning.js:224 deletes rows by
-- baker_id). So a staff member who leaves takes the only link to their generations with them: rows
-- a bakery PAID for become unattributable, and the baker's own "models you have not used" list
-- silently loses them. Sandeep: *"oh, then how do we show a baker's generations for him to convert
-- to elements? safe to have the baker_id as well."*
--
-- ⚠️ NULLABLE, AND THAT IS NOT LAZINESS. An admin is a row in `admins`, never in `baker_appusers`,
-- so a catalogue generation genuinely has no bakery. Null means staff — which is also the honest
-- way to tell the two populations apart for retention: a baker's model was paid for, ours was an
-- experiment.
--
-- ⚠️ NO `on delete cascade`. Erasing a bakery must delete the R2 objects as well as the rows, and a
-- cascade would remove the rows first and strand the files with nothing left pointing at them.
-- Deletion is a job that walks the rows deliberately (jobs/processors/eraseExpiredAccounts.js,
-- which does not reach generations at all yet).
BEGIN;

alter table ai3d_generations add column if not exists baker_id uuid references bakers (id);

comment on column ai3d_generations.baker_id is
  'The bakery whose credits paid for this generation. NULL = an internal/staff run. `created_by` is '
  'the person who pressed the button; this is who owns the result.';

-- Backfill from the map while it still holds. Only fills NULLs, so a re-run cannot overwrite a row
-- whose person has since left and whose baker_id is already recorded — which is the entire point of
-- storing it.
update ai3d_generations g
   set baker_id = a.baker_id
  from baker_appusers a
 where a.auth_user_id = g.created_by
   and g.baker_id is null;

-- The list the baker actually opens: their bakery's generations, newest first. Partial, because
-- staff rows are NULL here and are never asked for by bakery.
create index if not exists ai3d_generations_baker_recent
  on ai3d_generations (baker_id, created_at desc)
  where baker_id is not null;

COMMIT;
