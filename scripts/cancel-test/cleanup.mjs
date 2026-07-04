// TEARDOWN — hard-cancel the disposable test subscription (immediate). The disposable plan is
// left in the test account (Razorpay has no plan-delete; it's inert once no sub references it).
// Run:  node scripts/cancel-test/cleanup.mjs
import { razorpay, loadState, subView } from './_shared.mjs';

const rzp = razorpay();
const subId = process.argv[2] || loadState().subId;
try {
  const s = await rzp.subscriptions.cancel(subId, false);   // false = cancel NOW
  console.log('cancelled (immediate):', subView(s));
} catch (e) {
  console.log('cancel note:', e?.error?.description || e.message, '(already-cancelled/completed is fine)');
}
