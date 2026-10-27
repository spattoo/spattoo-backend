-- ── Undo 136's second statement: applicable_zones is a dead column ──────────────────────────────
--
-- ⚠️ A CORRECTION TO MY OWN MIGRATION, AND THE COMMENT IN IT WAS THE MISTAKE. 136 said
-- "`applicable_zones` is the wider 'could this ever go here' list; keep the two in step" and acted
-- on it. That was asserted, not checked, and it is wrong on both halves.
--
-- Nothing reads the column:
--   • it is absent from ELEM_FIELDS and ADMIN_ELEM_FIELDS (src/routes/elements.js), so the API has
--     never returned it to anybody;
--   • create and update do not accept it — elements.js destructures allowed_zones and not this;
--   • admin's own "applicable zones" control is backed by allowed_zones
--     (ManageElements.jsx:906, `setApplicableZones(el.allowed_zones ?? [])`);
--   • every element created since the column existed ships it EMPTY — see 127 (Balloon) and 134
--     (Sand itself), both `array[]::text[]`.
--
-- So 136 left exactly one row in the table disagreeing with the convention, and disagreeing in the
-- most misleading possible way: Sand's applicable_zones read `{board}` while its allowed_zones —
-- the list the designer actually consults — reads `{top_surface,board}`. Anyone inspecting the row
-- to answer "where can sand go?" would read the dead column and conclude "the board only", which is
-- the opposite of the feature. A vestigial column is harmless; a vestigial column carrying a wrong
-- answer is not.
--
-- ⚠️ NO FUNCTIONAL CHANGE. allowed_zones is untouched and stays {top_surface,board}. Sand on the
-- top and sand on the board both work before and after this runs. This is the table telling the
-- truth about itself, nothing more, so it can ride along with the next deploy rather than being
-- run in a hurry.
--
-- Idempotent, like the three before it: keyed on the name and on the value already being wrong.

BEGIN;

update cake_elements
   set applicable_zones = array[]::text[]
 where name = 'Sand'
   and coalesce(applicable_zones, '{}'::text[]) <> array[]::text[];

COMMIT;
