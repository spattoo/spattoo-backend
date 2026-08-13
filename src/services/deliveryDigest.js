import { config } from '../config.js';

// ── What "today" means, and what goes in the digest ───────────────────────────────────────────────
// The rules the morning digest is made of, kept OUT of the job so they can be tested without a
// database, a clock or a queue. The job fetches and sends; this decides.

/**
 * Today's date in the digest's timezone, as `YYYY-MM-DD` — the shape `orders.delivery_date` stores.
 *
 * The server runs in UTC and the bakers do not. At the default 01:30 UTC the two happen to agree,
 * which is exactly what makes this dangerous: `new Date().toISOString().slice(0,10)` would look
 * correct forever and then quietly return YESTERDAY the first time somebody retimed the cron an hour
 * earlier. Nothing would fail — bakers would simply be reminded about deliveries they had already
 * made.
 *
 * `en-CA` because its short date format IS `YYYY-MM-DD`; formatting to parts and reassembling costs
 * more code to reach the same string.
 */
export function digestDate(now = new Date(), tz = config.jobs.deliveryDigestTz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/**
 * Group today's orders by baker, newest delivery slot first within each.
 *
 * ONE notification per baker, never one per order. A baker with four deliveries wants to be told
 * that once, over breakfast — four separate alerts at 07:00 is how a useful reminder becomes a thing
 * people silence. The count is what changes the copy ("an order" vs "3 orders"), so the grouping IS
 * the feature rather than an optimisation of it.
 */
export function groupByBaker(orders = []) {
  const byBaker = new Map();
  for (const o of orders) {
    if (!o?.baker_id) continue;
    if (!byBaker.has(o.baker_id)) byBaker.set(o.baker_id, []);
    byBaker.get(o.baker_id).push(o);
  }
  // Sorted by delivery time so the digest reads in the order the day happens. Orders with no time
  // set sort last: an unscheduled delivery is not an early one, and putting it first would push a
  // 9am collection down the list.
  for (const list of byBaker.values()) {
    list.sort((a, b) => (a.delivery_time ?? '99:99').localeCompare(b.delivery_time ?? '99:99'));
  }
  return byBaker;
}

/**
 * The payload one baker's digest carries.
 *
 * Deliberately self-contained — names and times, not ids. A notification is read long after it was
 * produced, and one that has to look things up to render is one that renders differently (or fails)
 * once an order is edited. The same reason `order_placed_baker` snapshots its order.
 */
export function digestPayload({ bakerName, date, orders }) {
  return {
    bakerName,
    date,
    count: orders.length,
    orders: orders.map(o => ({
      orderId:       o.id,
      customerName:  [o.customers?.first_name, o.customers?.last_name].filter(Boolean).join(' ').trim() || 'A customer',
      deliveryTime:  o.delivery_time ?? null,
      deliveryMode:  o.delivery_mode ?? null,
      status:        o.order_statuses?.key ?? null,
    })),
  };
}

/**
 * The key that makes the job safely re-runnable: one digest per baker per day, whatever happens to
 * the worker. See migration 052 for why this is a database constraint and not a check in the job.
 */
export const digestDedupeKey = (bakerId, date) => `delivery_digest:${bakerId}:${date}`;
