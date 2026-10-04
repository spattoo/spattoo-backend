-- ── 122: the rail stays black — the other looks are switched off, not deleted ─────────────────────
--
-- Sandeep, after seeing them on dev: "for now, lets go with the default one only. some how i did not
-- like it when i see it in dev. no wooden texture - its not in sync with the rest of the screen.
-- lets keep it in black."
--
-- The wood is the specific objection and it is a fair one: the app's chrome is a near-black that the
-- panels, the headers and the mobile sheet all share (shared/chrome.js), and a brown column is the
-- one thing on the screen not drawn from it. It read as wood and it did not read as Spattoo.
--
-- ⚠️ DEACTIVATED, NOT DROPPED, and the distinction is the point. `is_active = false` leaves the row,
-- the entitlement, the resolver and check:rail-skins exactly as they are — so turning a look back on
-- is one UPDATE, and the gate still measures these two for readability every build. Deleting them
-- would throw away work that is correct and was only ever a taste decision, and would quietly make
-- `baker_appusers.rail_skin` point at nothing for anyone who had chosen one.
--
-- Nobody has chosen one yet (nothing writes that column until the chooser ships to a Blaze baker),
-- but the resolver already handles it: an unknown or inactive key falls back to the default, so a
-- baker who HAD picked walnut simply sees black and keeps their choice for the day it returns.

BEGIN;

update public.rail_skins set is_active = false where key in ('walnut', 'slate');

COMMIT;
