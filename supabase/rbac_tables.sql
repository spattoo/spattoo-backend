-- ── RBAC: roles, capabilities, role↔capability matrix, admins ─────────────────
-- Run once in the Supabase SQL editor.
-- Safe to re-run: uses IF NOT EXISTS / ON CONFLICT DO NOTHING throughout.
--
-- Model:
--   principal (Supabase auth user)
--     → role        (admin | admin_staff | owner | staff | customer)
--     → capabilities (resolved from role_capabilities; `admin` is_super → ALL caps)
--   Capability = a FUNCTIONAL action ('customer:manage'), not an endpoint.
--   The role↔capability matrix is DATA so it can be managed from the admin UI.

-- ── 1. capabilities ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS capabilities (
  key          text PRIMARY KEY,             -- 'customer:manage'
  label        text NOT NULL,                -- 'Manage customers'
  description  text,
  category     text NOT NULL DEFAULT 'baker',-- 'design' | 'baker' | 'platform' (UI grouping)
  is_sensitive boolean NOT NULL DEFAULT false,-- money / governance actions
  sort_order   int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO capabilities (key, label, description, category, is_sensitive, sort_order) VALUES
  ('design:create',         'Create designs',            'Open and build a cake design',                      'design',   false, 0),
  ('order:place',           'Place orders',              'Submit a cake order',                               'design',   false, 1),
  ('order:view',            'View orders',               'See orders for the baker',                          'baker',    false, 10),
  ('order:manage',          'Manage orders',             'Update order status / details',                     'baker',    false, 11),
  ('customer:manage',       'Manage customers',          'Create, edit, and invite customers',                'baker',    false, 12),
  ('template:manage',       'Manage templates',          'Create and edit baker templates',                   'baker',    false, 13),
  ('store:manage',          'Manage store',              'Edit settings, branding, storefront',               'baker',    false, 14),
  ('staff:manage',          'Manage staff',              'Add / remove baker staff users',                    'baker',    false, 15),
  ('billing:manage',        'Manage own billing',        'Manage the baker''s own subscription & payments',   'baker',    false, 16),
  ('baker:onboard',         'Onboard bakers',            'Create and manage baker accounts',                  'platform', false, 20),
  ('catalog:admin',         'Manage global catalog',     'Global elements, types, and templates',             'platform', false, 21),
  ('baker:support',         'Support access',            'View baker data for support',                        'platform', false, 22),
  ('billing:discount',      'Issue discounts',           'Apply discounts to a baker',                        'platform', true,  30),
  ('subscription:override', 'Override subscriptions',    'Comp / offer subscription upgrades',                'platform', true,  31),
  ('admin:manage',          'Manage admins & RBAC',      'Add/remove admins, edit roles & capabilities',      'platform', true,  32),
  -- Sensitive: publishing a version writes the row consent records point at, and flips is_current,
  -- so it changes what every future consent binds to. Super admins only — see migration 090, which
  -- adds it to environments that already exist.
  ('legal:manage',          'Publish legal versions',    'Freeze and publish a version of a legal document',  'platform', true,  33)
ON CONFLICT (key) DO NOTHING;

-- ── 2. roles ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roles (
  key         text PRIMARY KEY,              -- 'owner'
  label       text NOT NULL,                 -- 'Baker Owner'
  description text,
  scope       text NOT NULL DEFAULT 'baker', -- 'platform' | 'baker' | 'customer'
  is_super    boolean NOT NULL DEFAULT false,-- holds ALL capabilities, incl. future ones
  is_system   boolean NOT NULL DEFAULT true, -- protect built-in roles from deletion
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO roles (key, label, description, scope, is_super, sort_order) VALUES
  ('admin',       'Admin (super)',  'Full platform access — every capability',                'platform', true,  0),
  ('admin_staff', 'Admin Staff',    'Platform operations without privileged money actions',   'platform', false, 1),
  ('owner',       'Baker Owner',    'Full access to the baker''s own store',                  'baker',    false, 2),
  ('staff',       'Baker Staff',    'Day-to-day baker work; no store/billing/staff admin',    'baker',    false, 3),
  ('customer',    'Customer',       'Design and order only',                                  'customer', false, 4)
ON CONFLICT (key) DO NOTHING;

-- ── 3. role_capabilities (the editable matrix) ────────────────────────────────
CREATE TABLE IF NOT EXISTS role_capabilities (
  role_key       text NOT NULL REFERENCES roles(key)        ON DELETE CASCADE,  -- scale-ok: bounded RBAC matrix (roles × capabilities), never grows with business
  capability_key text NOT NULL REFERENCES capabilities(key) ON DELETE CASCADE,  -- scale-ok: bounded RBAC matrix
  PRIMARY KEY (role_key, capability_key)
);

-- Seed the locked matrix. `admin` is intentionally omitted — is_super grants all.
INSERT INTO role_capabilities (role_key, capability_key) VALUES
  -- admin_staff
  ('admin_staff', 'design:create'),
  ('admin_staff', 'baker:onboard'),
  ('admin_staff', 'catalog:admin'),
  ('admin_staff', 'baker:support'),
  -- owner (all baker caps)
  ('owner', 'design:create'),
  ('owner', 'order:place'),
  ('owner', 'order:view'),
  ('owner', 'order:manage'),
  ('owner', 'customer:manage'),
  ('owner', 'template:manage'),
  ('owner', 'store:manage'),
  ('owner', 'staff:manage'),
  ('owner', 'billing:manage'),
  -- staff
  ('staff', 'design:create'),
  ('staff', 'order:place'),
  ('staff', 'order:view'),
  ('staff', 'order:manage'),
  ('staff', 'customer:manage'),
  ('staff', 'template:manage'),
  -- customer
  ('customer', 'design:create'),
  ('customer', 'order:place')
ON CONFLICT (role_key, capability_key) DO NOTHING;

-- ── 4. admins (platform staff — explicit, positive grant) ─────────────────────
-- Authorization is NEVER defined by the absence of a baker_appusers row.
-- A Supabase user is an admin ONLY if they appear here.
CREATE TABLE IF NOT EXISTS admins (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role         text NOT NULL DEFAULT 'admin_staff'  -- scale-ok: admins is platform staff only (a handful of rows, ever)
                 REFERENCES roles(key)
                 CHECK (role IN ('admin', 'admin_staff')),
  email        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ── 5. Seed your super-admin ──────────────────────────────────────────────────
-- REQUIRED: without this, every admin route returns 403 (deny-by-default).
-- Replace the email with your Supabase Auth login, then run.
INSERT INTO admins (auth_user_id, role, email)
SELECT id, 'admin', email
FROM auth.users
WHERE email = 'REPLACE_WITH_YOUR_ADMIN_EMAIL'
ON CONFLICT (auth_user_id) DO UPDATE SET role = EXCLUDED.role;
