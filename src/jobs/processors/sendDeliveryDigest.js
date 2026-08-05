import { supabase } from '../../services/supabase.js';
import { notifyDeliveryDigest } from '../../services/notifications.js';
import { getOrderStatuses } from '../../lib/orderStatuses.js';
import { digestDate, groupByBaker, digestPayload } from '../../services/deliveryDigest.js';

// ── The baker's morning digest: what is going out today ───────────────────────────────────────────
// Runs on a schedule (config.jobs.deliveryDigestCron), not on an event. Nothing happened — the date
// arrived — which makes this the first notification here that has to answer "has this already been
// produced?" for itself. It does not: migration 052's dedupe key answers it, so this job is safe to
// re-run and does not need to know whether it already ran.
//
// The RULES live in services/deliveryDigest.js so they can be tested without a database. This file
// is the plumbing: which orders, which bakers, one notification each.

export async function sendDeliveryDigest() {
  const date = digestDate();

  // ── Which orders count ────────────────────────────────────────────────────────────────────────
  // Due today and NOT in a terminal status. `is_terminal` is data on order_statuses, so a status
  // added later is classified by whoever adds it rather than by a list in here going stale —
  // reminding a baker to deliver an order they have already completed, or one that was cancelled
  // last night, is the fastest way to make the digest untrustworthy.
  const statuses = await getOrderStatuses();
  const liveStatusIds = statuses.filter(s => !s.is_terminal).map(s => s.id);
  if (!liveStatusIds.length) {
    console.warn('[delivery-digest] no non-terminal statuses — nothing can be due; skipping');
    return;
  }

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, baker_id, delivery_date, delivery_time, delivery_mode, customers ( first_name, last_name ), order_statuses ( key )')
    .eq('delivery_date', date)
    .in('status_id', liveStatusIds);
  if (error) throw new Error(`[delivery-digest] order lookup failed: ${error.message}`);

  const byBaker = groupByBaker(orders ?? []);
  if (!byBaker.size) {
    // Not a failure and not worth a notification to anybody. Logged because "the digest ran and
    // there was nothing" and "the digest did not run" look identical from the outside otherwise.
    console.log(`[delivery-digest] ${date}: no deliveries due`);
    return;
  }

  // Names for the greeting, and the recipient resolution needs the row anyway.
  const { data: bakers, error: bakerErr } = await supabase
    .from('bakers')
    .select('id, name, email, is_active')
    .in('id', [...byBaker.keys()]);
  if (bakerErr) throw new Error(`[delivery-digest] baker lookup failed: ${bakerErr.message}`);

  const bakerById = new Map((bakers ?? []).map(b => [b.id, b]));
  let sent = 0, skipped = 0;

  for (const [bakerId, list] of byBaker) {
    const baker = bakerById.get(bakerId);
    // A deactivated bakery still has orders on the books; it should not be getting a cheerful
    // morning reminder about them.
    if (!baker?.is_active) { skipped++; continue; }

    try {
      const produced = await notifyDeliveryDigest({
        baker,
        date,
        payload: digestPayload({ bakerName: baker.name, date, orders: list }),
      });
      produced ? sent++ : skipped++;   // null = the dedupe key caught it; already produced today
    } catch (err) {
      // One baker's failure must not cost every baker after them their digest. The loop continues
      // and the error is logged with the baker it belongs to.
      console.error(`[delivery-digest] ${date} baker ${bakerId} failed:`, err.message);
    }
  }

  console.log(`[delivery-digest] ${date}: ${sent} sent, ${skipped} skipped, ${byBaker.size} bakers with deliveries`);
}
