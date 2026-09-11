import { config } from '../config.js';

/* ── When to tell a baker their PAID plan is about to renew ───────────────────────────────────────
 *
 * The sibling of trialReminders.js, and deliberately not an extension of it, because the two differ
 * on the one thing that matters most — how often they may fire.
 *
 * A trial happens ONCE. Its dedupe key is `trial:<baker>:m<milestone>`: one email per baker per
 * milestone, forever, which is exactly right for something that cannot recur. A renewal happens
 * EVERY cycle. Key it the same way and a baker gets one reminder in their life and none for the
 * next twenty-three months — a bug that would look like nothing at all, because the code ran, the
 * logs were clean, and the only symptom is an email that stopped coming.
 *
 * So the key here carries the PERIOD. Same baker, next month, different key, another reminder.
 *
 * ── ⚠️ THE DAY IS COMPUTED FROM THE INSTANT, NOT FROM THE STRING ────────────────────────────────
 * `current_period_end` is a timestamptz, and trialReminders' `daysLeft` takes `String(d).slice(0,10)`
 * — the UTC date. That is right for a trial's `end_date`, which IS a date, and wrong here. The row
 * that prompted this work ends at `2026-09-10T18:30:00Z`, which in Asia/Kolkata is **midnight on the
 * 11th**. Slicing the string calls that the 10th and every countdown is a day out for every Indian
 * bakery — which is all of them.
 */

// Remind this many days before the renewal. A BUCKET, not an equality test, for the reason
// trialReminders gives at length: if the worker is down on the one day a baker sits at exactly 2,
// an equality test sends nothing and records nothing. The dedupe key makes the bucket one email.
export const RENEWAL_REMINDER_DAYS = 2;

/* The calendar day an instant falls on, in a given timezone. */
export function localDay(instant, tz) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

/* Whole days from today to the renewal, in the BAKER's timezone.
 * Positive = days to go, 0 = renews today, negative = the moment has passed. */
export function daysUntilRenewal(periodEnd, now = new Date(), tz = config.jobs.renewalReminderTz) {
  const end = localDay(periodEnd, tz);
  const today = localDay(now, tz);
  if (!end || !today) return null;
  // Both parsed as UTC midnight, so the difference is a whole number of days by construction.
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
}

/* Is today a day to send on? The window runs from the milestone down to the renewal day itself. */
export function inRenewalWindow(days) {
  return days != null && days <= RENEWAL_REMINDER_DAYS && days >= 0;
}

/* Has the renewal MOMENT actually still to happen?
 *
 * ⚠️ A DAY COUNT IS NOT ENOUGH AT THE BOUNDARY, and the row that prompted this whole feature is the
 * proof. It ends `2026-09-10T18:30:00Z`. In Asia/Kolkata that is midnight on the 11th — so at 07:00Z
 * on the 11th the calendar count is 0 ("renews today") while the instant passed twelve hours ago and
 * the baker is already staring at "We couldn't renew your subscription".
 *
 * Caught by dry-running the job against real data; the unit tests could not see it because they
 * reason in whole days, which is exactly the abstraction that hides it. A reminder is a warning
 * about something that has NOT happened yet, so the instant is the authority and the day count only
 * decides which of the remaining days to speak on. */
export function renewalStillAhead(periodEnd, now = new Date()) {
  const end = new Date(periodEnd).getTime();
  return Number.isFinite(end) && end > now.getTime();
}

/* Both questions at once, which is how callers should ask: the moment is ahead AND today is a day we
 * speak on. Exported as one function so a caller cannot accidentally check only the cheap half. */
export function shouldRemind(periodEnd, now = new Date(), tz = config.jobs.renewalReminderTz) {
  if (!renewalStillAhead(periodEnd, now)) return false;
  return inRenewalWindow(daysUntilRenewal(periodEnd, now, tz));
}

/* One reminder per baker PER PERIOD — see the header. The period end is the cycle's identity, and
 * it is the value Razorpay moves on every successful charge, so next month's key differs by
 * construction rather than by anything this code has to remember. */
export function renewalDedupeKey(bakerId, periodEnd) {
  return `renewal:${bakerId}:${new Date(periodEnd).toISOString()}`;
}

/* What the email says. Copy lives with the schedule so the two cannot disagree.
 *
 * ⚠️ NO AMOUNT, EVER. The lapsed-access gate makes the same rule and gives the reason: Checkout is
 * the only place that knows the real figure, because it is the only place that has plan + period +
 * GST together. A reminder quoting a number it derived itself is a number that can be wrong, in an
 * email about money. */
export function renewalPayload({ bakerName, planName, periodEnd, days, tz }) {
  return {
    bakerName: bakerName ?? null,
    planName:  planName ?? null,
    renewsOn:  localDay(periodEnd, tz),
    days,
    when: days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`,
  };
}
