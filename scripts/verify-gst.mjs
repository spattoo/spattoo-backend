// E2E verification of GST Wave-1 (GST_INVOICING_PLAN.md): tax-profile route + status gstin + the
// billing_outbox event seam. Boots the real API in-process against real Supabase + test Razorpay.
// REQUIRES the migration applied first: supabase/gst_invoicing.sql (bakers.gstin + billing_outbox).
//
// Run:  node scripts/verify-gst.mjs
import 'dotenv/config';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { PLAN } from '../src/constants/subscriptionPlans.js';
import { PERIOD } from '../src/constants/billingPeriods.js';
import { SUBSCRIPTION_STATUS } from '../src/constants/subscriptionStatuses.js';

// The relay publishes to a BullMQ queue on Redis. Local dev has no Redis (REDIS_URL=unused), so section
// [5] is skipped there — importing the queue eagerly would just flood ENOTFOUND retries. Verify the relay
// on a host that HAS Redis (Render, or a local redis-server) by setting a real REDIS_URL.
const HAS_REDIS = !!process.env.REDIS_URL && !/^unused$/i.test(process.env.REDIS_URL.trim());

const keyId = process.env.RAZORPAY_KEY_ID || '';
if (!keyId.startsWith('rzp_test_')) { console.error('Need rzp_test_ keys.'); process.exit(1); }

const sb   = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const API = 'http://localhost:3000';
const EMAIL = 'gst-verify@spattoo.local', PASS = 'GstTest1!xyz';
const VALID_GSTIN = '27AAPFU0939F1ZV';   // canonical valid (checksum OK)

let ok = 0, bad = 0;
const check = (l, c, x = '') => { console.log(`  ${c ? '✔' : '✘'} ${l}${x ? ' — ' + x : ''}`); c ? ok++ : bad++; };
let bakerId, authUid, server, token, PAYID, acctQueue;

const authFetch = (path, method, body) => fetch(`${API}${path}`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: body ? JSON.stringify(body) : undefined,
});

