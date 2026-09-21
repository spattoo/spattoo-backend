-- ── A one-time welcome balance of message credits, for PAYING bakers only ────────────────────────
--
-- Customer updates over WhatsApp cost real money per send, so message credits are bought in packs
-- and nothing is given away by default. A baker who has never sent one has no way to judge whether
-- they are worth buying — the only evidence is a customer replying to a quote — so the first ones
-- are on us.
--
-- ⚠️ ON A PAID SUBSCRIPTION, NEVER ON SIGNUP. Sandeep, 2026-09-20: "we will add credits only when
-- baker takes paid subscription - we dont spend for trail bakers." A trial baker costs us nothing
-- here, which is what keeps the trial safe to give away — the same argument ai_credits_per_month
-- makes for smart tools.
--
-- ⚠️ AND "PAID ONLY" IS DATA, NOT AN `if`. The amount is an ENTITLEMENT with fallback 0, so Spark
-- (the free tier) grants nothing because its plan row says nothing, not because a branch checks the
-- tier name. Moving the line later is an admin edit; adding a tier needs no code (root CLAUDE.md
-- rules 2 and 3). It is also why the grant call can sit on every activation path without asking
-- which one it is: a plan worth 0 inserts no row.
--
-- ⚠️ ONE TIME IS A CONSTRAINT, NOT A CHECK. `if (alreadyGranted)` loses to a retried webhook, a
-- reactivation, or an upgrade — and every loss is free money. The partial unique index below makes a
-- second grant impossible at the database, so the service can insert optimistically and treat the
-- violation as "already had it".
--
-- 25 credits ≈ 12 orders at two enabled updates each (quote issued, order ready), on WhatsApp at
-- ₹0.145 a message — under ₹4 a baker, once, against a subscription. Not stated in any UI: the
-- number lives here and is read, never repeated (check:priced-copy in spattoo-core).

-- 1. A kind of its own. NOT 'grant' — smart-tool credits already use that for the MONTHLY allowance
--    and label it "Monthly credits"; a one-time welcome sharing that word would read as recurring in
--    a baker's own history. NOT 'adjustment' either: an adjustment is a correction of ours.
alter table message_transactions drop constraint if exists message_transactions_kind_check;
alter table message_transactions
  add constraint message_transactions_kind_check
  check (kind in ('purchase', 'debit', 'refund', 'adjustment', 'welcome'));

-- 2. Exactly one, ever, per bakery.
create unique index if not exists message_transactions_one_welcome
  on message_transactions (baker_id)
  where kind = 'welcome';

-- 3. Seeded on the PAID tiers only. Spark is the free tier and is deliberately absent — an absent
--    key falls back to 0 (src/constants/entitlements.js), which is the floor that makes "we don't
--    spend for trial bakers" true by default rather than by vigilance.
update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || '{"welcome_message_credits": 25}'::jsonb
 where id in (2, 3, 4);   -- flame, blaze, forge
