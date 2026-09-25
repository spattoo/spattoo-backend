-- ── 115: a baker's catalogue is CHOSEN, not filtered ────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Adds the table behind the opt-IN catalogue. `baker_template_exclusions` held "this baker hid this
-- global template"; `baker_template_settings` holds "this baker OFFERS this template", and absence
-- means the template is not in that baker's catalogue at all.
--
-- The reasoning is in spattoo-docs/plans/baker-catalogue.md. The short version: opt-out is the wrong
-- shape at scale — a boutique bakery wanting 30 of an eventual 500 templates would have to switch
-- off 470 — and a chosen catalogue is what makes one storefront differ from another, which opt-out
-- cannot deliver because every shop starts identical.
--
-- ── ⚠️ THIS MIGRATION CHANGES NOTHING THAT IS RUNNING ───────────────────────────────────────────
-- It creates an empty table and stops. It does NOT drop `baker_template_exclusions`, and nothing
-- reads the new table until the new endpoints and UI ship. Sandeep: *"lets do #1. new endpoints.
-- once they are working we wil drop the old."*
--
-- That order is not caution for its own sake. Core ships as a vendored tarball, so a baker's browser
-- can be running a bundle released before any of this — and the old client sends its EXCLUSION set
-- to a route that would now record INCLUSIONS. Same payload, opposite meaning: it would silently
-- offer exactly the templates the baker had switched off. Dual-accepting the old field name, which
-- is how `tag_ids`/`occasion_tag_ids` was made safe, cannot work here, because there the two names
-- meant the same thing and here they mean the reverse.
--
-- So: this table arrives first and sits idle. The cutover — repointing `templatesForBaker`, and then
-- dropping the old table and its route — is a separate migration, after a release.
--
-- ── ⚠️ THE POLARITY IS INVERTED FROM ITS OWN MODEL, AND THE TWO LOOK ALIKE ──────────────────────
-- Shaped deliberately like `baker_flavour_settings` (migration 037), which was itself renamed from
-- `baker_flavour_exclusions` once "hidden" turned out to be one of several per-baker facts about a
-- shared item. Copying the shape avoids rediscovering it. But they mean OPPOSITE things:
--
--   baker_flavour_settings    absence = OFFERED       (a global flavour is on until turned off)
--   baker_template_settings   absence = NOT OFFERED   (a global template is off until chosen)
--
-- Two tables, near-identical columns, reversed defaults. Anyone reading one after the other will
-- assume they match. They do not.
--
-- ── WHY `offered` IS A BOOLEAN AND NOT JUST ROW PRESENCE ────────────────────────────────────────
--   no row            never considered
--   offered = true    in this baker's catalogue
--   offered = false   deliberately taken out
--
-- The third state is worth nothing today and is exactly what `auto_add_new_templates` will need when
-- it arrives (deferred 2026-09-25, not abandoned): it must push new Spattoo work into a catalogue
-- WITHOUT undoing a removal the baker meant. Deleting the row would throw that away, and a template
-- somebody removed would come back on its own.
--
-- `sort_order` and `display_name` are room, not day-one work — the flavour table grew exactly those
-- once bakers wanted their own ordering and their own names. Declared now so adding them later is
-- not another migration.

begin;

do $$
begin
  if not exists (select 1 from information_schema.tables
                 where table_schema = 'public' and table_name = 'bakers') then
    raise exception 'public.bakers is missing — wrong database?';
  end if;
end $$;

create table if not exists public.baker_template_settings (
  baker_id     uuid        not null references public.bakers(id)         on delete cascade,
  template_id  uuid        not null references public.cake_templates(id) on delete cascade,
  -- A row is written when a baker ADDS one, so true is the sensible default for an insert that does
  -- not say. This is NOT "absence means offered" — see the polarity warning above.
  offered      boolean     not null default true,
  sort_order   integer,
  display_name text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (baker_id, template_id)
);

comment on table public.baker_template_settings is
  'A baker''s chosen catalogue. ABSENCE MEANS NOT OFFERED — the opposite of baker_flavour_settings, '
  'which it is otherwise shaped like. offered=false means deliberately removed, kept distinct from '
  'never-considered so a future auto-add cannot undo a removal. See plans/baker-catalogue.md.';

-- The one query that matters on every storefront and every baker browse: "what does this baker
-- offer?" Partial, because rows with offered=false are never in that answer.
create index if not exists idx_baker_template_settings_offered
  on public.baker_template_settings (baker_id)
  where offered;

-- ── ⚠️ NOTHING IS SEEDED. EVERY CATALOGUE STARTS EMPTY. ─────────────────────────────────────────
-- Sandeep: "stage them. in production there are no baker owned templates. so this is not a problem.
-- all should be staged." So no rows are created here — not for the global library, and not for the
-- templates bakers made themselves.
--
-- Harmless today, because nothing reads this table yet. It becomes visible at cutover, and THAT is
-- the moment every storefront goes empty until bakers curate. The select below is the number to
-- know before that day: on dev it is 12 baker-owned templates across 3 bakers (one holds 10); on
-- prod it is believed to be zero, which is stated rather than measured — this machine cannot query
-- prod. Read it, and if prod is not zero, say so before cutover rather than after.
select
  count(*) filter (where baker_id is null)                    as global_templates,
  count(*) filter (where baker_id is not null)                as baker_owned_templates,
  count(distinct baker_id) filter (where baker_id is not null) as bakers_with_own_templates
from public.cake_templates
where is_active;

commit;

-- ── What landed ─────────────────────────────────────────────────────────────────────────────────
-- Expect: the new table exists and is EMPTY, and the old one is still standing and still in use.
select
  to_regclass('public.baker_template_settings')   is not null as settings_table_exists,
  to_regclass('public.baker_template_exclusions') is not null as old_table_still_here,
  (select count(*) from public.baker_template_settings)        as catalogue_rows,
  (select count(*) from public.baker_template_exclusions)      as exclusion_rows,
  (select count(*) from public.cake_templates where is_active) as active_templates;
