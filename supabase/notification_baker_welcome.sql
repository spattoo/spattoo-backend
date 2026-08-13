-- ── notification type: baker welcome (post-confirmation onboarding) ───────────
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Emailed to a NEW baker right after their bakery is created (createBakerForUser) — i.e. after
-- email verification + setup, NOT the expiring Supabase confirm link. Carries the getting-started
-- kit (branding, first template, publish storefront, invite a customer). Fires exactly once
-- (createBakerForUser is idempotent), so no welcomed_at guard is needed.

INSERT INTO notification_types (slug, label) VALUES
  ('baker_welcome', 'Baker welcome / onboarding kit — post-confirmation')
ON CONFLICT (slug) DO NOTHING;
