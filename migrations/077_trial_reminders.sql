-- ── 077: tell a baker their Spark trial is running out ──────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- The trial gate already refuses new orders the moment it lapses, and the billing screen shows the
-- end date — but both are PASSIVE. A baker who spends three weeks building a storefront and then
-- goes quiet for a fortnight discovers the deadline by being refused, which is the one moment we
-- have their attention and the worst possible way to get it.
--
-- Four sends across one trial, and they are two different emails:
--   7 days   informational. Nothing has stopped. Names what a plan would keep running.
--   2 days   short.
--   0 days   short, and says what stops.
--  -1 day    a DIFFERENT message — nothing is "running out" any more, so it stops selling
--            urgency it no longer has and says the work is all still there.
--
-- Which day each baker is on is decided in src/services/trialReminders.js, in the BAKER's timezone,
-- and gated by `npm run check:trial-reminders`.
insert into notification_types (slug, label) values
  ('trial_ending', 'Spark trial — ending soon'),
  ('trial_ended',  'Spark trial — ended')
on conflict (slug) do nothing;

-- ── Why no new column, unlike the credits alert ──────────────────────────────────────────
-- 035 needed `credits_low_alert_month` because the allowance RESETS: the same baker legitimately
-- crosses the same threshold every month, so "have we already said this?" needs a period to hang on.
--
-- A Spark trial is one-time and never resets (billing.js refuses a second one outright), so the
-- question "has this baker had the 7-day email?" is answered forever by the notification's own
-- dedupe key — `trial:<baker>:m7`. A column would be a second copy of a fact that already has a
-- home, and the two could disagree.
--
-- ⚠️ THE DEDUPE KEY IS THE ONLY RECORD, so it has to be per MILESTONE and not per day. Per day, a
-- baker sitting in the seven-day bucket for five days would receive five identical emails — which
-- is how a useful reminder becomes a filtered sender.
