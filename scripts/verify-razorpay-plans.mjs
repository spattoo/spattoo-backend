#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// verify-razorpay-plans.mjs — do the Razorpay plans charge what we think?
//
// Nothing else checks this. create-gst-plans.mjs computes the amounts and creates
// the plans in one pass, so when IT makes them the two agree by construction —
// but the plans can equally be typed into the dashboard by hand, and then the
// only record of what they *should* charge is arithmetic nobody re-ran.
//
// A Razorpay plan is IMMUTABLE. A wrong amount is not a bug you fix, it is a plan
// you abandon and replace — and every mandate already signed against it keeps
// charging the wrong number. So the window to catch it is before the first
// subscriber, which is now.
//
// Four things go wrong when a human types six money amounts:
//
//   1. The paise. ₹1178 or ₹1179 instead of ₹1178.82. Invoices reconcile base +
//      GST against what was charged (check:gst), so a rounded amount breaks the
//      arithmetic on every invoice, forever.
//   2. The interval. Razorpay models quarterly as period=monthly, interval=3. A
//      dashboard offering "quarterly" as a frequency may mean something else —
//      and a plan that bills 4× a year instead of 4× a year at 3-month intervals
//      is a different product.
//   3. The wrong id in the wrong env var. FLAME_YEARLY holding blaze's id bills
//      ₹29,498 to someone who chose the ₹11,798 plan.
//   4. A plan created in TEST mode while the API runs LIVE keys, or the reverse.
//      Fetching with live keys simply will not find a test plan.
//
// READ-ONLY. Creates nothing, changes nothing.
//
// Usage:
//   RAZORPAY_KEY_ID=… RAZORPAY_KEY_SECRET=… \
//   SUPABASE_URL=… SUPABASE_SERVICE_KEY=… \
//   RAZORPAY_PLAN_FLAME_MONTHLY=plan_… [others…] \
//     node scripts/verify-razorpay-plans.mjs
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

const GST_RATE = 0.18;
const keyId = process.env.RAZORPAY_KEY_ID || '';
if (!keyId) { console.error('✖ No RAZORPAY_KEY_ID.'); process.exit(1); }
const mode = keyId.startsWith('rzp_test_') ? 'TEST' : keyId.startsWith('rzp_live_') ? 'LIVE' : '???';

const rzp = new Razorpay({ key_id: keyId, key_secret: process.env.RAZORPAY_KEY_SECRET });
const sb  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Mirrors create-gst-plans.mjs exactly. If these two ever disagree the whole check is worthless,
// so keep them identical — the duplication is deliberate and small.
function basePaise(plan, period) {
  const monthly = Number(plan.price_monthly) || 0;
  if (period.name === 'monthly') return monthly;
  if (period.name === 'yearly')  return Number(plan.price_yearly) || monthly * 12;
  const discount = (period.discount_pct ?? 0) / 100;
  return Math.round(monthly * (period.months ?? 1) * (1 - discount));
}
const RZP_PERIOD   = { monthly: 'monthly', quarterly: 'monthly', yearly: 'yearly' };
const RZP_INTERVAL = { monthly: 1, quarterly: 3, yearly: 1 };

const inr = (p) => '₹' + (p / 100).toFixed(2);

let failures = 0, checked = 0, missing = 0;
const fail = (m) => { failures++; console.log(`      ✖ ${m}`); };

console.log(`\n▶ verify-razorpay-plans   mode: ${mode}   (read-only)\n`);

// All plans and ALL periods — a period switched off (quarterly) may still have a plan created ahead
// of use, and that plan is exactly as immutable as the others.
const { data: plans }   = await sb.from('subscription_plans').select('name, price_monthly, price_yearly').eq('is_active', true);
const { data: periods } = await sb.from('billing_periods').select('name, months, discount_pct, is_active');

for (const plan of plans.filter(p => p.name !== 'spark')) {
  for (const period of periods) {
    const base = basePaise(plan, period);
    if (!base) continue;

    const expected = Math.round(base * (1 + GST_RATE));
    const key = `RAZORPAY_PLAN_${plan.name.toUpperCase()}_${period.name.toUpperCase()}`;
    const id  = process.env[key];

    const label = `${plan.name}/${period.name}`.padEnd(18);
    if (!id) {
      missing++;
      console.log(`  ${label} — ${key} not set${period.is_active === false ? '  (period inactive)' : ''}`);
      continue;
    }

    checked++;
    let p;
    try {
      p = await rzp.plans.fetch(id);
    } catch (e) {
      fail(`${label} ${id} — fetch failed: ${e?.error?.description || e.message}`);
      console.log(`         a plan created in the OTHER mode is invisible to these keys`);
      continue;
    }

    const amount   = p?.item?.amount;
    const currency = p?.item?.currency;
    const okAmount = amount === expected;
    const okPeriod = p?.period === RZP_PERIOD[period.name];
    const okEvery  = Number(p?.interval) === RZP_INTERVAL[period.name];
    const okCcy    = currency === 'INR';
    const allOk    = okAmount && okPeriod && okEvery && okCcy;

    console.log(`  ${label} ${allOk ? '✔' : '✖'}  ${inr(amount ?? 0)}  ${p?.interval}× ${p?.period}  ${id}`);
    if (!okAmount) fail(`amount is ${inr(amount ?? 0)}, expected ${inr(expected)} (base ${inr(base)} + ${GST_RATE * 100}% GST)`);
    if (!okPeriod || !okEvery) fail(`billing cycle is ${p?.interval}× ${p?.period}, expected ${RZP_INTERVAL[period.name]}× ${RZP_PERIOD[period.name]}`);
    if (!okCcy) fail(`currency is ${currency}, expected INR`);
  }
}

// Two env vars pointing at one plan is the "wrong id in the wrong slot" case, and it survives every
// per-plan check above — each one fetches a real plan whose amount may even be right for the OTHER
// tier. Only comparing them to each other finds it.
const ids = Object.entries(process.env)
  .filter(([k, v]) => k.startsWith('RAZORPAY_PLAN_') && v)
  .map(([k, v]) => [k, v]);
const seen = new Map();
for (const [k, v] of ids) {
  if (seen.has(v)) fail(`${k} and ${seen.get(v)} both point at ${v}`);
  else seen.set(v, k);
}

console.log(`\n  ${checked} checked · ${missing} not set · ${failures} problem(s)`);
if (failures) {
  console.error(`\n✖ A Razorpay plan cannot be edited. A wrong one is replaced, and every mandate`);
  console.error(`  already signed against it keeps charging the old amount.\n`);
  process.exit(1);
}
if (!checked) { console.error(`\n✖ Nothing checked — no RAZORPAY_PLAN_* vars are set.\n`); process.exit(1); }
console.log(`\n✓ every configured plan charges base + ${GST_RATE * 100}% GST on the expected cycle\n`);
