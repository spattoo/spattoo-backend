-- ── 085: edible prints are offered, so the action becomes active ─────────────────────────────────
--
-- 083 seeded `edible_print_generate` inactive and said why: `is_active` means "currently offered",
-- and an inactive row both keeps the billing card from advertising a feature that does not exist and
-- makes `reserve_ai_credits` fail closed with UNKNOWN_ACTION if anything calls it early. It also
-- said when to flip it: "in the change that ships it."
--
-- This is that change. `routes/ediblePrints.js` now serves:
--   POST /api/orders/:id/edible-prints/identify   free — a second read of a photo already paid for
--   POST /api/orders/:id/edible-prints/generate   metered, one image per press
--
-- ⚠️ Flipping this is what makes the meter LIVE. Until now a call would have failed closed; from
-- here it debits a real baker. The route is capability-gated (`order:manage`), tenant-scoped through
-- assertBakerOwns, refuses licensed characters before spending, and releases the hold on every path
-- that is not a committed success (withAiCredits). Those four are the reason this is safe to turn on
-- and not merely due.
--
-- 16 credits, unchanged from 084 — one medium 1024x1024 on gpt-image-1.5, ~₹3.06 landed, 81% margin.

update credit_costs
   set is_active = true, updated_at = now()
 where action_key = 'edible_print_generate';

-- Expect: three active actions, each with a distinct label (migration 026's partial unique index
-- enforces that — two actions sharing a label render as one job at two prices and read as a bug).
select action_key, credits, label, is_active
  from credit_costs
 where is_active
 order by action_key;
