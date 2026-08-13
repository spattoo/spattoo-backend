// E2E verification of the B7 interval-switch decision (spattoo-api).
//
// Drives the REAL /billing/subscribe handler in-process against real Supabase + Razorpay TEST keys.
// The route makes its decision and PARKS the new sub BEFORE any Checkout authorization, so the whole
// server-side decision (interval detection, deferred parking, notes.change tag, 409-only-on-true-no-op)
// is verifiable now — without the interactive mandate step or the 7-day cycle.
//
// Local .env has only monthly plan ids, so we mint a DISPOSABLE Razorpay yearly plan and inject it as
// RAZORPAY_PLAN_FLAME_YEARLY (the handler reads process.env at request time). Everything created
// (auth user, baker, subscriptions, Razorpay subs) is torn down in the finally block.
//
// Run:  node scripts/verify-interval-switch.mjs
import 'dotenv/config';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import Razorpay from 'razorpay';
import { PLAN } from '../src/constants/subscriptionPlans.js';
import { PERIOD } from '../src/constants/billingPeriods.js';
import { SUBSCRIPTION_STATUS } from '../src/constants/subscriptionStatuses.js';

const keyId = process.env.RAZORPAY_KEY_ID || '';
if (!keyId.startsWith('rzp_test_')) { console.error('Refusing to run: need rzp_test_ keys.'); process.exit(1); }

const sb  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const rzp = new Razorpay({ key_id: keyId, key_secret: process.env.RAZORPAY_KEY_SECRET });

let ok = 0, bad = 0;
const check = (label, cond, extra = '') => { console.log(`  ${cond ? '✔' : '✘'} ${label}${extra ? ' — ' + extra : ''}`); cond ? ok++ : bad++; };

const EMAIL = 'interval-verify@spattoo.local';
const PASS  = 'IntervalTest1!xyz';
const rzpSubsToKill = [];
let bakerId, authUid, server, token;
const API = 'http://localhost:3000';

