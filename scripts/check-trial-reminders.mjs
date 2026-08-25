// ── The trial reminder schedule ─────────────────────────────────────────────────────────────────
// Every failure this guards against is SILENT in production. The job keeps running, the logs stay
// clean, and the only symptom is an email a baker did not get — or one they should never have got.
//
//   1. days-left is the BAKER's day, not the server's
//   2. a missed run still sends, because milestones are buckets and not equality tests
//   3. the copy comes from the real days left, never from the bucket's name
//   4. the dedupe key is per baker per milestone, which is what stops a five-day bucket
//      sending five identical emails
//   5. ⚠️ a trial that ended weeks ago gets NOTHING — the first run of this job must not
//      email everybody whose trial lapsed months before it existed. (The window this uses is how
//      late the EMAIL may be, not grace on the trial: there is none — see get_baker_subscription.)
//
// Run via `npm run check:trial-reminders` (in `npm run check`).

// config.js throws on missing required env at import time. Stub what it insists on — this gate
// touches nothing but pure functions. Same pattern as check-delivery-digest.
process.env.SUPABASE_URL         ||= 'http://stub';
process.env.SUPABASE_SERVICE_KEY ||= 'stub';
process.env.OPENAI_API_KEY       ||= 'stub';
process.env.REMOVE_BG_API_KEY    ||= 'stub';
process.env.REDIS_URL            ||= 'redis://stub';
process.env.R2_ENDPOINT          ||= 'http://stub';
process.env.R2_ACCESS_KEY_ID     ||= 'stub';
process.env.R2_SECRET_ACCESS_KEY ||= 'stub';
process.env.R2_BUCKET            ||= 'stub';
process.env.R2_PUBLIC_URL        ||= 'http://stub';

const {
  daysLeft, milestoneFor, reminderDedupeKey, reminderPayload, inReminderWindow,
  MILESTONES, ENDED_EMAIL_MAX_DAYS_AFTER, isEndedMilestone,
} = await import('../src/services/trialReminders.js');

let failed = 0;
const ok  = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };
const is  = (actual, expected, m) =>
  (JSON.stringify(actual) === JSON.stringify(expected) ? ok(m) : bad(`${m}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`));

// ── 1. the baker's day, not the server's ────────────────────────────────────────────────────────
// The cron runs in UTC and every bakery on dev is Asia/Kolkata — 5.5 hours apart, so for a third of
// every day the two disagree about what "today" is. These are the cases where they differ.
{
  const IST = 'Asia/Kolkata';
  // 22:00 UTC on the 4th is already the 5th in India. A trial ending on the 5th ends TODAY there,
  // not tomorrow — and "ends tomorrow" on the last morning is simply a lie.
  is(daysLeft('2026-08-05', new Date('2026-08-04T22:00:00Z'), IST), 0,
     'late UTC evening is already the next day in India — ends today');
  is(daysLeft('2026-08-05', new Date('2026-08-04T10:00:00Z'), IST), 1,
     'earlier the same UTC day is still one to go');
  is(daysLeft('2026-08-05', new Date('2026-08-04T22:00:00Z'), 'UTC'), 1,
     'the same instant in UTC gives a different answer — which is why the zone is a parameter');

  // ⚠️ Whole days by construction. Subtracting timestamps gives 6.97 across a DST change or a
  // late-evening run, and 6.97 floors to 6 — the seven-day email skips that baker entirely.
  for (const at of ['2026-08-04T00:00:00Z', '2026-08-04T11:30:00Z', '2026-08-04T18:29:00Z']) {
    const d = daysLeft('2026-08-11', new Date(at), IST);
    Number.isInteger(d) ? ok(`whole days at ${at.slice(11, 16)}Z (${d})`)
                        : bad(`fractional days at ${at}: ${d}`);
  }
  is(daysLeft(null), null, 'a trial with no end date is not a countdown');
  is(daysLeft('nonsense'), null, 'junk is null rather than NaN days');
}

