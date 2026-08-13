-- "My Decorations" — a baker's (and a customer's) own uploaded decorations.
--
-- OWNERSHIP MODEL. `cake_elements` already carries a nullable `baker_id` where NULL = global (the
-- convention in lib/tenantScope.js). This adds a second, NARROWER scope so a customer's upload is
-- private to that customer rather than shared across the baker's whole tenant:
--
--   baker_id NULL,  customer_id NULL   → GLOBAL      — every baker, every customer
--   baker_id = B,   customer_id NULL   → BAKER B     — baker B's team AND all of B's customers
--   baker_id = B,   customer_id = C    → CUSTOMER C  — only customer C (still within baker B)
--
-- The middle row is the point of the feature: a baker's uploaded decoration must be usable BY their
-- customers, or it's useless. The bottom row is the safety property: without it, a customer's upload
-- would inherit the tenant scope and be shown to every OTHER customer of that baker — one customer's
-- photo appearing in another's designer. Different scopes, different columns.

ALTER TABLE cake_elements
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE CASCADE;
-- CASCADE, not SET NULL, and deliberately: SET NULL would PROMOTE a deleted customer's private
-- upload into the baker's shared library — the opposite of what erasure means. A customer's erasure
-- must take their uploads with it (DPDP).

COMMENT ON COLUMN cake_elements.customer_id IS
  'Narrower-than-tenant owner. NULL = shared with the whole baker (or global if baker_id is also NULL); set = private to that one customer.';

-- ── Indexes ──────────────────────────────────────────────────────────────────────────────────────
-- SCALE: this table is ~59 global rows TODAY, but private libraries make it grow as
-- (bakers × their assets) + (customers × their uploads) — past a million well before 25k bakers. And
-- `baker_id` is filtered on EVERY designer load (scopeCatalogRead). There is currently NO index on it
-- at all: the read is a seq scan that only looks fine because the table is tiny. Fix it before the
-- data arrives, not after.
CREATE INDEX IF NOT EXISTS cake_elements_scope_idx
  ON cake_elements (baker_id, is_active);
CREATE INDEX IF NOT EXISTS cake_elements_customer_idx
  ON cake_elements (customer_id) WHERE customer_id IS NOT NULL;   -- partial: almost every row is NULL here

-- ── Which types a baker may upload into ──────────────────────────────────────────────────────────
-- An uploaded image is not placeable until it has allowed_zones + placement_config. Rather than ask a
-- baker to fill in the admin's placement form (they won't, and shouldn't have to), the upload INHERITS
-- the element type's existing `placement_rules` template ({zones, placement}) — which admin already
-- authors. This flag is how admin says "this type is safe for a baker to upload into", so the list of
-- offered kinds is DATA, not a hardcoded array in the designer.
ALTER TABLE element_types
  ADD COLUMN IF NOT EXISTS baker_uploadable boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN element_types.baker_uploadable IS
  'Admin opt-in: a baker/customer may upload their own element of this type. The upload inherits this row''s placement_rules.';

-- Seed the two kinds that make sense for an arbitrary uploaded image: a flat decoration that hugs the
-- cake, and one that stands on top. Both already have sane placement_rules.
UPDATE element_types SET baker_uploadable = true WHERE slug IN ('top_side_decors', 'image_topper');

-- ── Capability ───────────────────────────────────────────────────────────────────────────────────
-- Element authoring has been catalog:admin-only, which is platform-staff. Bakers need their OWN,
-- non-admin capability — it must NOT be catalog:admin, or they'd be able to write the GLOBAL catalog.
INSERT INTO capabilities (key, label, description, category, is_sensitive, sort_order) VALUES
  ('element:manage', 'Manage own decorations', 'Upload and remove their own cake decorations', 'baker', false, 17)
ON CONFLICT (key) DO NOTHING;

-- owner + staff mirror template:manage (both already hold it). `customer` gets it too: a customer
-- uploading their own image for their own cake is the same act, and the API scopes what they create
-- to themselves (customer_id) — the capability grants the ACTION, the route decides the OWNERSHIP.
INSERT INTO role_capabilities (role_key, capability_key) VALUES
  ('owner',    'element:manage'),
  ('staff',    'element:manage'),
  ('customer', 'element:manage')
ON CONFLICT (role_key, capability_key) DO NOTHING;
