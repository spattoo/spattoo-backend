-- ── 025: element build guides — a second guide type on the craft-guide rail ─────────
-- Implements the storage half of docs (spattoo-core) FONDANT_BUILD_GUIDE_PLAN.md §4.
--
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHAT THIS IS FOR ────────────────────────────────────────────────────────────────
-- X-Ray answers "how do I make this cake" by looking up per-element guidance. Today that means
-- nozzle recommendations for admin-authored PIPING elements. It says nothing about a baker's OWN
-- decoration — and a baker's own decoration is always a 2D image they uploaded and promoted
-- (routes/uploads.js POST /uploads/:id/promote; 3D is admin-only, config.js maxModelMb), so it can
-- never have a nozzle. The sheet lists it on the checklist by name and offers no help making it.
--
-- A build guide fills that: materials, parts, ordered steps, tools, tips. Same rail, second type.
--
-- ── WHY guide_type BECOMES PART OF THE KEY ──────────────────────────────────────────
-- element_id alone was the primary key, which permanently forbids an element having more than one
-- kind of guidance. That is fine while "guidance" means nozzles, and wrong the moment it also means
-- build steps — and the plan already anticipates more types (chocolate work, isomalt). Widening the
-- key now costs one migration; widening it after rows exist for two types costs a data migration.
--
-- The default backfills every existing row to 'piping_nozzle', which is exactly what they are.
alter table element_craft_guide add column if not exists guide_type       text not null default 'piping_nozzle';
alter table element_craft_guide add column if not exists guide            jsonb;
alter table element_craft_guide add column if not exists source_image_url text;
alter table element_craft_guide add column if not exists model            text;
alter table element_craft_guide add column if not exists prompt_version   text;
-- 'draft' | 'approved'. A guide a BAKER generated for their own private decoration is never
-- reviewed by us — admin review cannot scale to thousands of bakers' own elements — so it stays
-- draft forever and the sheet says so. An admin-authored guide for a library element can be
-- approved. The report must render the two differently: a curated Wilton recommendation and an
-- unreviewed model guess should not look identical at 6am.
alter table element_craft_guide add column if not exists status           text not null default 'approved';
alter table element_craft_guide add column if not exists generated_at     timestamptz;
alter table element_craft_guide add column if not exists baker_id         uuid references bakers (id) on delete cascade;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'element_craft_guide_type_chk'
  ) then
    alter table element_craft_guide add constraint element_craft_guide_type_chk
      check (guide_type in ('piping_nozzle', 'fondant_figure'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'element_craft_guide_status_chk'
  ) then
    alter table element_craft_guide add constraint element_craft_guide_status_chk
      check (status in ('draft', 'approved'));
  end if;
end $$;

-- Widen the primary key to (element_id, guide_type). Idempotent: only runs while the PK is still
-- the single column.
do $$
declare n int;
begin
  select count(*) into n
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
   where c.conrelid = 'element_craft_guide'::regclass and c.contype = 'p';
  if n = 1 then
    alter table element_craft_guide drop constraint element_craft_guide_pkey;
    alter table element_craft_guide add primary key (element_id, guide_type);
  end if;
end $$;

-- The hot read is X-Ray asking for a batch of element ids (routes/craftGuide.js), which the PK
-- already serves. This one serves the other question: "which guides did this baker generate?" —
-- for a future library view and for support. Partial, so it stays small: baker_id is null on
-- every admin-authored row, which is nearly all of them.
create index if not exists element_craft_guide_baker_idx
  on element_craft_guide (baker_id) where baker_id is not null;

comment on column element_craft_guide.guide_type is
  'piping_nozzle (nozzle_recs/consistency/technique) | fondant_figure (guide jsonb). X-Ray keys off a guide EXISTING, never off the element''s medium or slug — see FONDANT_BUILD_GUIDE_PLAN §3.';
comment on column element_craft_guide.guide is
  'Structured build guide: { title, roles, materials, parts, steps[{n,title,instructions,tools}], tips, set_time }. Steps reference role tokens ({body}) not literal colours, so one guide serves every colour variant.';
comment on column element_craft_guide.status is
  'draft = model-generated, never reviewed by us (every baker-generated guide). approved = a human signed it off. The report must visibly distinguish them.';
comment on column element_craft_guide.baker_id is
  'Who paid for this guide, when a baker generated one for their own element. NULL for admin-authored library guides.';
