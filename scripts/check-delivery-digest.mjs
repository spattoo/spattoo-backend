// ── The morning delivery digest's rules ─────────────────────────────────────────────────────────
// Three things this checks, and each one fails SILENTLY in production if it breaks — the digest
// still sends, it is just wrong, and nobody reports "I got a correct-looking email about the wrong
// day".
//
//   1. "today" is the baker's day, not the server's
//   2. one notification per baker, never one per order
//   3. the dedupe key is per baker per day, which is what makes the job re-runnable
//
// Run via `npm run check:delivery-digest` (in `npm run check`).

// deliveryDigest.js reads config for the default timezone, and config.js throws on missing required
// env at import time. Stub what it insists on — this gate touches nothing but pure functions. Same
// pattern as check-ai-credit-pricing.
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

const { digestDate, groupByBaker, digestPayload, digestDedupeKey } =
  await import('../src/services/deliveryDigest.js');

let failed = 0;
const ok   = (m) => console.log(`  ✓ ${m}`);
const bad  = (m) => { console.error(`  ✗ ${m}`); failed++; };
const is   = (actual, expected, m) =>
  (JSON.stringify(actual) === JSON.stringify(expected) ? ok(m) : bad(`${m}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`));

// ── 1. "today" is the baker's day ────────────────────────────────────────────────────────────────
// The default cron is 01:30 UTC, where UTC and IST agree on the date — so a server-clock version of
// this would look right forever. These cases are the ones where they DISAGREE, which is what a
// retimed cron produces.
{
  // 22:00 UTC on the 4th is already the 5th in India. A digest run then must look at the 5th.
  is(digestDate(new Date('2026-08-04T22:00:00Z'), 'Asia/Kolkata'), '2026-08-05',
     'late-evening UTC is already tomorrow in India');

  // 01:30 UTC — the default schedule. Same date in both zones; the easy case must still hold.
  is(digestDate(new Date('2026-08-05T01:30:00Z'), 'Asia/Kolkata'), '2026-08-05',
     'the default 01:30 UTC tick reads as the same day');

  // 18:20 UTC on the 4th is 23:50 IST — still the 4th, ten minutes before the boundary.
  is(digestDate(new Date('2026-08-04T18:20:00Z'), 'Asia/Kolkata'), '2026-08-04',
     'ten minutes before IST midnight is still today');

  // The format must be exactly what orders.delivery_date stores, or the equality filter silently
  // matches nothing and every baker's digest is "no deliveries".
  const d = digestDate(new Date('2026-08-05T01:30:00Z'), 'Asia/Kolkata');
  /^\d{4}-\d{2}-\d{2}$/.test(d)
    ? ok('the date is YYYY-MM-DD, the shape orders.delivery_date stores')
    : bad(`date shape is ${d}, which will not match delivery_date`);
}

// ── 2. One notification per baker ────────────────────────────────────────────────────────────────
{
  const orders = [
    { id: 'o1', baker_id: 'b1', delivery_time: '14:00' },
    { id: 'o2', baker_id: 'b2', delivery_time: '09:00' },
    { id: 'o3', baker_id: 'b1', delivery_time: '09:30' },
    { id: 'o4', baker_id: 'b1', delivery_time: null },
  ];
  const grouped = groupByBaker(orders);

  is(grouped.size, 2, 'three orders for one baker produce ONE digest, not three');
  is(grouped.get('b1').map(o => o.id), ['o3', 'o1', 'o4'],
     'a baker’s day reads in delivery order, with unscheduled last');

  // An order with no baker cannot be delivered by anyone; it must not create a phantom group.
  is(groupByBaker([{ id: 'x' }]).size, 0, 'an order with no baker is dropped, not grouped under undefined');
  is(groupByBaker([]).size, 0, 'no orders means no digests');
}

// ── 3. The payload says what the subject line needs ──────────────────────────────────────────────
{
  const payload = digestPayload({
    bakerName: 'Feelings',
    date: '2026-08-05',
    orders: [
      { id: 'o1', delivery_time: '09:30', delivery_mode: 'pickup',
        customers: { first_name: 'Rahul', last_name: 'Sharma' }, order_statuses: { key: 'confirmed' } },
      { id: 'o2', delivery_time: null, delivery_mode: null, customers: null, order_statuses: null },
    ],
  });

  is(payload.count, 2, 'count is what decides "an order" vs "3 orders" in the subject');
  is(payload.orders[0].customerName, 'Rahul Sharma', 'the customer is named, which is the whole point of the one-order case');
  // A digest must never render "undefined" at a baker, and an order can legitimately have no
  // customer record attached.
  is(payload.orders[1].customerName, 'A customer', 'a nameless order degrades to a phrase, not to undefined');
  is(payload.orders[1].deliveryTime, null, 'a missing time stays null for the template to render as a dash');
}

// ── 4. The dedupe key ────────────────────────────────────────────────────────────────────────────
// This is what makes the job safe to re-run. Same baker same day must collide; anything else must
// not — a key that collided across bakers would silently send ONE baker's digest and skip the rest.
{
  is(digestDedupeKey('b1', '2026-08-05'), 'delivery_digest:b1:2026-08-05', 'the key names the baker and the day');
  digestDedupeKey('b1', '2026-08-05') === digestDedupeKey('b1', '2026-08-05')
    ? ok('a re-run for the same baker and day collides, so it cannot send twice')
    : bad('the key is not stable across runs');
  digestDedupeKey('b1', '2026-08-05') !== digestDedupeKey('b2', '2026-08-05')
    ? ok('two bakers on the same day do not collide')
    : bad('bakers collide — only one would be notified');
  digestDedupeKey('b1', '2026-08-05') !== digestDedupeKey('b1', '2026-08-06')
    ? ok('the same baker on the next day does not collide')
    : bad('consecutive days collide — the digest would send once and never again');
}

if (failed) {
  console.error(`\n✗ check:delivery-digest — ${failed} failed\n`);
  process.exit(1);
}
console.log('✓ check:delivery-digest — the baker’s day, one digest each, and a key that makes re-runs safe');
