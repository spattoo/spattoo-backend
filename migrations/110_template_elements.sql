-- ── 110: which decorations a template actually uses ─────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHY A TABLE FOR SOMETHING THE DESIGN ALREADY KNOWS ──────────────────────────────────────────
-- A template's design embeds element ids — `stickers[].elementId`, a piping layer's id — inside a
-- jsonb column. Every id is there, and NOTHING can join on it. Two questions go unanswered today:
--
--   "find me templates with a rainbow in them"   — the search gap this plan exists for
--   "which templates use THIS element?"          — asked before editing or retiring one
--
-- The second is the sharper one. Elements are never deleted (there is no DELETE route, only
-- PATCH /admin/elements/:id flipping is_active) and NOTHING guards that. A template using a retired
-- element still renders, because the design carries its own copy of what it needs to draw — but as
-- the export route warns, the designer "is deliberately tolerant of an absent catalogue row, so
-- move/resize caps quietly revert to defaults and clustering stops working. It would look right and
-- behave differently, silently."
--
-- ── DERIVED, NOT AUTHORED ───────────────────────────────────────────────────────────────────────
-- Nothing here is a fact a person states. Every row is recomputed from the design by
-- elementIdsReferencedBy — a walk of every uuid in the jsonb, intersected with cake_elements — so
-- this table can be rebuilt from scratch at any time by scripts/backfill-template-elements.mjs.
-- That is the whole reason it could wait behind the tagging work: a tag records INTENT and cannot be
-- backfilled, this records FACT and can.
--
-- ⚠️ SHAPED LIKE template_tags, deliberately: composite PK, an index in BOTH directions, and
-- ON DELETE CASCADE on both sides. The reverse index is not decoration — "which templates use this
-- element" reads element-first, and that is half the point of the table.
--
-- ⚠️ CASCADE ON template_id MATTERS. Templates genuinely are deleted — DELETE /admin/templates/:id
-- is a hard delete — so without it this accumulates rows pointing at nothing. The element side
-- cascades too, for symmetry with template_tags; it should never fire, because elements are retired
-- rather than deleted.

create table if not exists public.template_elements (
  template_id uuid not null,
  element_id  uuid not null,
  created_at  timestamp with time zone default now() not null,
  constraint template_elements_pkey primary key (template_id, element_id)
);

-- Both directions. template-first answers "what is in this cake"; element-first answers "what would
-- I break by changing this decoration", which nothing can ask today.
create index if not exists idx_template_elements_tmpl on public.template_elements using btree (template_id);
create index if not exists idx_template_elements_el   on public.template_elements using btree (element_id);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'template_elements_template_id_fkey') then
    alter table public.template_elements
      add constraint template_elements_template_id_fkey
      foreign key (template_id) references public.cake_templates(id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'template_elements_element_id_fkey') then
    alter table public.template_elements
      add constraint template_elements_element_id_fkey
      foreign key (element_id) references public.cake_elements(id) on delete cascade;
  end if;
end $$;

-- ── What landed ─────────────────────────────────────────────────────────────────────────────────
-- Empty until scripts/backfill-template-elements.mjs has run; new saves populate themselves.
select count(*) as rows_now from public.template_elements;
