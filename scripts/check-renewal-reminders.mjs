// ── The paid-plan renewal reminder schedule ─────────────────────────────────────────────────────
// Every failure this guards against is SILENT in production: the job runs, the logs are clean, and
// the only symptom is an email a baker did not get.
//
//   1. the renewal DAY comes from the instant in the BAKER's zone, not from slicing the UTC string
//      — `current_period_end` lands in the evening UTC, which is already tomorrow in India
//   2. a missed run still sends, because the window is a bucket and not an equality test
//   3. the dedupe key carries the PERIOD, so the same baker is reminded again next cycle — the one
//      way this differs from the trial countdown, and the one that would fail invisibly
//   4. nothing is sent after the renewal instant has passed: by then the charge has either happened
//      or it has not, and both are a different message
//
// Run via `npm run check:renewal-reminders` (in `npm run check`).

// config.js throws on missing required env at import time. Stub what it insists on — this gate
// touches nothing but pure functions. Same list as check-trial-reminders.
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
  localDay, daysUntilRenewal, inRenewalWindow, renewalStillAhead, shouldRemind,
  renewalDedupeKey, renewalPayload, RENEWAL_REMINDER_DAYS,
} = await import('../src/services/renewalReminders.js');

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) return;
  failures++;
  console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
};

// ── 1 · the baker's day, not the server's ───────────────────────────────────────────────────────
// The row that prompted this feature: period ends 2026-09-10T18:30:00Z, which is 2026-09-11 00:00
// in Asia/Kolkata. A UTC-string slice calls that the 10th and every countdown is a day out.
const PERIOD_END = '2026-09-10T18:30:00+00:00';
check('the renewal day is read in the baker IST, not UTC',
  localDay(PERIOD_END, 'Asia/Kolkata') === '2026-09-11',
  `got ${localDay(PERIOD_END, 'Asia/Kolkata')}, and String(x).slice(0,10) would say ${String(PERIOD_END).slice(0, 10)}`);

// Two days before, from a morning cron in IST.
check('two days out reads as 2',
  daysUntilRenewal(PERIOD_END, new Date('2026-09-09T02:15:00Z'), 'Asia/Kolkata') === 2,
  `got ${daysUntilRenewal(PERIOD_END, new Date('2026-09-09T02:15:00Z'), 'Asia/Kolkata')}`);

// ⚠️ The evening-UTC trap, from the other side: at 20:00 UTC on the 8th it is already the 9th in
// India, so the answer must be 2 and not 3.
check('the count is taken in the bakery zone even late in the UTC day',
  daysUntilRenewal(PERIOD_END, new Date('2026-09-08T20:00:00Z'), 'Asia/Kolkata') === 2,
  `got ${daysUntilRenewal(PERIOD_END, new Date('2026-09-08T20:00:00Z'), 'Asia/Kolkata')}`);

// ── 2 · a bucket, not an equality test ──────────────────────────────────────────────────────────
check('the window is a bucket, so a run at 1 day still sends',  inRenewalWindow(1));
check('and a run on the day itself still sends',                inRenewalWindow(0));
check('the milestone day sends',                                inRenewalWindow(RENEWAL_REMINDER_DAYS));
check('further out says nothing',                              !inRenewalWindow(RENEWAL_REMINDER_DAYS + 1));

// ── 3 · nothing after the moment has passed ─────────────────────────────────────────────────────
check('a renewal already past is NOT reminded about', !inRenewalWindow(-1),
  'after the instant the charge has either happened or failed — both are a different email');

// ── 3b · THE BOUNDARY, which a day count alone gets wrong ───────────────────────────────────────
// The row that prompted the whole feature: ends 2026-09-10T18:30:00Z, which in IST is midnight on
// the 11th. At 07:00Z on the 11th the DAY count says 0 — "renews today" — while the instant passed
// twelve hours earlier and the baker is already looking at "We couldn't renew your subscription".
// Found by dry-running the job against real data; these day-level tests could not see it.
const AFTER = new Date('2026-09-11T07:00:00Z');
check('the day count alone says "today" after the moment has passed',
  inRenewalWindow(daysUntilRenewal(PERIOD_END, AFTER, 'Asia/Kolkata')),
  'if this ever stops being true the trap below has moved, not gone');
check('renewalStillAhead sees that it has NOT still to happen',
  !renewalStillAhead(PERIOD_END, AFTER));
check('so shouldRemind refuses — no "renews today" to a locked-out baker',
  !shouldRemind(PERIOD_END, AFTER, 'Asia/Kolkata'));
check('and it still sends while the moment is genuinely ahead',
  shouldRemind(PERIOD_END, new Date('2026-09-09T02:15:00Z'), 'Asia/Kolkata'));
check('including on the renewal day itself, before the hour',
  shouldRemind(PERIOD_END, new Date('2026-09-10T06:00:00Z'), 'Asia/Kolkata'),
  'IST calls this the 10th → days 1; the instant is still ahead, so it is a legitimate send');

// ── 4 · the dedupe key carries the PERIOD ───────────────────────────────────────────────────────
// The single most important difference from the trial countdown. Keyed on a milestone, a baker gets
// one reminder in their life and none for the next twenty-three months.
const B = 'baker-1';
check('the same cycle dedupes to one email',
  renewalDedupeKey(B, PERIOD_END) === renewalDedupeKey(B, '2026-09-10T18:30:00.000Z'));
check('NEXT cycle gets its own reminder',
  renewalDedupeKey(B, PERIOD_END) !== renewalDedupeKey(B, '2026-10-10T18:30:00+00:00'),
  'a milestone-shaped key would silently stop reminding after the first month');
check('two bakers never share a key',
  renewalDedupeKey(B, PERIOD_END) !== renewalDedupeKey('baker-2', PERIOD_END));

// ── 5 · the copy is built from the real day, and quotes no money ────────────────────────────────
const pay = renewalPayload({ bakerName: 'F&F', planName: 'blaze', periodEnd: PERIOD_END, days: 2, tz: 'Asia/Kolkata' });
check('the payload names the baker day', pay.renewsOn === '2026-09-11', `got ${pay.renewsOn}`);
check('the phrasing comes from the real days left', pay.when === 'in 2 days', `got "${pay.when}"`);
check('renews tomorrow reads naturally',
  renewalPayload({ periodEnd: PERIOD_END, days: 1, tz: 'Asia/Kolkata' }).when === 'tomorrow');
check('renews today reads naturally',
  renewalPayload({ periodEnd: PERIOD_END, days: 0, tz: 'Asia/Kolkata' }).when === 'today');
check('no amount rides in the payload',
  !Object.keys(pay).some(k => /amount|price|total|rupee|inr/i.test(k)),
  `keys: ${Object.keys(pay).join(', ')} — Checkout is the only place that knows the real figure`);

if (failures) {
  console.error(`\n✗ check:renewal-reminders — ${failures} failed`);
  process.exit(1);
}
console.log('✓ check:renewal-reminders — baker-zone day, bucketed window, per-CYCLE dedupe, no amounts');
