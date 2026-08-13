-- Hot access pattern for the baker billing UI: a baker's payments, newest first.
-- Both the latest-payment fetch (ORDER BY charged_at DESC LIMIT 1) and the per-baker
-- count ride this composite index. Replaces the baker-only index for these queries
-- (kept too — it's harmless and still covers bare baker_id lookups).
CREATE INDEX IF NOT EXISTS payments_baker_charged_at_idx
  ON payments (baker_id, charged_at DESC);