try {
  // ── throwaway baker (with Telangana address) + owner ─────────────────────────
  await sb.from('baker_appusers').delete().eq('email', EMAIL);
  const ex = (await sb.auth.admin.listUsers()).data.users.find(u => u.email === EMAIL);
  if (ex) await sb.auth.admin.deleteUser(ex.id).catch(() => {});
  const slug = 'gst-verify-' + Math.abs([...EMAIL].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7));
  await sb.from('bakers').delete().eq('slug', slug);   // reclaim a slug orphaned by a crashed prior run
  const { data: baker, error: bErr } = await sb.from('bakers').insert({
    name: 'GST Verify Co', slug, email: EMAIL, primary_color: '#1a1a1a', accent_color: '#333',
    currency_code: 'INR', timezone: 'Asia/Kolkata', state: 'Telangana', city: 'Hyderabad',
    subscription_plan_id: PLAN.ID_BY_NAME.flame, subscription_status_id: SUBSCRIPTION_STATUS.ACTIVE,
  }).select('id').single();
  if (bErr) throw new Error('baker insert (is gst_invoicing.sql applied?): ' + bErr.message);
  bakerId = baker.id;
  const { data: created } = await sb.auth.admin.createUser({ email: EMAIL, password: PASS, email_confirm: true });
  authUid = created.user.id;
  await sb.from('baker_appusers').insert({ baker_id: bakerId, first_name: 'G', last_name: 'V', email: EMAIL, role: 'owner', is_primary: true, auth_user_id: authUid });
  token = (await anon.auth.signInWithPassword({ email: EMAIL, password: PASS })).data.session.access_token;

  const { default: app } = await import('../src/server.js');
  await new Promise(r => { server = app.listen(3000, r); });

  // ── 1. tax-profile: valid GSTIN saved + surfaced by status ───────────────────
  console.log('\n[1] PATCH /billing/tax-profile — valid GSTIN:');
  let r = await authFetch('/api/billing/tax-profile', 'PATCH', { gstin: VALID_GSTIN.toLowerCase() });
  check('HTTP 200', r.status === 200, `got ${r.status}`);
  let st = await (await authFetch('/api/billing/status', 'GET')).json();
  check('status returns normalized gstin', st.gstin === VALID_GSTIN, st.gstin);

  // ── 2. invalid GSTIN rejected ────────────────────────────────────────────────
  console.log('\n[2] PATCH — invalid GSTIN (bad checksum):');
  r = await authFetch('/api/billing/tax-profile', 'PATCH', { gstin: '27AAPFU0939F1ZX' });
  check('HTTP 400', r.status === 400, `got ${r.status}`);
  check('code invalid_gstin', (await r.json()).code === 'invalid_gstin');
  st = await (await authFetch('/api/billing/status', 'GET')).json();
  check('stored gstin unchanged', st.gstin === VALID_GSTIN, st.gstin);

  // ── 3. clear GSTIN ───────────────────────────────────────────────────────────
  console.log('\n[3] PATCH — clear:');
  r = await authFetch('/api/billing/tax-profile', 'PATCH', { gstin: '' });
  check('HTTP 200', r.status === 200);
  st = await (await authFetch('/api/billing/status', 'GET')).json();
  check('gstin null', st.gstin == null, String(st.gstin));

  // ── 4. event seam: subscription.charged → billing_outbox snapshot ────────────
  console.log('\n[4] Webhook subscription.charged → billing_outbox event:');
  await authFetch('/api/billing/tax-profile', 'PATCH', { gstin: VALID_GSTIN });   // re-set so it lands in the snapshot
  const SUBID = 'sub_gst_verify_' + Date.now().toString(36);
  await sb.from('baker_subscriptions').insert({
    baker_id: bakerId, plan_id: PLAN.ID_BY_NAME.flame, billing_period_id: PERIOD.MONTHLY,
    status_id: SUBSCRIPTION_STATUS.ACTIVE, start_date: new Date().toISOString().slice(0, 10),
    billing_subscription_id: SUBID,
  });
  await sb.from('bakers').update({ billing_subscription_id: SUBID }).eq('id', bakerId);
  PAYID = 'pay_gst_verify_' + Date.now().toString(36);
  await sb.from('billing_outbox').delete().eq('event_id', PAYID);
  const wbody = JSON.stringify({
    event: 'subscription.charged',
    payload: {
      subscription: { entity: { id: SUBID, plan_id: 'plan_x', status: 'active', paid_count: 1, current_start: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) + 30 * 86400 } },
      payment: { entity: { id: PAYID, amount: 118000, currency: 'INR', status: 'captured', created_at: Math.floor(Date.now() / 1000), subscription_id: SUBID } },
    },
  });
  const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(wbody).digest('hex');
  const wres = await fetch(`${API}/api/billing/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body: wbody });
  check('webhook HTTP 200', wres.status === 200, `got ${wres.status}`);
  const { data: ev } = await sb.from('billing_outbox').select('type, payload').eq('event_id', PAYID).maybeSingle();
  check('outbox row created', !!ev);
  check("type = 'sale.charge_captured'", ev?.type === 'sale.charge_captured');
  check('gross_amount_paise = 118000', ev?.payload?.gross_amount_paise === 118000, String(ev?.payload?.gross_amount_paise));
  check('recipient.gstin snapshotted', ev?.payload?.recipient?.gstin === VALID_GSTIN, ev?.payload?.recipient?.gstin);
  check('recipient.state snapshotted', ev?.payload?.recipient?.state === 'Telangana', ev?.payload?.recipient?.state);
  check('plan_id + period in payload', ev?.payload?.plan_id === PLAN.ID_BY_NAME.flame && ev?.payload?.billing_period_id === PERIOD.MONTHLY);
  // Enriched snapshot (Phase 0, 6b) — readable labels + service period so accounting needs zero read-back.
  check('plan_label = flame', ev?.payload?.plan_label === 'flame', ev?.payload?.plan_label);
  check('period_label = monthly', ev?.payload?.period_label === 'monthly', ev?.payload?.period_label);
  check('period_months = 1', ev?.payload?.period_months === 1, String(ev?.payload?.period_months));
  check('service_period_start set', !!ev?.payload?.service_period_start, ev?.payload?.service_period_start);
  check('service_period_end set', !!ev?.payload?.service_period_end, ev?.payload?.service_period_end);

  // ── 5. relay: pending outbox row → published to the accounting queue + marked delivered ──────
  console.log('\n[5] Outbox relay → accounting queue + delivered:');
  if (!HAS_REDIS) {
    console.log('  ⚠ SKIPPED — no Redis locally (REDIS_URL=unused). Run with a real REDIS_URL to verify the relay.');
  } else {
    const { relayBillingOutbox } = await import('../src/jobs/processors/relayBillingOutbox.js');
    ({ accountingQueue: acctQueue } = await import('../src/jobs/queue.js'));
    const { data: pre } = await sb.from('billing_outbox').select('status, delivered_at').eq('event_id', PAYID).maybeSingle();
    check('row pending pre-relay', pre?.status === 'pending', pre?.status);
    check('delivered_at null pre-relay', pre?.delivered_at == null);
    await relayBillingOutbox();
    const { data: post } = await sb.from('billing_outbox').select('status, delivered_at').eq('event_id', PAYID).maybeSingle();
    check('row delivered post-relay', post?.status === 'delivered', post?.status);
    check('delivered_at set post-relay', !!post?.delivered_at, post?.delivered_at);
    const job = await acctQueue.getJob(PAYID);
    check('accounting queue job created (jobId = payment id)', !!job);
    check("queue job type = 'sale.charge_captured'", job?.data?.type === 'sale.charge_captured', job?.data?.type);
    check('queue job payload self-contained (plan_label + gross)',
      job?.data?.payload?.plan_label === 'flame' && job?.data?.payload?.gross_amount_paise === 118000);
  }

} catch (e) {
  console.error('\nFATAL:', e.message);
  bad++;
} finally {
  console.log('\ncleaning up…');
  try { if (acctQueue && PAYID) { const j = await acctQueue.getJob(PAYID); if (j) await j.remove(); } } catch { /* redis/queue may be down */ }
  try { await sb.from('billing_outbox').delete().like('event_id', 'pay_gst_verify_%'); } catch { /* table may not exist pre-migration */ }
  if (bakerId) await sb.from('baker_subscriptions').delete().eq('baker_id', bakerId);
  if (bakerId) await sb.from('baker_appusers').delete().eq('baker_id', bakerId);
  if (bakerId) await sb.from('bakers').delete().eq('id', bakerId);
  if (authUid) await sb.auth.admin.deleteUser(authUid).catch(() => {});
  if (server) server.close();
  console.log(`\n${bad === 0 ? '✔ ALL PASS' : '✘ ' + bad + ' FAILED'} (${ok}/${ok + bad})`);
  process.exit(bad === 0 ? 0 : 1);
}
