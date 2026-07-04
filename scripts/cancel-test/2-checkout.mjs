// STEP 2 — serve a one-page Razorpay Checkout to AUTHORIZE the subscription's UPI mandate.
// A subscription in `created` state never charges; it must be authenticated by the customer.
// In TEST mode, pick UPI and use VPA `success@razorpay` to authorize instantly.
//
// Run:  node scripts/cancel-test/2-checkout.mjs   → open http://localhost:4999
// After it says "Authorized", run: node scripts/cancel-test/observe.mjs  (wait for status=active).
import { createServer } from 'node:http';
import { loadState, KEY_ID } from './_shared.mjs';

const { subId } = loadState();
const keyId = KEY_ID();
const PORT = 4999;

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Cancel-test Checkout</title>
<style>body{font-family:system-ui;padding:40px;max-width:640px;margin:auto;color:#1a1a1a}
code{background:#f3f3f3;padding:2px 6px;border-radius:4px}#out{margin-top:20px;white-space:pre-wrap;font-size:13px;color:#2C4433}</style>
</head><body>
<h2>Scheduled-cancel test — authorize mandate</h2>
<p>Subscription: <code>${subId}</code></p>
<p>Pick <b>UPI</b> → VPA <code>success@razorpay</code> to authorize in test mode.</p>
<button id="pay" style="padding:12px 24px;font-size:15px;cursor:pointer">Open Checkout</button>
<div id="out"></div>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<script>
document.getElementById('pay').onclick = function () {
  const rzp = new Razorpay({
    key: ${JSON.stringify(keyId)},
    subscription_id: ${JSON.stringify(subId)},
    name: 'Spattoo Cancel-Test',
    handler: function (r) { document.getElementById('out').textContent = 'Authorized ✓\\n' + JSON.stringify(r, null, 2); },
    modal: { ondismiss: function () { document.getElementById('out').textContent = 'dismissed (not authorized)'; } },
  });
  rzp.open();
};
</script></body></html>`;

createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(page);
}).listen(PORT, () => {
  console.log(`Checkout page for ${subId} → http://localhost:${PORT}`);
  console.log('Authorize with UPI VPA success@razorpay, then Ctrl-C and run observe.mjs.');
});
