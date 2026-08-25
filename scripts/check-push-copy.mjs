// ── What a push says, and which ones exist at all ───────────────────────────────────────────────
// A push interrupts a baker. Email can afford to tell them everything; forty characters on a lock
// screen cannot, and a notification that says something useful but drops you on the wrong screen
// makes the baker do the finding.
//
// Two properties this defends:
//
//   1. Only types that EARN an interruption push. The list stays short on purpose — the failure mode
//      is silent growth, where somebody adds a push beside a new email because it was one more line.
//   2. Nothing renders "undefined" at a baker. Every field a push reads is optional somewhere.
//
// Run via `npm run check:push-copy` (in `npm run check`).

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

const { buildPush } = await import('../src/jobs/processors/sendNotification.js');
const { linkFor }   = await import('../src/lib/notificationLink.js');

let failed = 0;
const ok  = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };

// ── 1. Which types push ──────────────────────────────────────────────────────────────────────────
// Bakers only, and only the three worth a buzzing pocket: a new enquiry, an accepted quote, and
// what is going out today. Everything else is email.
const PUSHES = ['order_placed_baker', 'quote_accepted_baker', 'delivery_digest_baker'];
const SILENT = [
  'order_placed_customer',      // a customer has no app to be pushed to
  'customer_invite',
  'quote_issued_customer',
  'design_updated_customer',
  'order_ready_customer',
  'order_completed_customer',
];

for (const slug of PUSHES) {
  buildPush(slug, {}) ? ok(`${slug} pushes`) : bad(`${slug} should push and does not`);
}
for (const slug of SILENT) {
  buildPush(slug, {}) === null ? ok(`${slug} is email-only`) : bad(`${slug} pushes and should not`);
}

// ── 1b. Pushes that depend on the PAYLOAD, not the slug ─────────────────────────────────────────
// The trial countdown is one slug at four distances from the deadline and only two of them earn an
// interruption. A slug-level list cannot express that, so the ladder is asserted rung by rung —
// otherwise "trial_ending pushes" would be true and say nothing about which day.
//
// ⚠️ The -1 rung matters most. Interrupting somebody to tell them they have already missed a
// deadline cannot change the outcome and is a poor way to ask for their money.
{
  const at = (days) => buildPush('trial_ending', { days, endDate: '2026-09-01' });
  const LADDER = [
    [7,  false, 'a week out is information, not an interruption'],
    [3,  false, 'still inside the seven-day bucket — no buzz'],
    [2,  true,  'two days out earns a push'],
    [1,  true,  'the day before earns one too'],
    [0,  true,  'the last day earns one'],
    [-1, false, '⚠️ after it has ended, email only — a push cannot change the outcome'],
  ];
  for (const [days, shouldPush, why] of LADDER) {
    const got = at(days) !== null;
    got === shouldPush ? ok(`days=${days}: ${why}`)
                       : bad(`days=${days} ${got ? 'pushes and should not' : 'should push and does not'} — ${why}`);
  }
  // ⚠️ A payload with no `days` must NOT guess. An older row that predates the field is exactly the
  // thing that would buzz a phone at the wrong moment.
  at(undefined) === null ? ok('an unknown distance stays silent rather than guessing')
                         : bad('a payload with no days still pushes');
  buildPush('trial_ended', { days: -1 }) === null
    ? ok('trial_ended never pushes, at any payload')
    : bad('trial_ended pushes and should not');

  // The two rungs are one deadline said twice: the later must REPLACE the earlier on the lock
  // screen, not stack beside it.
  at(2).tag === at(0).tag ? ok('the last-day push replaces the two-day one rather than stacking')
                          : bad('the trial pushes would pile up on the lock screen');
  at(0).url === '/?panel=billing' ? ok('a trial push lands on billing, where the plan is chosen')
                                  : bad(`a trial push lands on "${at(0).url}"`);
  // Forty characters is roughly what a lock screen shows before it truncates.
  LADDER.filter(([, sp]) => sp).every(([d]) => at(d).title.length <= 40)
    ? ok('every trial push title fits a lock screen')
    : bad('a trial push title is too long for a lock screen');
}

