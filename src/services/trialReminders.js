import { config } from '../config.js';

/* ── When to tell a baker their Spark trial is running out ────────────────────────────────────────
 *
 * The rules only. No database and no email — everything here is arithmetic on a date, so the whole
 * schedule is testable in plain node and the processor is left as plumbing.
 *
 * ── WHERE A TRIAL'S END ACTUALLY LIVES ──────────────────────────────────────────────────────────
 * `baker_subscriptions.end_date`, on the row whose `plan_id` is SPARK. There are two tempting
 * alternatives and both are wrong:
 *
 *   `bakers.trial_ends_at`         — does not exist. (billing.js has it as a DEFAULT PARAMETER, so a
 *                                    caller that ever takes the default gets a 400 on a phantom
 *                                    column. Every current call site passes explicit fields.)
 *   `bakers.subscription_end_date` — exists, and is NULL for every active trial. The trial-creation
 *                                    path writes plan and status onto `bakers` and never the end
 *                                    date. A job reading the mirror finds nothing expiring, ever,
 *                                    and looks like it is working.
 *
 * ⚠️ AND STATUS DOES NOT EXPIRE ITSELF. A Spark row stays `ACTIVE` long after its end_date:
 * reconcileSubscriptions only relabels Razorpay-backed rows (it keys on `current_period_end`, which
 * Spark never has), and expiry is derived at READ time by get_baker_subscription. On dev today one
 * trial ended four weeks ago and is still ACTIVE. So "is this trial live?" is a question about
 * end_date, never about status_id alone.
 */

/* The milestones, in days remaining. The bucket a day falls into is the DEDUPE key, not the copy —
 * what the email actually says comes from the real number of days left, so a run that catches up
 * late tells the truth rather than repeating the milestone's name.
 *
 * -1 is the morning after. It is a different email (nothing is "running out" any more) and it is the
 * highest-intent one: they have just met a locked feature and now know what it was for.
 */
export const MILESTONES = [7, 2, 0, -1];

/* ⚠️ NOT GRACE ON THE TRIAL — this is the last day on which the ENDED email may still go out, and
 * nothing else. It buys the baker no extra access and it is not a countdown they can see. There IS
 * no grace: see get_baker_subscription, where a Spark row is `expired` the moment
 * `end_date < CURRENT_DATE`. The baker keeps the whole of their last day and then it is over.
 *
 * 1 = the morning after expiry, and only that morning.
 *
 * It was briefly 3, to let a late run still deliver the email after a weekend of worker downtime.
 * That trade was rejected deliberately: a "your trial has ended" note arriving three days late reads
 * as an afterthought, and the cost of the stricter rule is one missed marketing email rather than
 * anything a baker depends on.
 *
 * ⚠️ It is still the FLOOR, which is the load-bearing part. Without one, the FIRST RUN of this job
 * emails every long-dead trial in the table — dev has one that ended four weeks ago and is STILL
 * labelled ACTIVE, because a Spark row's status is never relabelled on expiry.
 */
export const ENDED_EMAIL_MAX_DAYS_AFTER = 1;

/* Days between today and the trial's last day, in the BAKER's timezone.
 *
 * Positive = days remaining, 0 = ends today, negative = already over.
 *
 * ⚠️ Both sides are reduced to a calendar date first. Subtracting timestamps gives 6.97 days across a
 * DST change or a late-evening cron, and "expires in 6.97 days" floors to 6 — the 7-day email would
 * skip a baker entirely with nothing to show for it. The bakery's own zone, because "ends today"
 * has to mean today where the baker is; every row on dev is Asia/Kolkata, which is 5.5 hours from
 * the UTC the cron runs in and so gets a different answer for a third of the day.
 */
export function daysLeft(endDate, now = new Date(), tz = config.jobs.trialReminderTz) {
  if (!endDate) return null;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  // Both parsed as UTC midnight, so the difference is a whole number of days by construction.
  const a = Date.parse(`${String(endDate).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

/* Which milestone today falls into, or null for a day that has nothing to say.
 *
 * ⚠️ The SMALLEST milestone still at or above the days remaining — not an equality test. `end_date
 * === today + 7` reads naturally and fails silently: if the worker is down on the one day a baker
 * sits at exactly 7, that email is never sent to them and nothing anywhere records that it was
 * missed. Bucketing means a run at 5 days still lands the first reminder, and says "5 days".
 *
 * Repeats are not this function's problem — the same bucket returns for every day inside it (a
 * baker at 6, 5, 4 and 3 days left is in bucket 7 throughout), and the notification's dedupe key is
 * what makes it one email. That is deliberate: the "have we sent this?" record lives in one place,
 * next to the send, rather than being recomputed here from a second source that could disagree.
 */
export function milestoneFor(days) {
  if (days == null) return null;
  if (days > MILESTONES[0]) return null;                      // more than a week out: nothing to say
  if (days < 0) return days >= -ENDED_EMAIL_MAX_DAYS_AFTER ? -1 : null; // over — recent enough to mention?
  // ⚠️ SORTED ascending before the search. `find` walks array order, and MILESTONES is written
  // most-urgent-last for readability — so an unsorted find returned 7 for every day at or under a
  // week, and the two-day and last-day emails would never have been sent at all.
  return MILESTONES.filter(m => m >= 0).sort((a, b) => a - b).find(m => m >= days) ?? null;
}

// The trial is over; this is the after-email rather than a countdown.
export const isEndedMilestone = (milestone) => milestone === -1;

/* One notification per baker per milestone, forever.
 *
 * ⚠️ Keyed on the MILESTONE and not on the date. Keyed on the date, a job that ran twice on one day
 * would dedupe correctly and a baker sitting in the same bucket for five days would get five
 * identical emails — which is the failure that makes people filter the sender.
 */
export const reminderDedupeKey = (bakerId, milestone) => `trial:${bakerId}:m${milestone}`;

/* What the email says. Copy lives with the schedule because the two cannot be allowed to disagree:
 * the subject promises a number and the number comes from `days`, never from the bucket.
 */
export function reminderPayload({ bakerName, endDate, days, trialDays = null }) {
  const ended = days < 0;
  return {
    bakerName: bakerName ?? null,
    endDate:   String(endDate).slice(0, 10),
    days,
    ended,
    trialDays,
    // Pre-shaped so the template does no arithmetic and no pluralising. "1 days" in a subject line
    // is the kind of thing that gets noticed before the offer does.
    when: ended ? 'has ended'
        : days === 0 ? 'ends today'
        : days === 1 ? 'ends tomorrow'
        : `ends in ${days} days`,
  };
}

/* Is this row worth looking at at all?
 *
 * Deliberately NOT a status check — see the header. A trial is live if today is on or before its
 * last day, and interesting if it is inside the reminder window.
 */
export function inReminderWindow(days) {
  return days != null && days <= MILESTONES[0] && days >= -ENDED_EMAIL_MAX_DAYS_AFTER;
}
