-- ── notification types: subscription lifecycle (baker-facing) ─────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Emailed to the BAKER about their own Spattoo subscription, fired from the billing webhook
-- (routes/billing.js) on Razorpay events. (Signup/welcome is the branded Supabase auth email,
-- NOT a notification type. trial_ending / card_expiring need a scheduled scanner — added later.)

INSERT INTO notification_types (slug, label) VALUES
  ('subscription_activated', 'Subscription activated — baker'),
  ('subscription_renewed',   'Subscription renewed (payment received) — baker'),
  ('payment_failed',         'Subscription payment failed / action needed — baker'),
  ('subscription_cancelled', 'Subscription cancelled (access until period end) — baker'),
  ('subscription_expired',   'Subscription ended / lapsed — baker')
ON CONFLICT (slug) DO NOTHING;
