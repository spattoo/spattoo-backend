-- ── 035: warn a baker before the credits run out ────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- The pill and the billing card already go amber at 70% and red at 100%, but every one of those
-- signals is PASSIVE: it works only if the baker happens to be looking at the screen it is on.
-- Someone who spends their month's credits across a busy week and then reaches for X-Ray on a
-- Saturday finds out by being refused — which SUBSCRIPTION_TIERS.md is explicit about wanting to
-- avoid ("silently failing at the limit wastes the whole mechanism").
--
-- Two thresholds, because they are two different situations:
--   80%   running low. Nothing has stopped. Informational.
--   100%  the monthly allowance is gone. Something actually stops here.
insert into notification_types (slug, label) values
  ('credits_low',      'AI credits — running low'),
  ('credits_exhausted','AI credits — monthly allowance used up')
on conflict (slug) do nothing;

-- ── Why a column and not a query over `notifications` ────────────────────────────────
-- The allowance resets on the 1st, so without a per-month guard a heavy baker gets both emails
-- EVERY month — 24 a year telling them the product is working as designed, which is how an alert
-- becomes something people filter.
--
-- `notifications` cannot answer "have we told this baker yet" cheaply: it is keyed on
-- recipient_email, carries baker_id only inside the jsonb payload, and has no index that would
-- make that lookup sane on the send path — which runs inside an AI action.
--
-- So: the month we last warned them for, per threshold. A date rather than a boolean, because
-- "have we sent one" is only meaningful relative to a reset, and comparing against the current
-- month start is one expression with nothing to clear on the 1st. Nothing has to reset these; they
-- simply stop matching.
alter table bakers add column if not exists credits_low_alert_month       date;
alter table bakers add column if not exists credits_exhausted_alert_month date;

comment on column bakers.credits_low_alert_month is
  'Month (its 1st, IST) whose 80%-of-allowance warning has been sent. Null = never. Compared against the current month start, so it needs no monthly reset.';
comment on column bakers.credits_exhausted_alert_month is
  'Month (its 1st, IST) whose allowance-exhausted notice has been sent. Same convention as credits_low_alert_month.';
