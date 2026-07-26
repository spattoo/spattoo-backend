-- ── 021: orders calendar (month view) — READ-SIDE ONLY ───────────────────────────────
-- No new table, no new column. Creating an order from the calendar is the SAME order
-- creation as everywhere else (the delivery date is simply pre-filled in the existing
-- modal). This migration only makes DRAWING the month grid cheap.
--
-- The grid needs one number per day: how many cakes are due. It must never fetch the
-- orders themselves — a month of order rows is O(orders) over the wire and grows without
-- bound (a baker at 30/day is ~900 rows a month, refetched on every arrow click), whereas
-- a group-by is O(days) — at most 31 rows — no matter how big the bakery gets. So the
-- counting happens HERE, in the database, not in Node and not in the browser.
--
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.

-- 1. The hot access pattern: one baker's orders within a delivery-date window.
--    Serves the calendar AND the existing dashboard "due today / due this week" queries
--    (src/routes/dashboard.js), which filter on exactly (baker_id, delivery_date) too.
CREATE INDEX IF NOT EXISTS orders_baker_delivery_date_idx
  ON orders (baker_id, delivery_date);

-- 2. Per-day, per-status counts for one baker over a date window.
--    p_baker_id is ALWAYS supplied by the route from the authenticated token
--    (req.bakerId) — never from client input. Returns the compact status_id; the route
--    translates it to a readable key at the HTTP boundary (keyForId), so the surrogate
--    never leaves the server and the hot orders table stays lean.
--
--    The route works WITHOUT this function (it falls back to a two-column select counted
--    in Node), so applying it is an optimisation, not a prerequisite — same convention as
--    011_match_elements_rpc.sql.
CREATE OR REPLACE FUNCTION orders_calendar_counts(
  p_baker_id uuid,
  p_from     date,
  p_to       date
)
RETURNS TABLE (delivery_date date, status_id smallint, order_count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT o.delivery_date, o.status_id, count(*) AS order_count
  FROM orders o
  WHERE o.baker_id = p_baker_id
    AND o.delivery_date >= p_from
    AND o.delivery_date <= p_to
  GROUP BY o.delivery_date, o.status_id
$$;