// ── 2. Nothing renders undefined ─────────────────────────────────────────────────────────────────
// Every one of these is reachable: an order with no customer row, a digest whose orders array never
// arrived, a payload written before a field existed.
const EMPTY_PAYLOADS = [{}, { orders: [] }, { count: 0 }, { customerName: undefined }];
// The trial push needs a `days` to exist at all, so it is swept separately against the thin
// payloads it can actually receive.
for (const thin of [{ days: 0 }, { days: 2 }, { days: 1, endDate: undefined }, { days: 0, bakerName: undefined }]) {
  const t = buildPush('trial_ending', thin);
  if (/undefined|NaN|\[object/.test(`${t.title} ${t.body}`)) {
    bad(`trial_ending renders "${t.title} ${t.body}" for ${JSON.stringify(thin)}`);
  }
  if (typeof t.url !== 'string' || !t.url) bad(`trial_ending has no url for ${JSON.stringify(thin)}`);
}
for (const slug of PUSHES) {
  for (const payload of EMPTY_PAYLOADS) {
    const p = buildPush(slug, payload);
    const text = `${p.title} ${p.body}`;
    if (/undefined|NaN|\[object/.test(text)) {
      bad(`${slug} renders "${text}" for ${JSON.stringify(payload)}`);
    }
    if (!p.title?.trim()) bad(`${slug} has an empty title for ${JSON.stringify(payload)}`);
    if (typeof p.url !== 'string' || !p.url) bad(`${slug} has no url for ${JSON.stringify(payload)}`);
  }
}
ok('no push renders undefined, NaN or [object Object] on a thin payload');
ok('every push has a title and somewhere to land');

// ── 3. The copy actually says the thing ──────────────────────────────────────────────────────────
{
  const one = buildPush('delivery_digest_baker', {
    count: 1, date: '2026-08-06',
    orders: [{ customerName: 'Rahul Sharma', deliveryTime: '09:30' }],
  });
  one.title === 'One delivery today' ? ok('a single delivery is not called "1 deliveries"') : bad(`title was "${one.title}"`);
  one.body.includes('Rahul Sharma') ? ok('the one-delivery push names the customer') : bad(`body was "${one.body}"`);

  const many = buildPush('delivery_digest_baker', {
    count: 5, date: '2026-08-06',
    orders: [1, 2, 3, 4, 5].map(i => ({ customerName: `Customer ${i}` })),
  });
  many.title === '5 deliveries today' ? ok('the count leads the title, which is what a glance reads') : bad(`title was "${many.title}"`);
  // A lock screen truncates. Naming three and counting the rest beats naming five and showing two.
  many.body.includes('and 2 more') ? ok('a long day is summarised, not truncated mid-name') : bad(`body was "${many.body}"`);

  const enquiry = buildPush('order_placed_baker', { customerName: 'Priya', deliveryDate: '2026-08-12', orderId: 'o1' });
  enquiry.body.includes('Priya') ? ok('a new enquiry names who it is from') : bad(`body was "${enquiry.body}"`);
}

// ── 4. Tags collapse the right things ────────────────────────────────────────────────────────────
// Same tag REPLACES an existing notification. Two enquiries must not eat each other; two digests for
// the same day must.
{
  const a = buildPush('order_placed_baker', { orderId: 'o1' });
  const b = buildPush('order_placed_baker', { orderId: 'o2' });
  a.tag !== b.tag ? ok('two enquiries are two notifications, not one replacing the other') : bad('enquiries share a tag and would collapse');

  const d1 = buildPush('delivery_digest_baker', { date: '2026-08-06' });
  const d2 = buildPush('delivery_digest_baker', { date: '2026-08-06' });
  d1.tag === d2.tag ? ok('a re-sent digest for the same day replaces rather than stacks') : bad('digests for one day would stack');
}

// ── 5. Where a notification goes ─────────────────────────────────────────────────────────────────
// linkFor is shared by the push payload and the notification centre, so a wrong answer here is wrong
// in two places at once — and they would disagree, which reads as an app bug rather than a shared
// constant being wrong.
{
  const order = linkFor('order_placed_baker', { orderId: 'o1' });
  order.includes('order=o1') ? ok('an enquiry opens that order') : bad(`enquiry link was "${order}"`);

  // A payload predating the field, or one an older row never carried. Must degrade to the LIST, not
  // to a link that opens nothing.
  const noId = linkFor('order_placed_baker', {});
  noId === '/?panel=orders' ? ok('an order link with no id falls back to the list') : bad(`was "${noId}"`);

  // The digest is about a DAY. Singling out one of five orders would be picking arbitrarily.
  linkFor('delivery_digest_baker', { count: 5 }) === '/?panel=orders'
    ? ok('the digest opens the list, not an arbitrary order') : bad('digest link is wrong');

  // NEVER null or empty. A notification that cannot be opened teaches a baker the bell is
  // decorative, and that lesson is learned once and kept.
  for (const slug of [...PUSHES, ...SILENT, 'something_unknown']) {
    const l = linkFor(slug, {});
    if (typeof l !== 'string' || !l.startsWith('/')) bad(`${slug} produced a non-path link "${l}"`);
  }
  ok('every type resolves to a path, including ones nobody has defined');

  // Relative, always — the caller knows which host it is addressing. An absolute URL here would
  // make this file environment-aware for no reason, and would send a dev push at prod.
  linkFor('order_placed_baker', { orderId: 'x' }).startsWith('http')
    ? bad('links must be relative paths, not absolute URLs') : ok('links are relative to the app root');

  // The push must USE the shared helper rather than its own string.
  const push = buildPush('order_placed_baker', { orderId: 'o9' });
  push.url === linkFor('order_placed_baker', { orderId: 'o9' })
    ? ok('the push and the bell agree on where a notification goes')
    : bad(`push url "${push.url}" disagrees with linkFor`);
}

if (failed) {
  console.error(`\n✗ check:push-copy — ${failed} failed\n`);
  process.exit(1);
}
console.log('✓ check:push-copy — only the types that earn it, nothing renders undefined, and push agrees with the bell');
