// Fire a cycle-end subscription.charged webhook for a PARKED (deferred-downgrade) sub, so you can
// witness step-3 promotion NOW instead of waiting a full Razorpay cycle (min 7 days, no test clocks).
//
// Prereq: a fresh downgrade that COMPLETED Checkout — i.e. the parked lower sub is `authenticated`
// and the active (higher) row carries scheduled_subscription_id = <parked sub id>.
//
// Run: RAZORPAY_WEBHOOK_SECRET=<same value as Render> \
//      node scripts/simulate_cycle_end.mjs sub_XXXXXXXX [webhookUrl]
//   (webhookUrl defaults to https://api.spattoo.dev/api/billing/webhook)
//
// The dev server verifies the HMAC signature, then runs the REAL webhook handler (STATUS_MAP →
// active + promotion): the old higher row is superseded, the baker is repointed to the lower plan,
// scheduled_* cleared, and a 'downgraded' history event logged. Test-mode / dev only.
import 'dotenv/config';
import crypto from 'node:crypto';
import Razorpay from 'razorpay';

const parkedId = process.argv[2];
const url = process.argv[3] || 'https://api.spattoo.dev/api/billing/webhook';
const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

if (!parkedId) { console.error('Usage: node scripts/simulate_cycle_end.mjs <parked_sub_id> [webhookUrl]'); process.exit(1); }
if (!secret)   { console.error('Missing RAZORPAY_WEBHOOK_SECRET (add it to .env — same value as the Render env / Razorpay webhook config).'); process.exit(1); }

const rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });

// Pull the real parked sub so the payload's plan_id / notes / period are authentic.
const sub = await rzp.subscriptions.fetch(parkedId);
if (sub.status !== 'authenticated') {
  console.warn(`WARN: parked sub status is '${sub.status}', expected 'authenticated'. Continuing anyway.`);
}
const now = Math.floor(Date.now() / 1000);
const nextEnd = (sub.charge_at || now) + 7 * 86400;   // one more cycle from the (deferred) charge point

// Shape mirrors a real Razorpay subscription.charged event (entity fields the handler reads).
const body = JSON.stringify({
  event: 'subscription.charged',
  payload: {
    subscription: { entity: {
      id: parkedId, plan_id: sub.plan_id, status: 'active',
      current_start: sub.charge_at || now, current_end: nextEnd,
      notes: sub.notes || {}, paid_count: 1,
    } },
    payment: { entity: {
      id: 'pay_SIMCYCLE' + now, amount: 500, currency: 'INR', status: 'captured', created_at: now,
      subscription_id: parkedId,
    } },
  },
});
const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

console.log('POST', url, '\nevent: subscription.charged for', parkedId, '(plan', sub.plan_id + ')');
const res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
  body,
});
console.log('status:', res.status, '| body:', (await res.text()).slice(0, 200));
console.log('\nNow check the billing screen / baker_subscriptions: the old row should be cancelled (6),');
console.log('the lower plan active (1), scheduled_* cleared, and a "downgraded" event logged.');
