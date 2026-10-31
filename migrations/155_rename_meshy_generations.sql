-- ── 155: the table stops being named after one vendor ───────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Sandeep: *"but why the name meshy_generations? if meshy means meshy.ai we might use other things
-- in future."* We already do — `provider` has held 'tripo' since 148, and most rows are Tripo.
--
-- ⚠️ THE COLUMN IS WORSE THAN THE TABLE, because it is actively false rather than merely dated.
-- Measured on dev before this ran: of six rows, FOUR had `provider = 'tripo'` and their Tripo task
-- id sitting in a column called `meshy_task_id`. Anyone reading that column name believes something
-- untrue about the data in front of them, and the next vendor makes it worse.
--
--     meshy_generations  →  ai3d_generations
--     meshy_task_id      →  vendor_task_id
--
-- ⚠️ A COMPATIBILITY VIEW, BECAUSE THE DEPLOY IS NOT ATOMIC. Migrations are applied by hand and the
-- code deploys separately, so one of the two orders always breaks something: rename first and the
-- running API queries a table that is gone; deploy first and the new code queries one that does not
-- exist yet. The view makes the order irrelevant — old code keeps working against the old names
-- until it is replaced. It is auto-updatable (one table, no joins or aggregates, plain column
-- aliases), so inserts and updates through it work exactly as before.
--
-- ⚠️ AND IT IS TEMPORARY. Drop it once every deployed consumer is on the new names — a view that
-- outlives its migration becomes a second name people start writing new code against, which is the
-- thing this migration exists to end. `routes/webhooks.js`, `routes/meshy.js` and `routes/ai3d.js`
-- are the three consumers.

-- ⚠️ GUARDED ON relkind, NOT `if exists`, AND THAT IS NOT PEDANTRY. After the first run
-- `meshy_generations` still EXISTS — as the view created below — and `alter table ... if exists`
-- will happily rename a view. A second run would therefore rename the shim to `ai3d_generations`,
-- collide with the real table and fail having already done damage. The "safe to re-run" claim at
-- the top of this file is only true because of these guards.
do $$
begin
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'meshy_generations' and c.relkind = 'r') then
    execute 'alter table public.meshy_generations rename to ai3d_generations';
  end if;
end $$;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'ai3d_generations'
                and column_name = 'meshy_task_id') then
    execute 'alter table public.ai3d_generations rename column meshy_task_id to vendor_task_id';
  end if;
end $$;

comment on table ai3d_generations is
  'One row per 3D generation, whichever vendor made it — provider says which. Renamed from '
  'meshy_generations in 155; the vendor had been in the name since before there was a second one.';
comment on column ai3d_generations.vendor_task_id is
  'The task id at whichever vendor `provider` names. Was `meshy_task_id`, which held Tripo ids.';

-- Columns listed rather than `select *` so the alias can map the old name onto the new one, and so
-- a column added later does NOT silently appear on a view that is meant to be frozen and removed.
create or replace view meshy_generations as
  select id, created_by, source_image_key,
         vendor_task_id as meshy_task_id,
         status, progress, glb_key, thumbnail_url, consumed_credits, error,
         created_at, updated_at, provider, mode, prompt, wants_parts,
         model_seed, texture_seed, promoted_element_id
    from ai3d_generations;

comment on view meshy_generations is
  'TEMPORARY compatibility shim for migration 155. Drop once every deployed consumer reads '
  'ai3d_generations. Do not write new code against it.';

grant all on ai3d_generations  to service_role;
grant all on meshy_generations to service_role;
revoke all on ai3d_generations  from anon, authenticated;
revoke all on meshy_generations from anon, authenticated;
