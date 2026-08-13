// Create the Razorpay subscription plans at the GST-INCLUSIVE (gross = base × 1.18) amount, so the
// mandate/charge already includes 18% GST (GST_INVOICING_PLAN.md, Wave 1). DB `subscription_plans`
// prices stay BASE; only the Razorpay plan amount is gross. Prints the RAZORPAY_PLAN_<TIER>_<PERIOD>
// env lines to paste into .env / Render. Pre-production → new subs use these; there are no live
// subscribers on the old (base) plans to migrate. Razorpay plans are immutable, so this CREATES new
// ones (the old plan ids simply go unused).
//
// Run:  node scripts/create-gst-plans.mjs --dry-run          show the amounts, create nothing
//       node scripts/create-gst-plans.mjs                    test keys → test plans
//       node scripts/create-gst-plans.mjs --confirm-live      live keys → LIVE plans
//       node scripts/create-gst-plans.mjs --all-periods        include periods that are switched off
//
// ── WHY LIVE NEEDS A SECOND FLAG ────────────────────────────────────────────────────────────────
// This is irreversible three times over: plans.create is called unconditionally (no upsert, so a
// second run makes a second set), Razorpay plans are IMMUTABLE (a wrong amount cannot be edited,
// only abandoned), and the amount is what a real customer's mandate will charge. --dry-run needs no
// Razorpay credentials at all — the arithmetic is ours, not theirs — so there is no reason to find
// out what the numbers are by creating them.
import 'dotenv/config';
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

const GST_RATE = 0.18;
const DRY_RUN = process.argv.includes('--dry-run');
const CONFIRM_LIVE = process.argv.includes('--confirm-live');
const keyId = process.env.RAZORPAY_KEY_ID || '';

// A dry run needs NO Razorpay credentials — the arithmetic is ours, not theirs. So the amounts can
// always be checked before anything exists, from any machine.
if (!keyId && !DRY_RUN) { console.error('No RAZORPAY_KEY_ID.'); process.exit(1); }

const mode = !keyId ? 'NO KEY (dry run)'
           : keyId.startsWith('rzp_test_') ? 'TEST'
           : keyId.startsWith('rzp_live_') ? 'LIVE' : '???';
console.log('mode:', mode + (DRY_RUN ? '  (DRY RUN — nothing will be created)' : ''));

// ── Live needs a second flag ────────────────────────────────────────────────────────────────────
// Irreversible three times over: plans.create is called unconditionally (no upsert, so a second run
// makes a second SET of plans), Razorpay plans are IMMUTABLE (a wrong amount cannot be edited, only
// abandoned), and the amount is what a real customer's mandate will charge.
if (mode === 'LIVE' && !DRY_RUN && !CONFIRM_LIVE) {
  console.error('\n✖ LIVE keys. Refusing without --confirm-live.\n');
  console.error('  A second run creates a SECOND set of plans, and Razorpay plans are immutable —');
  console.error('  a wrong amount can only be abandoned, never corrected.\n');
  console.error('  Check the numbers first:  node scripts/create-gst-plans.mjs --dry-run\n');
  process.exit(1);
}

const rzp = keyId ? new Razorpay({ key_id: keyId, key_secret: process.env.RAZORPAY_KEY_SECRET }) : null;
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

// ── Why plans and periods are filtered differently ──────────────────────────────────────────────
// PLANS stay active-only, always. An inactive plan is one whose PRICE has not been decided — forge
// today — and a Razorpay plan is immutable, so creating one at a placeholder amount leaves a wrong
// number that can only be abandoned, never corrected.
//
// PERIODS are a billing SHAPE, not a price. Quarterly's amount is fully determined by data that
// already exists (monthly × months × (1 − discount_pct)), so nothing is guessed by creating it while
// it is switched off. Doing so means turning quarterly back on later is a data change — flip
// is_active — instead of a data change PLUS a manual round trip through the Razorpay API for plans
// that must exist before anyone can subscribe.
//
// The asymmetry is deliberate. Do not "tidy" it into one flag.
//
// ⚠️ A plan is a snapshot. If quarterly's discount_pct changes before it is activated, the plan
// created here still charges the old amount — re-create it and update the env var.
const ALL_PERIODS = process.argv.includes('--all-periods');

const { data: plans } = await sb.from('subscription_plans').select('name, price_monthly, price_yearly').eq('is_active', true);
let periodQuery = sb.from('billing_periods').select('name, months, discount_pct, is_active');
if (!ALL_PERIODS) periodQuery = periodQuery.eq('is_active', true);
const { data: periods } = await periodQuery;

const envLines = [];
const rows = [];
for (const plan of plans.filter(p => p.name !== 'spark')) {         // Spark is free — no Razorpay plan
  for (const period of periods) {
    const base = basePaise(plan, period);
    if (!base) continue;
    const gross = Math.round(base * (1 + GST_RATE));
    const key = `RAZORPAY_PLAN_${plan.name.toUpperCase()}_${period.name.toUpperCase()}`;
    if (DRY_RUN) {
      rows.push({ key, plan: plan.name, period: period.name, base, gst: gross - base, gross,
                  rzp: `${RZP_INTERVAL[period.name]}× ${RZP_PERIOD[period.name]}`,
                  inactive: period.is_active === false });
      continue;
    }
    const created = await rzp.plans.create({
      period: RZP_PERIOD[period.name], interval: RZP_INTERVAL[period.name],
      item: { name: `Spattoo ${plan.name} ${period.name} (incl. GST)`, amount: gross, currency: 'INR' },
      notes: { tier: plan.name, billing_period: period.name, base_paise: String(base), gst_inclusive: 'true' },
    });
    console.log(`  ${plan.name}/${period.name}: base ₹${base / 100} → gross ₹${gross / 100} → ${created.id}`);
    envLines.push(`${key}=${created.id}`);
  }
}

if (DRY_RUN) {
  const inr = (p) => ('₹' + (p / 100).toFixed(2)).padStart(11);
  console.log(`\n── would create ${rows.length} plan(s) — GST ${GST_RATE * 100}% on top of the stored base ──\n`);
  console.log('  PLAN    PERIOD         BASE          GST        GROSS   RAZORPAY     ');
  for (const r of rows) {
    console.log(`  ${r.plan.padEnd(7)} ${r.period.padEnd(10)} ${inr(r.base)} ${inr(r.gst)} ${inr(r.gross)}   ${r.rzp.padEnd(12)} ${r.inactive ? '← period is INACTIVE (created ahead of use)' : ''}`);
  }
  console.log(`\n  GROSS is what the customer's mandate charges. BASE is what subscription_plans stores`);
  console.log(`  and what every invoice reconciles against (npm run check:gst).`);
  console.log(`\n  env keys that would be emitted:`);
  for (const r of rows) console.log(`    ${r.key}`);
  console.log(`\n(DRY RUN) Nothing created. Re-run with --confirm-live once the amounts are right.\n`);
} else {
  console.log('\n── Paste into .env / Render (replaces the base-priced plan ids) ──');
  console.log(envLines.join('\n'));
}