async function subscribe(tier, billingPeriodId, intent) {
  const res = await fetch(`${API}/api/billing/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tier, billing_period_id: billingPeriodId, intent }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.subscription_id) rzpSubsToKill.push(body.subscription_id);
  return { status: res.status, body };
}

// Seed the baker's CURRENT active paid row at a given period; clears any parked rows first.
async function setCurrentPeriod(billingPeriodId) {
  await sb.from('baker_subscriptions').delete().eq('baker_id', bakerId);
  const now = new Date();
  const end = new Date(now.getTime() + 20 * 86400000);   // 20 days out → renewal date known
  await sb.from('baker_subscriptions').insert({
    baker_id: bakerId, plan_id: PLAN.ID_BY_NAME.flame, billing_period_id: billingPeriodId,
    status_id: SUBSCRIPTION_STATUS.ACTIVE, start_date: now.toISOString().slice(0, 10),
    current_period_start: now.toISOString(), current_period_end: end.toISOString(),
    billing_subscription_id: 'sub_fake_current_' + billingPeriodId,   // never charged in a deferred flow
  });
  await sb.from('bakers').update({
    subscription_plan_id: PLAN.ID_BY_NAME.flame, subscription_status_id: SUBSCRIPTION_STATUS.ACTIVE,
    billing_subscription_id: 'sub_fake_current_' + billingPeriodId,
  }).eq('id', bakerId);
}

const parkedRow = () => sb.from('baker_subscriptions')
  .select('plan_id, billing_period_id, status_id, billing_subscription_id')
  .eq('baker_id', bakerId).eq('status_id', SUBSCRIPTION_STATUS.PENDING).maybeSingle();

try {
  // ── Mint a disposable Razorpay YEARLY plan (local .env only has monthly) ──────
  const yearlyPlan = await rzp.plans.create({
    period: 'yearly', interval: 1,
    item: { name: 'verify-flame-yearly', amount: 100, currency: 'INR' },
    notes: { purpose: 'interval-switch-verification' },
  });
  process.env.RAZORPAY_PLAN_FLAME_YEARLY = yearlyPlan.id;
  console.log('disposable yearly plan:', yearlyPlan.id);

  // ── Throwaway baker + owner appuser (auth user) ──────────────────────────────
  await sb.from('baker_appusers').delete().eq('email', EMAIL);
  const existing = (await sb.auth.admin.listUsers()).data.users.find(u => u.email === EMAIL);
  if (existing) await sb.auth.admin.deleteUser(existing.id).catch(() => {});

  const slug = 'interval-verify-' + Math.abs([...EMAIL].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7));
  const { data: baker, error: bErr } = await sb.from('bakers').insert({
    name: 'Interval Verify Co', slug, email: EMAIL,
    primary_color: '#1a1a1a', accent_color: '#333333',
    currency_code: 'INR', timezone: 'Asia/Kolkata',
    subscription_plan_id: PLAN.ID_BY_NAME.flame, subscription_status_id: SUBSCRIPTION_STATUS.ACTIVE,
  }).select('id').single();
  if (bErr) throw new Error('baker insert: ' + bErr.message);
  bakerId = baker.id;

  const { data: created } = await sb.auth.admin.createUser({ email: EMAIL, password: PASS, email_confirm: true });
  authUid = created.user.id;
  await sb.from('baker_appusers').insert({
    baker_id: bakerId, first_name: 'Interval', last_name: 'Owner', email: EMAIL,
    role: 'owner', is_primary: true, auth_user_id: authUid,
  });
  const { data: signin } = await anon.auth.signInWithPassword({ email: EMAIL, password: PASS });
  token = signin.session.access_token;

  // ── Boot the real API in-process (routes only, like serve_local) ─────────────
  const { default: app } = await import('../src/server.js');
  await new Promise(r => { server = app.listen(3000, r); });

  // ── Scenario 1: monthly → yearly (interval switch UP) ────────────────────────
  console.log('\n[1] Flame Monthly → Flame Yearly (interval switch):');
  await setCurrentPeriod(PERIOD.MONTHLY);
  let r = await subscribe('flame', PERIOD.YEARLY, 'switch_interval');
  check('HTTP 200', r.status === 200, `got ${r.status} ${JSON.stringify(r.body).slice(0,120)}`);
  check('response scheduled:true (deferred, not immediate)', r.body.scheduled === true);
  let pr = (await parkedRow()).data;
  check('parked PENDING row is FLAME', pr?.plan_id === PLAN.ID_BY_NAME.flame);
  check('parked PENDING row is YEARLY', pr?.billing_period_id === PERIOD.YEARLY);
  if (pr?.billing_subscription_id) {
    const rs = await rzp.subscriptions.fetch(pr.billing_subscription_id).catch(() => null);
    check("Razorpay notes.change = 'interval'", rs?.notes?.change === 'interval', rs?.notes?.change);
  }

  // ── Scenario 2: yearly → monthly (interval switch DOWN) ──────────────────────
  console.log('\n[2] Flame Yearly → Flame Monthly (interval switch):');
  await setCurrentPeriod(PERIOD.YEARLY);
  r = await subscribe('flame', PERIOD.MONTHLY, 'switch_interval');
  check('HTTP 200', r.status === 200, `got ${r.status}`);
  check('response scheduled:true', r.body.scheduled === true);
  pr = (await parkedRow()).data;
  check('parked PENDING row is MONTHLY', pr?.billing_period_id === PERIOD.MONTHLY);
  if (pr?.billing_subscription_id) {
    const rs = await rzp.subscriptions.fetch(pr.billing_subscription_id).catch(() => null);
    check("Razorpay notes.change = 'interval'", rs?.notes?.change === 'interval', rs?.notes?.change);
  }

  // ── Scenario 3: same tier + SAME period = the true no-op → 409 ────────────────
  console.log('\n[3] Flame Monthly → Flame Monthly (true no-op):');
  await setCurrentPeriod(PERIOD.MONTHLY);
  r = await subscribe('flame', PERIOD.MONTHLY);
  check('HTTP 409 (rejected as no-op)', r.status === 409, `got ${r.status}`);
  check('error names tier + period', /flame monthly/i.test(r.body.error || ''), r.body.error);
  check('no PENDING row created', (await parkedRow()).data == null);

  // ── Scenario 4: cross-tier upgrade is NOT mis-detected as interval ────────────
  console.log('\n[4] Flame Monthly → Blaze Monthly (upgrade, must be immediate not scheduled):');
  await setCurrentPeriod(PERIOD.MONTHLY);
  r = await subscribe('blaze', PERIOD.MONTHLY);
  check('HTTP 200', r.status === 200, `got ${r.status}`);
  check('NOT scheduled (immediate upgrade path)', r.body.scheduled !== true);

  // ── Scenario 5: webhook step 2 — the parked interval mandate authorizes ───────
  // Fire a signed subscription.authenticated with notes.change='interval' for a parked YEARLY sub, and
  // assert the ACTIVE row is ARMED (scheduled_subscription_id + cancel_at_period_end, reason null) and
  // an 'interval_changed' event is logged. (Mechanically the payment_method path; this proves the
  // interval-specific bits: null reason + the distinct event.)
  console.log('\n[5] Webhook subscription.authenticated (change=interval) → arm + log:');
  await setCurrentPeriod(PERIOD.MONTHLY);
  const OLD_SUB = 'sub_fake_current_' + PERIOD.MONTHLY;   // the active row's billing_subscription_id
  const PARKED  = 'sub_fake_parked_interval';
  await sb.from('baker_subscriptions').insert({
    baker_id: bakerId, plan_id: PLAN.ID_BY_NAME.flame, billing_period_id: PERIOD.YEARLY,
    status_id: SUBSCRIPTION_STATUS.PENDING, start_date: new Date().toISOString().slice(0, 10),
    billing_subscription_id: PARKED,
  });
  await sb.from('subscription_events').delete().eq('baker_id', bakerId);   // clean slate for the assert
  const wbody = JSON.stringify({
    event: 'subscription.authenticated',
    payload: { subscription: { entity: {
      id: PARKED, plan_id: 'plan_x', status: 'authenticated', notes: { change: 'interval', baker_id: bakerId },
    } } },
  });
  const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(wbody).digest('hex');
  const wres = await fetch(`${API}/api/billing/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body: wbody,
  });
  check('webhook HTTP 200', wres.status === 200, `got ${wres.status}`);
  const { data: armed } = await sb.from('baker_subscriptions')
    .select('scheduled_subscription_id, scheduled_plan_id, cancel_at_period_end, cancellation_reason_id')
    .eq('billing_subscription_id', OLD_SUB).maybeSingle();
  check('active row armed with parked sub id', armed?.scheduled_subscription_id === PARKED);
  check('scheduled_plan_id = same tier (flame)', armed?.scheduled_plan_id === PLAN.ID_BY_NAME.flame);
  check('cancel_at_period_end = true', armed?.cancel_at_period_end === true);
  check('cancellation_reason_id = null (supersession, not a downgrade)', armed?.cancellation_reason_id == null);
  const { data: evs } = await sb.from('subscription_events').select('event').eq('baker_id', bakerId);
  check("'interval_changed' event logged", (evs || []).some(e => e.event === 'interval_changed'),
    JSON.stringify((evs || []).map(e => e.event)));

} catch (err) {
  console.error('\nFATAL:', err.message);
  bad++;
} finally {
  console.log('\ncleaning up…');
  for (const id of rzpSubsToKill) await rzp.subscriptions.cancel(id, false).catch(() => {});
  if (bakerId) await sb.from('baker_subscriptions').delete().eq('baker_id', bakerId);
  if (bakerId) await sb.from('baker_appusers').delete().eq('baker_id', bakerId);
  if (bakerId) await sb.from('bakers').delete().eq('id', bakerId);
  if (authUid) await sb.auth.admin.deleteUser(authUid).catch(() => {});
  if (server) server.close();
  console.log(`\n${bad === 0 ? '✔ ALL PASS' : '✘ ' + bad + ' FAILED'} (${ok}/${ok + bad})`);
  process.exit(bad === 0 ? 0 : 1);
}
