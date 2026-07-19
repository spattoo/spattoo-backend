-- baker_template_exclusions — a baker hides specific SPATTOO GLOBAL templates from their tenant.
--
-- Mirrors baker_flavour_exclusions exactly (the same "baker switches off one of Spattoo's global
-- items" pattern). A row means: this baker has hidden this global template. Absence = shown. So the
-- default (no rows) is "every global template is visible", and the table only ever stores the rare
-- opt-OUTs — it never has to be backfilled when Spattoo publishes a new global template.
--
-- SCALE / schema shape (see CLAUDE.md "model the hot table"):
--   • This is the hot-access table: "give me THIS baker's hidden template ids" runs on every
--     GET /api/templates. The composite PK (baker_id, template_id) is that index — its baker_id
--     prefix serves the lookup with no extra index needed.
--   • baker_id and template_id are BOTH uuid because bakers.id and cake_templates.id are uuid —
--     there is no compact surrogate to prefer here (the referenced keys are already uuid PKs).
--   • The set is bounded per baker (a baker hides at most the count of global templates, tens),
--     never a growing per-row fact — so no partitioning/rollup concern.
--   • ON DELETE CASCADE both ways: retiring a global template or offboarding a baker cleans its
--     exclusion rows automatically, so the table can't accumulate dangling references.

create table if not exists baker_template_exclusions (
  baker_id    uuid        not null references bakers(id)         on delete cascade,
  template_id uuid        not null references cake_templates(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (baker_id, template_id)
);

comment on table baker_template_exclusions is
  'Per-baker hidden GLOBAL templates. A row = this baker has switched OFF that Spattoo global template, so it is filtered out of GET /api/templates for the whole tenant. Baker-owned templates are never listed here (a baker deletes their own). Mirrors baker_flavour_exclusions.';
