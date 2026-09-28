-- ── The opt-OUT half of template visibility is retired ─────────────────────────────────────────
--
-- Sandeep, 2026-09-28: "there are no bakers existing in prod. so prev logic of exclusions is not
-- valid. its only the catalogue that needs to be showed now."
--
-- `baker_template_exclusions` answered "which of Spattoo's global templates has this baker switched
-- OFF", and absence meant offered. `baker_template_settings` (migration 115) answers the opposite
-- question — which templates has this baker CHOSEN to offer — and absence means not offered. Both
-- were live at once on purpose, because a released browser bundle could still POST an exclusion set,
-- and under the new meaning that would have offered exactly what the baker had switched off.
--
-- That risk was entirely about production bundles. With no production bakers there is no such
-- bundle, so the two halves stopped needing to retire in order and the opt-OUT half goes now.
--
-- ⚠️ A DROP, NOT A MIGRATION OF DATA. Measured on dev before writing this: the table held **0 rows**
-- across all 24 bakers, after two months live. There is nothing to carry into the new table, and an
-- exclusion could not be translated into an inclusion anyway — "not switched off" and "chosen" are
-- different facts, and deriving the second from the first is how every baker would silently acquire
-- a catalogue they never curated.
--
-- ⚠️ THE READ PATH WENT FIRST. `lib/templateList.js` stopped querying this table in commit 22186fe,
-- which also deleted `GET /api/baker/templates` and `PUT /api/baker/templates/exclusions` — the only
-- two routes that touched it — plus their two (already dead) client methods in spattoo-web. So this
-- drops a table nothing reads, which is the order that keeps a deploy from failing in between.
--
-- ⚠️ DROPPING IT DOES NOT REMOVE THE POSTGREST AMBIGUITY IT WAS KNOWN FOR. `cake_templates` reached
-- `bakers` two ways: the owner FK, and many-to-many through this table. That is why
-- `GET /admin/templates` names its FK (`bakers!cake_templates_baker_id_fkey`) and why a bare
-- `bakers(...)` is PGRST201 and a 500 on the whole screen. `baker_template_settings` joins the same
-- two tables the same way, so the named FK is still required after this runs.

begin;

drop table if exists public.baker_template_exclusions;

commit;

-- ── Verify ──────────────────────────────────────────────────────────────────────────────────────
-- Expect: no row, i.e. the table is gone.
select table_name
  from information_schema.tables
 where table_schema = 'public'
   and table_name = 'baker_template_exclusions';

-- And the table that replaced it, for contrast — every row here is a deliberate choice to offer.
-- Expect on dev today: 2 rows, both offered_true, 1 baker with a catalogue.
select count(*)                                as catalogue_rows,
       count(*) filter (where offered)         as offered_true,
       count(*) filter (where not offered)     as offered_false,
       count(distinct baker_id)                as bakers_with_a_catalogue
  from public.baker_template_settings;