// ── 2. a missed run still sends ─────────────────────────────────────────────────────────────────
// `end_date === today + 7` reads naturally and fails silently: if the worker is down on the one day
// a baker sits at exactly 7, that email is never sent and nothing records the miss.
{
  is(milestoneFor(7), 7, 'exactly seven days out is the first reminder');
  is(milestoneFor(5), 7, 'a run that catches up at five days still sends the first reminder');
  is(milestoneFor(3), 7, 'and at three days — same bucket, so the dedupe key decides');
  is(milestoneFor(2), 2, 'two days out is its own reminder');
  is(milestoneFor(1), 2, 'one day out stays in the two-day bucket — no extra email');
  is(milestoneFor(0), 0, 'the last day is its own reminder');
  is(milestoneFor(8),  null, 'more than a week out has nothing to say');
  is(milestoneFor(30), null, 'a brand new trial is left alone');
  is(milestoneFor(null), null, 'no end date, no milestone');
}

// ── 3. ⚠️ the first run must not email long-dead trials ─────────────────────────────────────────
// A Spark row stays ACTIVE after it expires — reconcileSubscriptions only relabels Razorpay-backed
// rows, and expiry is derived at read time. Dev has trials that ended four weeks ago and are still
// labelled ACTIVE. Without a floor, deploying this job emails every one of them.
{
  is(milestoneFor(-1), -1, 'the morning after gets the ended email');
  is(milestoneFor(-2), null, 'two days after expiry: nothing — the ended email is the morning after, or not at all');
  is(milestoneFor(-(ENDED_EMAIL_MAX_DAYS_AFTER + 1)), null, 'one day past the window: nothing');
  is(milestoneFor(-28), null, '⚠️ a trial that lapsed four weeks ago is NOT emailed on first run');
  isEndedMilestone(-1) && !isEndedMilestone(0)
    ? ok('the ended email is distinguishable from the last-day one')
    : bad('ended and last-day milestones are not distinguishable');

  inReminderWindow(7) && inReminderWindow(-1) && !inReminderWindow(8) && !inReminderWindow(-28)
    ? ok('the query window matches the milestones it feeds')
    : bad('the window and the milestones disagree — rows would be fetched and then dropped, or missed entirely');
}

// ── 4. the copy comes from the days, not the bucket ─────────────────────────────────────────────
// A late run is in the seven-day bucket while three days remain. It must say three.
{
  is(reminderPayload({ bakerName: 'B', endDate: '2026-09-01', days: 3 }).when, 'ends in 3 days',
     'a catch-up run in the 7 bucket still says three days');
  is(reminderPayload({ bakerName: 'B', endDate: '2026-09-01', days: 1 }).when, 'ends tomorrow',
     '⚠️ one day is "tomorrow", never "1 days"');
  is(reminderPayload({ bakerName: 'B', endDate: '2026-09-01', days: 0 }).when, 'ends today',
     'the last day says today');
  is(reminderPayload({ bakerName: 'B', endDate: '2026-09-01', days: -1 }).when, 'has ended',
     'after expiry it is not a countdown any more');
  reminderPayload({ bakerName: 'B', endDate: '2026-09-01', days: -1 }).ended === true
    ? ok('the ended flag lets the template switch without re-deriving it')
    : bad('the ended flag is wrong — the template would have to redo the arithmetic');
  is(reminderPayload({ bakerName: 'B', endDate: '2026-09-01T00:00:00Z', days: 2 }).endDate, '2026-09-01',
     'a timestamp is reduced to a date before it reaches the copy');
}

// ── 5. one email per baker per milestone ────────────────────────────────────────────────────────
// Keyed on the date instead, a baker sitting in the 7-bucket for five days gets five identical
// emails — the failure that makes people filter the sender.
{
  reminderDedupeKey('b1', 7) === reminderDedupeKey('b1', 7)
    ? ok('the same baker and milestone is one key, so a re-run cannot resend')
    : bad('the key is not stable — re-runs would resend');
  new Set(MILESTONES.map(m => reminderDedupeKey('b1', m))).size === MILESTONES.length
    ? ok('every milestone is a distinct key for one baker')
    : bad('two milestones collide — a baker would miss one of their reminders');
  reminderDedupeKey('b1', 7) !== reminderDedupeKey('b2', 7)
    ? ok('two bakers at the same milestone do not collide')
    : bad('bakers collide — only one would be reminded');
}

if (failed) {
  console.error(`\n✗ check:trial-reminders — ${failed} failed\n`);
  process.exit(1);
}
console.log('✓ check:trial-reminders — the baker’s day, buckets that survive a missed run, honest copy, and no mail to long-dead trials');
