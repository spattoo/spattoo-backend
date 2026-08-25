import { supabase } from '../../services/supabase.js';
import { notifyTrialReminder } from '../../services/notifications.js';
import { PLAN } from '../../constants/subscriptionPlans.js';
import { SUBSCRIPTION_STATUS } from '../../constants/subscriptionStatuses.js';
import { config } from '../../config.js';
import {
  daysLeft, milestoneFor, reminderPayload, MILESTONES, ENDED_EMAIL_MAX_DAYS_AFTER,
} from '../../services/trialReminders.js';

// ── The Spark trial countdown ────────────────────────────────────────────────────────────────────
// Runs on a schedule (config.jobs.trialReminderCron), not on an event: nothing happened, a date
// arrived. Like the delivery digest, it does not need to know whether it already ran — the
// notification's dedupe key answers that, so re-running is free.
//
// The RULES live in services/trialReminders.js so the schedule is testable without a database
// (npm run check:trial-reminders). This file is the plumbing: which subscriptions, which bakers,
// one email each.
//
// ⚠️ WHY THIS QUERIES baker_subscriptions AND NOT bakers.
// `bakers.subscription_end_date` exists and is NULL for every active trial — the trial-creation path
// writes plan and status onto `bakers` and never the end date. A version of this job reading the
// mirror finds nothing expiring, ever, and looks perfectly healthy while sending nothing.
// (`bakers.trial_ends_at` does not exist at all.)

const BATCH = 1000;

export async function sendTrialReminders() {
  const now = new Date();

  /* ⚠️ Bounded by DATE, and deliberately not by status.
   *
   * A Spark row stays ACTIVE long after its end_date: reconcileSubscriptions only relabels
   * Razorpay-backed rows (it keys on current_period_end, which Spark never has), and expiry is
   * derived at READ time by get_baker_subscription. Filtering on status alone would be filtering on
   * a label that nobody maintains for trials.
   *
   * The status filter that IS here does different work: it excludes trials that were explicitly
   * ended — a baker who upgraded has their Spark row set to CANCELLED by the billing route, and must
   * not be reminded about a trial they have already replaced with a paid plan.
   *
   * The window is generous on both sides of what the milestones use, and the exact day is decided
   * per baker below in their own timezone. A row inside the window here can still be dropped there;
   * a row outside it can never be needed.
   */
  const from = new Date(now.getTime() - (ENDED_EMAIL_MAX_DAYS_AFTER + 2) * 86400000).toISOString().slice(0, 10);
  const to   = new Date(now.getTime() + (MILESTONES[0] + 2) * 86400000).toISOString().slice(0, 10);

  const { data: subs, error } = await supabase
    .from('baker_subscriptions')
    .select('id, baker_id, end_date')
    .eq('plan_id', PLAN.SPARK)
    .eq('status_id', SUBSCRIPTION_STATUS.ACTIVE)
    .gte('end_date', from)
    .lte('end_date', to)
    .limit(BATCH);
  if (error) throw new Error(`[trial-reminders] subscription lookup failed: ${error.message}`);

  if (!subs?.length) {
    // Not a failure. Logged because "ran and there was nobody" and "did not run" look identical
    // from the outside otherwise — and this job's whole failure mode is silence.
    console.log(`[trial-reminders] no Spark trials between ${from} and ${to}`);
    return;
  }

  const { data: bakers, error: bakerErr } = await supabase
    .from('bakers')
    .select('id, name, email, is_active, timezone')
    .in('id', subs.map(s => s.baker_id));
  if (bakerErr) throw new Error(`[trial-reminders] baker lookup failed: ${bakerErr.message}`);

  const bakerById = new Map((bakers ?? []).map(b => [b.id, b]));
  let sent = 0, deduped = 0, skipped = 0;

  for (const sub of subs) {
    const baker = bakerById.get(sub.baker_id);
    // A deactivated bakery is not a sales prospect; it is an account somebody closed.
    if (!baker?.is_active) { skipped++; continue; }

    // Their day, not the server's — see trialReminders.js. Falls back to the configured default
    // rather than to the server clock, so a bakery with no timezone set is still counted in a real
    // place rather than in whichever region the worker happens to run.
    const days = daysLeft(sub.end_date, now, baker.timezone || config.jobs.trialReminderTz);
    const milestone = milestoneFor(days);
    if (milestone == null) { skipped++; continue; }

    try {
      const produced = await notifyTrialReminder({
        baker,
        milestone,
        payload: reminderPayload({ bakerName: baker.name, endDate: sub.end_date, days }),
      });
      produced ? sent++ : deduped++;   // null = the dedupe key caught it; already sent this milestone
    } catch (err) {
      // One baker's failure must not cost every baker after them their reminder. This is a billing
      // deadline: a missed email is money, and the loop has to reach the rest of the list.
      console.error(`[trial-reminders] baker ${sub.baker_id} failed:`, err.message);
      skipped++;
    }
  }

  console.log(`[trial-reminders] ${subs.length} trials in window → ${sent} sent, ${deduped} already sent, ${skipped} skipped`);
}
