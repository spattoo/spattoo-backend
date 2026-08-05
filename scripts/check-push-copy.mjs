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

// ── 2. Nothing renders undefined ─────────────────────────────────────────────────────────────────
// Every one of these is reachable: an order with no customer row, a digest whose orders array never
// arrived, a payload written before a field existed.
const EMPTY_PAYLOADS = [{}, { orders: [] }, { count: 0 }, { customerName: undefined }];
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

if (failed) {
  console.error(`\n✗ check:push-copy — ${failed} failed\n`);
  process.exit(1);
}
console.log('✓ check:push-copy — only the types that earn it, and nothing renders undefined');
