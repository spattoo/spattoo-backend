-- Retire the QUARTERLY billing period (decided 2026-07-27). Monthly + yearly only.
--
-- WHY (full rationale: spattoo-core docs/SUBSCRIPTION_TIERS.md § "Billing intervals"):
-- quarterly discounts the bakers closest to committing for twelve months and returns three
-- instead; at 10% the rung is too small to change behaviour but large enough to leak margin;
-- and it quadruples renewal events on payment rails where every renewal can fail. It was never
-- on the marketing pricing page either — only in the in-app billing panel — so retiring it makes
-- the two agree.
--
-- THIS IS A REVERSIBLE FLAG, NOT A DELETION. The row and its id (2) stay forever:
-- baker_subscriptions.billing_period_id references it, and billingEvents labels historical rows
-- through PERIOD.NAME_BY_ID, so a deleted or renumbered row would orphan history and shift
-- yearly's id. To sell quarterly again, flip this one value back — no deploy, no migration:
--
--     update billing_periods set is_active = true where name = 'quarterly';
--
-- WHAT IT SWITCHES OFF, everywhere at once:
--   * GET /billing/periods filters .eq('is_active', true) → the in-app interval picker
--     (BillingPanel) renders only what this returns, so the Quarterly button disappears.
--   * POST /billing/subscribe re-reads the row and rejects an inactive period with
--     `billing_period_inactive`, so a direct API call can't bypass the picker.
--
-- WHAT IT DELIBERATELY DOES NOT TOUCH:
--   * Existing quarterly subscribers would keep renewing — renewal runs off the Razorpay
--     subscription.charged webhook, which advances current_period_end from Razorpay's own
--     current_end and never reads this table. (Checked 2026-07-27: ZERO subscriptions reference
--     period 2, so today this grandfathers nobody. Kept true by construction regardless.)
--   * Historical labelling: PERIOD.NAME_BY_ID / PERIOD_SHORT still carry 'quarterly' on purpose.
--
-- Idempotent: plain UPDATE keyed on the stable natural key, safe to re-run.

update billing_periods
   set is_active = false
 where name = 'quarterly';
