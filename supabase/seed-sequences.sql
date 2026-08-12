-- ─────────────────────────────────────────────────────────────────────────────
-- Sequence resync after seed-lookups.mjs.  GENERATED — run once, in the SQL editor.
--
-- These tables have serial/identity primary keys and were seeded with EXPLICIT ids to
-- keep both environments consistent. An explicit id does not advance the sequence, so
-- without this the next row the app inserts collides on the primary key.
-- ─────────────────────────────────────────────────────────────────────────────

select setval(pg_get_serial_sequence('public.order_statuses', 'id'),
              coalesce((select max(id) from public.order_statuses), 1));

select setval(pg_get_serial_sequence('public.dietary_requirements', 'id'),
              coalesce((select max(id) from public.dietary_requirements), 1));

select setval(pg_get_serial_sequence('public.notification_types', 'id'),
              coalesce((select max(id) from public.notification_types), 1));

select setval(pg_get_serial_sequence('public.credit_costs', 'id'),
              coalesce((select max(id) from public.credit_costs), 1));

select setval(pg_get_serial_sequence('public.credit_packs', 'id'),
              coalesce((select max(id) from public.credit_packs), 1));
