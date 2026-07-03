-- ── customer_invites: carry a starting design ─────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- Lets a baker share a specific starting design with a customer via the invite. The
-- design is snapshotted ONTO THE INVITE (frozen at send) — not stored as a
-- cake_templates row — because a shared draft is "this invite's starting design":
-- 1:1 with the invite, never browsed/reused, and it dies with the invite. This
-- keeps cake_templates a purely curated library (the templates sidebar never grows
-- from sharing). Mirrors how orders.design_snapshot already snapshots a design.
--
-- Resume path (single): the customer resumes from customer_invites.design_snapshot.
--   NULL design_snapshot = today's "come design (blank)" invite — unchanged.
--
-- template_id is PROVENANCE ONLY (which library template the design was seeded from,
-- for analytics) — it is NOT read on the resume path. ON DELETE SET NULL so deleting
-- a template never touches the invite or its audit trail.
--
-- jsonb is TOAST-ed off-heap, so invite validity/list queries (which select scalar
-- columns) never pull the design; only GET /invite/:id reads it, when it's needed.

ALTER TABLE customer_invites
  ADD COLUMN IF NOT EXISTS design_snapshot      jsonb,
  ADD COLUMN IF NOT EXISTS design_thumbnail_url text,
  ADD COLUMN IF NOT EXISTS template_id          uuid REFERENCES cake_templates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS customer_invites_template_idx ON customer_invites (template_id);
