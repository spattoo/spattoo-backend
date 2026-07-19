-- orders.design_snapshot: drop NOT NULL.
--
-- The orders table was created before design-less orders existed — every order came
-- from the 3D designer, so design_snapshot was NOT NULL. Manual orders (see
-- features/manual-orders.md) have no design: the baker works from a reference photo or
-- nothing. The manual-order route inserts design_snapshot = null and skips the design
-- version seed; with the old constraint that insert failed (23502) → "internal server
-- error" on Create.
--
-- A NULL design_snapshot is the canonical "no design" signal the whole app already
-- reads (X-Ray and Edit-in-3D gate on it, the thumbnail falls back to the reference
-- photo). Making the column nullable is what lets that signal exist.
--
-- Idempotent: DROP NOT NULL on an already-nullable column is a no-op.

ALTER TABLE orders ALTER COLUMN design_snapshot DROP NOT NULL;
