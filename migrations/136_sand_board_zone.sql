-- ── Sand may sit on the board, not only on the top ───────────────────────────────────────────────
--
-- Migration 134 seeded the Sand row with `allowed_zones = {top_surface}`. The board was enabled
-- afterwards in Manage Elements on dev — which is the right place for it, since zones are the
-- admin's answer — so dev shows both and every other environment still shows one. Sandeep: *"user
-- should be able to add sand to board also. this is already done in admin. but i think missed
-- during the integration."*
--
-- ⚠️ THE GEOMETRY NEVER NEEDED CHANGING. `SandBed` takes a `zone` and DEFAULTS it to 'board';
-- `sandSpan` is the only place that knows a board drift from a top one (on the board, `size` is how
-- far past the cake the sand reaches). What was missing was the designer offering the surface at
-- all — core put every drift on the top tier.
--
-- ⚠️ IDEMPOTENT, because dev already has it. Appending blindly would give that row the zone twice.
BEGIN;

update cake_elements
   set allowed_zones = (
         select array(select distinct unnest(coalesce(allowed_zones, '{}'::text[]) || array['board']))
       )
 where name = 'Sand'
   and not (coalesce(allowed_zones, '{}'::text[]) @> array['board']);

-- `applicable_zones` is the wider "could this ever go here" list; keep the two in step.
update cake_elements
   set applicable_zones = (
         select array(select distinct unnest(coalesce(applicable_zones, '{}'::text[]) || array['board']))
       )
 where name = 'Sand'
   and not (coalesce(applicable_zones, '{}'::text[]) @> array['board']);

COMMIT;
