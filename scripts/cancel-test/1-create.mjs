// STEP 1 — create a DISPOSABLE test plan + subscription at the shortest cycle Razorpay allows.
// Razorpay's minimum subscription interval is 7 DAYS (daily is rejected), so the floor is WEEKLY —
// the renewal charge lands ~1 week out instead of a month.
// Razorpay has NO test clocks (see simulate_cycle_end.mjs) — the renewal charge that answers the
// scheduled-cancel question can only be observed on real wall-clock, so we minimise the cycle.
//
// Run:  node scripts/cancel-test/1-create.mjs
// Then: node scripts/cancel-test/2-checkout.mjs   (authorize the UPI mandate in test Checkout)
import { razorpay, saveState, subView, ts } from './_shared.mjs';

const rzp = razorpay();

// total_count high so NATURAL completion never confounds the test — the only thing that should
// stop charge #2 is our scheduled cancel (step 3). amount is a token ₹1 (100 paise), test mode.
const TOTAL = 5;
const AMOUNT = 100;

// Try the shortest period first; fall back if Razorpay rejects it for subscriptions.
async function createPlan() {
  for (const period of ['daily', 'weekly']) {
    try {
      const plan = await rzp.plans.create({
        period, interval: 1,
        item: { name: `Cancel-test ${period}`, amount: AMOUNT, currency: 'INR' },
        notes: { purpose: 'scheduled-cancel-validation' },
      });
      console.log(`plan created: ${plan.id}  (period=${period}, ₹${AMOUNT / 100})`);
      return { plan, period };
    } catch (e) {
      console.log(`  period=${period} rejected:`, e?.error?.description || e.message);
    }
  }
  throw new Error('Could not create a plan at daily or weekly.');
}

const { plan, period } = await createPlan();

// No start_at → first cycle begins as soon as the mandate is authorized.
const sub = await rzp.subscriptions.create({
  plan_id: plan.id, total_count: TOTAL, quantity: 1, customer_notify: 1,
  notes: { purpose: 'scheduled-cancel-validation' },
});

saveState({
  planId: plan.id, subId: sub.id, period, amount: AMOUNT,
  createdAt: new Date().toISOString(),
});

console.log('\nsubscription created:', sub.id);
console.log('state:', subView(sub));
console.log('short_url (mandate authorization):', sub.short_url || '(none — use step 2 Checkout)');
console.log('\nNEXT → node scripts/cancel-test/2-checkout.mjs  then authorize with test UPI (success@razorpay).');
