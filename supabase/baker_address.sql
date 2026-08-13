-- Structured bakery address — for the storefront AND geo analytics (e.g. how many
-- subscriptions per city). City/state/country are kept as queryable columns (NOT a
-- single line / jsonb) so we can GROUP BY and index them. Replaces the earlier
-- single-line `address` column. Indexed for the geo-rollup access pattern.
ALTER TABLE bakers DROP COLUMN IF EXISTS address;

ALTER TABLE bakers ADD COLUMN IF NOT EXISTS address_line1 text;
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS address_line2 text;
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS street        text;
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS city          text;
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS state         text;
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS postal_code   text;
ALTER TABLE bakers ADD COLUMN IF NOT EXISTS country       text;

-- Geo rollups (subscriptions by city / state / country) hit these dimensions in order.
CREATE INDEX IF NOT EXISTS idx_bakers_geo ON bakers (country, state, city);
