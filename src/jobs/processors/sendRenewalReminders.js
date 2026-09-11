import { supabase } from '../../services/supabase.js';
import { notifyRenewalReminder } from '../../services/notifications.js';
import { SUBSCRIPTION_STATUS } from '../../constants/subscriptionStatuses.js';
import { PLAN } from '../../constants/subscriptionPlans.js';
import { config } from '../../config.js';
import {
  daysUntilRenewal, shouldRemind, renewalPayload, RENEWAL_REMINDER_DAYS,
} from '../../services/renewalReminders.js';

// ── "Your plan renews in two days" ───────────────────────────────────────────────────────────────
//
// ⚠️ WHY THIS EXISTS AT ALL. Everything a paid baker is told about their billing came from a
// Razorpay WEBHOOK — `subscription.charged`, `.pending`, `.halted`. Access did not: it is derived at
// read time, `now() >= current_period_end` (subscription_derived_status_dry.sql). So the two halves
// ran on different clocks, and the asymmetry only bites one way: the LOCKOUT always happens, and the
// WARNING only happens if a webhook arrives. On 2026-09-11 a dev baker's period ended, no webhook of
// any kind came, and they were shut out of the app having been told nothing at any point.
//
// This does not fix the missing webhook — nothing here can. It removes the dependency for the one
// message that should never have had it. A reminder two days out is a thing a calendar can produce.
//
// The RULES live in services/renewalReminders.js so the schedule is testable without a database
// (npm run check:renewal-reminders). This file is the plumbing.

const BATCH = 1000;

export async function sendRenewalReminders() {
  const now = new Date();

  /* ⚠️ THREE FILTERS, and each one excludes a baker who would be told something false.
   *
   *   billing_subscription_id NOT NULL — Razorpay-backed only. A Spark trial has no renewal to
   *       warn about; trialReminders owns that countdown and would otherwise double up.
   *   cancel_at_period_end = false     — a baker who has CANCELLED is not renewing, they are
   *       ending. "Your plan renews on the 11th" is the opposite of true for them.
   *   status ACTIVE                    — past_due/paused/cancelled rows are a different message.
   *
   * The date window is generous and the exact day is decided per baker below, in their own zone: a
   * row inside this window can still be dropped there, a row outside it can never be needed.
   */
  const from = new Date(now.getTime() - 86400000).toISOString();
  const to   = new Date(now.getTime() + (RENEWAL_REMINDER_DAYS + 2) * 86400000).toISOString();

  const { data: subs, error } = await supabase
    .from('baker_subscriptions')
    .select('id, baker_id, plan_id, current_period_end')
    .not('billing_subscription_id', 'is', null)
    .eq('cancel_at_period_end', false)
    .eq('status_id', SUBSCRIPTION_STATUS.ACTIVE)
    .gte('current_period_end', from)
    .lte('current_period_end', to)
    .limit(BATCH);
  if (error) throw new Error(`[renewal-reminders] subscription lookup failed: ${error.message}`);

  if (!subs?.length) {
    // Logged even when empty: "ran and there was nobody" and "did not run" look identical from the
    // outside otherwise, and this job's whole failure mode is silence.
    console.log(`[renewal-reminders] no paid renewals between ${from} and ${to}`);
    return;
  }

  const { data: bakers, error: bakerErr } = await supabase
    .from('bakers')
    .select('id, name, email, is_active, timezone')
    .in('id', subs.map(s => s.baker_id));
  if (bakerErr) throw new Error(`[renewal-reminders] baker lookup failed: ${bakerErr.message}`);

  const bakerById = new Map((bakers ?? []).map(b => [b.id, b]));
  let sent = 0, deduped = 0, skipped = 0;

  for (const sub of subs) {
    const baker = bakerById.get(sub.baker_id);
    if (!baker?.is_active) { skipped++; continue; }        // a closed account is not a renewal

    const tz = baker.timezone || config.jobs.renewalReminderTz;
    // ⚠️ `shouldRemind`, not the day count alone. A period ending in the evening UTC is already
    // "today" in India while the moment itself has passed — see renewalReminders.js. Asking only
    // the day question sends "your plan renews today" to a baker who is already locked out.
    if (!shouldRemind(sub.current_period_end, now, tz)) { skipped++; continue; }
    const days = daysUntilRenewal(sub.current_period_end, now, tz);

    try {
      const produced = await notifyRenewalReminder({
        baker,
        periodEnd: sub.current_period_end,
        payload: renewalPayload({
          // Same source the webhook path uses (billing.js), so one plan never has two names.
          bakerName: baker.name, planName: PLAN.NAME_BY_ID[sub.plan_id] ?? null,
          periodEnd: sub.current_period_end, days, tz,
        }),
      });
      produced ? sent++ : deduped++;   // null = the dedupe key caught it; already sent this cycle
    } catch (err) {
      // One baker's failure must not cost everyone after them their reminder. This is a billing
      // deadline: the loop has to reach the rest of the list.
      console.error(`[renewal-reminders] baker ${sub.baker_id} failed:`, err.message);
      skipped++;
    }
  }

  console.log(`[renewal-reminders] ${subs.length} renewals in window → ${sent} sent, ${deduped} already sent, ${skipped} skipped`);
}
