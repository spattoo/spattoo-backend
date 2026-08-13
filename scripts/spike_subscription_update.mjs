// Phase-0 spike (SUBSCRIPTION_CHANGE_PLAN.md): does Razorpay support the plan-change model we want?
// Read-only + DISPOSABLE test subscriptions only — never mutates an existing/active subscription.
// Run: node scripts/spike_subscription_update.mjs   (needs RAZORPAY test keys in .env)
import 'dotenv/config';
import Razorpay from 'razorpay';

const keyId = process.env.RAZORPAY_KEY_ID || '';
if (!keyId) { console.error('No RAZORPAY_KEY_ID in env. Add the TEST keys to spattoo-api/.env first.'); process.exit(1); }
console.log('mode:', keyId.startsWith('rzp_test_') ? 'TEST ✓' : keyId.startsWith('rzp_live_') ? 'LIVE — ABORT' : '???');
if (!keyId.startsWith('rzp_test_')) { console.error('Refusing to run the spike against non-test keys.'); process.exit(1); }

const rzp = new Razorpay({ key_id: keyId, key_secret: process.env.RAZORPAY_KEY_SECRET });
const planEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('RAZORPAY_PLAN_')));
console.log('plan env vars:', Object.keys(planEnv));
const FLAME = process.env.RAZORPAY_PLAN_FLAME_MONTHLY;
const BLAZE = process.env.RAZORPAY_PLAN_BLAZE_MONTHLY;
console.log('FLAME plan:', FLAME, '| BLAZE plan:', BLAZE);

// 1) SDK surface — is there an update/patch method for subscriptions?
const subMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(rzp.subscriptions)).filter(m => m !== 'constructor');
console.log('\n[1] subscriptions SDK methods:', subMethods);
console.log('    has update():', subMethods.includes('update'));

// 2) Read-only shape of the baker's EXISTING active sub (fields we would rely on).
const ACTIVE_ID = process.argv[2] || 'sub_T8yoMAt2IlLgRC';
console.log(`\n[2] fetch active sub ${ACTIVE_ID} (read-only):`);
try {
  const s = await rzp.subscriptions.fetch(ACTIVE_ID);
  console.log('   ', JSON.stringify({ status: s.status, plan_id: s.plan_id, current_start: s.current_start,
    current_end: s.current_end, charge_at: s.charge_at, remaining_count: s.remaining_count,
    has_scheduled_changes: s.has_scheduled_changes, change_scheduled_at: s.change_scheduled_at, paid_count: s.paid_count }));
} catch (e) { console.log('    error:', e?.error?.description || e.message); }

// 3) Disposable sub → attempt plan-change updates to learn CONSTRAINTS (state, schedule_change_at, proration).
console.log('\n[3] create a DISPOSABLE test sub on FLAME and try updates:');
let disposable = null;
try {
  disposable = await rzp.subscriptions.create({ plan_id: FLAME, total_count: 12, quantity: 1, customer_notify: 0 });
  console.log('    created:', disposable.id, 'status:', disposable.status);
  for (const when of ['now', 'cycle_end']) {
    try {
      const upd = await rzp.subscriptions.update(disposable.id, { plan_id: BLAZE, schedule_change_at: when });
      console.log(`    update plan→BLAZE schedule_change_at=${when}: OK →`,
        JSON.stringify({ status: upd.status, plan_id: upd.plan_id, has_scheduled_changes: upd.has_scheduled_changes, change_scheduled_at: upd.change_scheduled_at }));
    } catch (e) {
      console.log(`    update schedule_change_at=${when}: ERROR →`, e?.statusCode, e?.error?.description || e.message);
    }
  }
} catch (e) {
  console.log('    create/update failed:', e?.error?.description || e.message);
} finally {
  if (disposable?.id) {
    try { await rzp.subscriptions.cancel(disposable.id, false); console.log('    cleaned up (cancelled)', disposable.id); }
    catch (e) { console.log('    cleanup note:', e?.error?.description || e.message, '(cancel a', disposable?.status, 'sub may be a no-op)'); }
  }
}

console.log('\nDONE. Key questions answered: SDK update support, sub shape/fields, and whether plan-change +',
  'schedule_change_at is accepted (and on which states). Proration on an ACTIVE sub needs an authenticated',
  'sub — flag if [3] shows update is rejected in `created` state.');
