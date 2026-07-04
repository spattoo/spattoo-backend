// STEP 3 — issue the SCHEDULED cancel (cancel_at_cycle_end = true) on the authorized sub.
// This is the exact call our code wraps as razorpayCancelSubscription(id, /*atCycleEnd*/ true).
// It dumps the IMMEDIATE post-cancel API view — does status stay `active`? do charge_at/end_at
// stay armed (the prior "no-op on UPI" finding), or clear? The API view is only HALF the answer;
// the ground truth is whether charge #2 actually fires at the boundary → keep running observe.mjs.
//
// Run:  node scripts/cancel-test/3-cancel.mjs
import { razorpay, loadState, saveState, subView } from './_shared.mjs';

const rzp = razorpay();
const subId = process.argv[2] || loadState().subId;

const before = await rzp.subscriptions.fetch(subId);
console.log('BEFORE cancel:', subView(before));
if (before.status !== 'active') {
  console.warn(`\n⚠ status is "${before.status}", not "active". Authorize (step 2) and wait for the`);
  console.warn('  first charge (observe.mjs → status=active, paid_count=1) BEFORE scheduling the cancel,');
  console.warn('  else there is no renewal to test. Aborting.');
  process.exit(1);
}

// The lever under test: cancel_at_cycle_end = true (2nd arg true).
const after = await rzp.subscriptions.cancel(subId, true);
console.log('\nAFTER cancel(id, cancel_at_cycle_end=true):', subView(after));

saveState({
  cancelledAt: new Date().toISOString(),
  paidCountAtCancel: before.paid_count,
  boundary: after.current_end ? new Date(after.current_end * 1000).toISOString() : null,
});

console.log('\nInterpretation:');
console.log('  • status now "cancelled" + charge_at cleared → scheduled cancel took effect at API level.');
console.log('  • status still "active" + charge_at/end_at armed → prior finding (looks like a no-op).');
console.log(`\nGROUND TRUTH: watch paid_count (now ${before.paid_count}) across the boundary`);
console.log(`  (${after.current_end ? new Date(after.current_end * 1000).toISOString() : 'unknown'}).`);
console.log('  Run `node scripts/cancel-test/observe.mjs` before & after it. paid_count++ ⇒ it RE-CHARGED (no-op).');
