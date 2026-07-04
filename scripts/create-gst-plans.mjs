// Create the Razorpay subscription plans at the GST-INCLUSIVE (gross = base × 1.18) amount, so the
// mandate/charge already includes 18% GST (GST_INVOICING_PLAN.md, Wave 1). DB `subscription_plans`
// prices stay BASE; only the Razorpay plan amount is gross. Prints the RAZORPAY_PLAN_<TIER>_<PERIOD>
// env lines to paste into .env / Render. Pre-production → new subs use these; there are no live
// subscribers on the old (base) plans to migrate. Razorpay plans are immutable, so this CREATES new
// ones (the old plan ids simply go unused).
//
// Run:  node scripts/create-gst-plans.mjs          (test keys → test plans)
import 'dotenv/config';
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

const GST_RATE = 0.18;
const keyId = process.env.RAZORPAY_KEY_ID || '';
if (!keyId) { console.error('No RAZORPAY_KEY_ID.'); process.exit(1); }
console.log('mode:', keyId.startsWith('rzp_test_') ? 'TEST' : keyId.startsWith('rzp_live_') ? 'LIVE' : '???');

const rzp = new Razorpay({ key_id: keyId, key_secret: process.env.RAZORPAY_KEY_SECRET });
const sb  = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Base price (paise) for a plan × period — mirrors core's planPricing.periodPrice (kept in sync by hand;
// the two repos are independent). monthly/yearly are explicit columns; others derive from the monthly rate.
function basePaise(plan, period) {
  const monthly = Number(plan.price_monthly) || 0;
  if (period.name === 'monthly') return monthly;
  if (period.name === 'yearly')  return Number(plan.price_yearly) || monthly * 12;
  const discount = (period.discount_pct ?? 0) / 100;
  return Math.round(monthly * (period.months ?? 1) * (1 - discount));
}

const RZP_PERIOD = { monthly: 'monthly', quarterly: 'monthly', yearly: 'yearly' };   // Razorpay period + interval
const RZP_INTERVAL = { monthly: 1, quarterly: 3, yearly: 1 };

const { data: plans } = await sb.from('subscription_plans').select('name, price_monthly, price_yearly').eq('is_active', true);
const { data: periods } = await sb.from('billing_periods').select('name, months, discount_pct').eq('is_active', true);

const envLines = [];
for (const plan of plans.filter(p => p.name !== 'spark')) {         // Spark is free — no Razorpay plan
  for (const period of periods) {
    const base = basePaise(plan, period);
    if (!base) continue;
    const gross = Math.round(base * (1 + GST_RATE));
    const created = await rzp.plans.create({
      period: RZP_PERIOD[period.name], interval: RZP_INTERVAL[period.name],
      item: { name: `Spattoo ${plan.name} ${period.name} (incl. GST)`, amount: gross, currency: 'INR' },
      notes: { tier: plan.name, billing_period: period.name, base_paise: String(base), gst_inclusive: 'true' },
    });
    const key = `RAZORPAY_PLAN_${plan.name.toUpperCase()}_${period.name.toUpperCase()}`;
    console.log(`  ${plan.name}/${period.name}: base ₹${base / 100} → gross ₹${gross / 100} → ${created.id}`);
    envLines.push(`${key}=${created.id}`);
  }
}

console.log('\n── Paste into .env / Render (replaces the base-priced plan ids) ──');
console.log(envLines.join('\n'));
