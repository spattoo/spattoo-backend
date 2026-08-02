-- ── 034: a receipt for a credit top-up ──────────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Every other payment we take sends the baker an email — subscription_activated,
-- subscription_renewed, payment_failed. A credit top-up was the only money that changed hands in
-- silence: the in-app panel confirms it, but that lives on a screen they close, and a receipt is
-- what people search their inbox for months later when reconciling what they spent.
--
-- The accounting service does email a GST invoice for the same payment, and that is a legal
-- document rather than a receipt — it arrives from a different sender, is addressed to the
-- registered business, and says nothing about how many credits are now in the wallet or that they
-- never expire. Both are wanted; neither replaces the other.
--
-- `on conflict do nothing` because this table is seeded per-migration (007 seeded the first two,
-- 020 added the erasure notice) and a re-run must not raise on the unique slug.
insert into notification_types (slug, label) values
  ('credits_purchased', 'AI credits — purchase receipt')
on conflict (slug) do nothing;
