-- order_reference_photos — customer REFERENCE photos for a manual order.
--
-- A "manual order" is one a baker creates WITHOUT the 3D designer: they take a
-- reference image from the customer (or nothing) and bake it. These orders carry no
-- design_snapshot; the reference photos are the order's picture instead. The PRIMARY
-- reference (sort_order 0) is mirrored into orders.design_thumbnail_url at create/edit
-- time, so the list/detail/email thumbnail shows it with no render changes (same
-- denormalised-picture role that column already plays for designed orders).
--
-- This is a byte-for-byte sibling of order_finished_photos (baker-uploaded photos of
-- the FINISHED cake). Same shape, same ≤3 cap (enforced in the API), same
-- orders/<folder>/ R2 key convention — the route handlers are shared (one factory).
-- We keep it a SEPARATE table (not a `kind` column on one table) because the two sets
-- have different lifecycles and folders; a manual order can have BOTH a reference set
-- (at intake) and a finished set (at delivery).
--
-- SCALE: bounded per order (≤3). Indexed by (order_id, sort_order) for the ordered read.
-- ON DELETE CASCADE: photos die with the order.

CREATE TABLE IF NOT EXISTS order_reference_photos (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  key         text        NOT NULL,                    -- bare R2 key under orders/reference/
  sort_order  int         NOT NULL DEFAULT 0,          -- 0-based position; 0 = primary (the thumbnail)
  uploaded_by uuid        REFERENCES baker_appusers(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_reference_photos_order_idx
  ON order_reference_photos (order_id, sort_order);
