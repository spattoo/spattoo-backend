-- ── 061: `move` becomes a real capability ──────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- Admin has been showing a "Movable" checkbox that NOTHING reads. `element_action_types`
-- seeds three keys — resize, color, delete — and `move` was never among them, yet the
-- form is registry-driven, so a row added to that table renders a checkbox whether or not
-- any code consumes it.
--
-- The result was a flag that changed nothing in either direction: decoration stickers
-- dragged whether it was ticked or not (DraggableTopSticker / DraggableSideSticker take no
-- capability at all), and ring pieces dragged in neither case. An admin ticked it, saved,
-- and got silence.
--
-- spattoo-core now gates the sticker draggables on `allowed_actions.move`, so unticking it
-- genuinely locks a decoration in place. This migration makes the key exist and, more
-- importantly, makes sure NOTHING THAT MOVES TODAY STOPS MOVING.
--
-- ── ⚠️ THE DEFAULT IS true, AND THAT MATTERS MORE THAN THE COLUMN ───────────────────
-- Every decoration on every cake is currently movable. A capability that defaults to false
-- would silently freeze all of them the moment the code ships — a regression nobody would
-- report as "the flag works now", only as "I can't move my decorations".
--
-- Belt and braces, because the two halves deploy separately:
--   * this migration writes an explicit `true` onto existing rows, and
--   * core reads `allowedActions.move !== false`, so an ABSENT key is movable too.
-- Ship the code before the migration and nothing changes; ship the migration alone and
-- nothing changes.

BEGIN;

-- 1. The key itself. `on conflict do nothing` because the row may already exist — the admin
--    form has been offering "Movable", which means somebody added it by hand.
insert into element_action_types (key, label, description, default_value, sort_order)
values ('move', 'Movable',
        'Let the customer drag this decoration to a new spot on the cake. Untick to pin it where it is placed.',
        true, 4)
on conflict (key) do nothing;

-- 2. Every element TYPE, so future promotions and placements inherit it.
update element_types
   set default_allowed_actions = coalesce(default_allowed_actions, '{}'::jsonb) || '{"move": true}'::jsonb
 where not (coalesce(default_allowed_actions, '{}'::jsonb) ? 'move');

-- 3. Every element that already exists. `where not (… ? 'move')` so this is genuinely
--    idempotent AND so a re-run cannot undo an admin who has since unticked one — the
--    backfill is for rows that never had an opinion, not a reset.
update cake_elements
   set allowed_actions = coalesce(allowed_actions, '{}'::jsonb) || '{"move": true}'::jsonb
 where not (coalesce(allowed_actions, '{}'::jsonb) ? 'move');

COMMIT;

-- Verify — the key exists, and no element is left without an opinion:
--   select key, label, default_value from element_action_types order by sort_order;
--   select count(*) from cake_elements where not (coalesce(allowed_actions,'{}'::jsonb) ? 'move');
--   -- expect 0
