// List recent Razorpay subscriptions with status + short_url so we can inspect the hosted page.
// Run: node scripts/inspect_short_urls.mjs
import 'dotenv/config';
import Razorpay from 'razorpay';

const rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });

const { items = [] } = await rzp.subscriptions.all({ count: 25 });
if (!items.length) { console.log('No subscriptions found.'); process.exit(0); }

for (const s of items) {
  console.log(
    [
      s.id.padEnd(20),
      (s.status || '').padEnd(15),
      `plan=${s.plan_id}`.padEnd(24),
      `paid=${s.paid_count ?? 0}`.padEnd(9),
      s.short_url || '(no short_url)',
    ].join('  ')
  );
}
