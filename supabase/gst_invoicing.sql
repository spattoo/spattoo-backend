-- ── GST invoicing — Wave 1 schema (GST_INVOICING_PLAN.md) ─────────────────────
-- Run once in the Supabase SQL editor. Idempotent.
--
-- (1) bakers.gstin — the recipient's GSTIN (optional; registered bakers add it for input-tax credit).
--     Captured on the checkout screen, saved to the profile so automatic renewals reuse it. The CHECK
--     enforces the 15-char GST format at the DB (defense-in-depth behind the API/UI validation); NULL
--     is allowed (unregistered / not provided).
--
-- (2) billing_outbox — the event seam. Core writes ONE row per successful charge (event_id =
--     razorpay_payment_id → idempotent). NO consumer yet; the future accounting system drains it (or a
--     message queue replaces it). Append-only; the payload is a self-contained party+amount snapshot so
--     the accounting system needs no read-back into core. Modelled for the hot path: compact, indexed on
--     the pending-delivery access pattern.

ALTER TABLE bakers
  ADD COLUMN IF NOT EXISTS gstin text;

DO $$ BEGIN
  ALTER TABLE bakers ADD CONSTRAINT bakers_gstin_format_chk
    CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS billing_outbox (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     text        NOT NULL UNIQUE,          -- idempotency key (= razorpay_payment_id)
  type         text        NOT NULL,                 -- 'sale.charge_captured'
  payload      jsonb       NOT NULL,                 -- self-contained party + amount snapshot
  status       text        NOT NULL DEFAULT 'pending', -- pending | delivered | failed
  attempts     int         NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

-- The relay's hot query: oldest undelivered events first.
CREATE INDEX IF NOT EXISTS billing_outbox_pending_idx
  ON billing_outbox (created_at)
  WHERE status = 'pending';
