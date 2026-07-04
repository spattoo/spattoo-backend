// OBSERVE — snapshot the subscription's lifecycle + its invoices/payments, print a diff vs the
// last snapshot, and append to observe-log.jsonl. Run this repeatedly (by hand, or via a loop)
// BEFORE and AFTER the cycle boundary. The decisive signal is paid_count / invoice count: if a
// new PAID invoice appears after a scheduled cancel, the cancel was a no-op on this rail.
//
// Run:  node scripts/cancel-test/observe.mjs
// Loop: watch -n 3600 'node scripts/cancel-test/observe.mjs'   (hourly)
import { razorpay, loadState, appendLog, subView, ts, LOG_PATH } from './_shared.mjs';
import { readFileSync, existsSync } from 'node:fs';

const rzp = razorpay();
const subId = process.argv[2] || loadState().subId;

const sub = await rzp.subscriptions.fetch(subId);
const view = subView(sub);

// Each cycle charge produces an invoice. Count paid ones = ground-truth charge count.
let invoices = [];
try {
  const res = await rzp.invoices.all({ subscription_id: subId, count: 100 });
  invoices = res.items || [];
} catch (e) { console.log('invoice list error:', e?.error?.description || e.message); }
const paidInvoices = invoices.filter(i => i.status === 'paid');

const snap = {
  at: new Date().toISOString(),
  ...view,
  invoices_total: invoices.length,
  invoices_paid:  paidInvoices.length,
  invoice_states: invoices.map(i => i.status),
};

// Diff vs the previous logged snapshot so a change across the boundary is obvious.
let prev = null;
if (existsSync(LOG_PATH)) {
  const lines = readFileSync(LOG_PATH, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length) prev = JSON.parse(lines[lines.length - 1]);
}

console.log(snap);
if (prev) {
  const changed = Object.keys(snap).filter(k => k !== 'at' && JSON.stringify(prev[k]) !== JSON.stringify(snap[k]));
  if (changed.length) {
    console.log('\nCHANGED since', prev.at + ':');
    for (const k of changed) console.log(`  ${k}: ${JSON.stringify(prev[k])} → ${JSON.stringify(snap[k])}`);
    if (snap.paid_count > prev.paid_count || snap.invoices_paid > prev.invoices_paid) {
      console.log('\n>>> A NEW CHARGE FIRED. If this is after a scheduled cancel, the cancel was a NO-OP on this rail.');
    }
  } else {
    console.log('\n(no change since last snapshot)');
  }
}

appendLog(snap);
