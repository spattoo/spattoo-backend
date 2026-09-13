-- ── 092: "your plan renews in two days" ────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
-- Everything a PAID baker was ever told about their billing arrived on a Razorpay
-- webhook: subscription.charged, .pending, .halted. Their ACCESS did not — that is
-- derived at read time from `now() >= current_period_end` (see the CASE in
-- subscription_derived_status_dry.sql).
--
-- So the two halves ran on different clocks, and the asymmetry only ever bites one
-- way: the LOCKOUT is guaranteed, the WARNING is not. On 2026-09-11 a dev baker's
-- period ended, no webhook of any kind arrived, and they were shut out of the app
-- having been told nothing beforehand and nothing after.
--
-- A reminder two days out does not need a webhook. It needs a calendar.
--
-- ⚠️ NOT a replacement for the payment_failed / subscription_expired mails, which say
-- something this one cannot: that a charge was ATTEMPTED and did not work. This one
-- fires before anything has been tried.
--
-- audience defaults to 'baker' (057) — correct here, so it is not set explicitly.

INSERT INTO notification_types (slug, label) VALUES
  ('subscription_renewing', 'Your plan renews soon — paid-plan reminder')
ON CONFLICT (slug) DO NOTHING;
