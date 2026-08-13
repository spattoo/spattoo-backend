#!/usr/bin/env node
// ── what we charge, versus what we store ─────────────────────────────────────
// Every price in the database is a BASE, exclusive of tax. Every amount we hand to Razorpay is
// base + GST. Getting that wrong is a money bug that nothing else catches: the payment succeeds,
// the credits arrive, the baker is happy, and the only symptom is a number.
//
// It has already happened once. Credit packs charged `pack.price_paise` directly, so a ₹149 pack
// collected ₹149 — of which ₹22.73 was then owed as GST, because the accounting service treats
// whatever was charged as GROSS and divides the tax back out of it. Every pack sold netted 15.25%
// less than the sticker price, on a screen that said "prices exclude GST".
//
// Pure — src/lib/gst.js imports nothing. Run via `npm run check:gst` (or `npm run check`).
import { withGst, gstBreakup, GST_RATE_PCT } from '../src/lib/gst.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

ok(GST_RATE_PCT === 18, 'the rate is 18%', String(GST_RATE_PCT));

// ── the real shelf ───────────────────────────────────────────────────────────
// The seeded packs, in paise. If these change, the expectations change with them — the point is
// that the charge is ALWAYS more than the stored price, never equal to it.
for (const [base, total] of [[14900, 17582], [34900, 41182], [79900, 94282]]) {
  ok(withGst(base) === total, `₹${base / 100} charges ₹${total / 100}`, String(withGst(base)));
  ok(withGst(base) > base, `₹${base / 100} is never charged at its base`);
}

// ── the breakup reconciles ───────────────────────────────────────────────────
// A checkout screen showing base + gst that does not add up to the charge is worse than showing
// nothing: it invites a dispute we would lose.
for (const base of [14900, 34900, 79900, 1, 7, 99, 100000]) {
  const b = gstBreakup(base);
  ok(b.basePaise + b.gstPaise === b.totalPaise,
     `breakup reconciles at ₹${base / 100}`, JSON.stringify(b));
  ok(b.totalPaise === withGst(base),
     `the displayed total IS the charged total at ₹${base / 100}`);
}

// ── integer paise ────────────────────────────────────────────────────────────
// Razorpay takes integer paise. A fractional amount is rejected outright, which at least fails
// loudly — but a TRUNCATED one succeeds while under-collecting the tax, and that failure is
// silent and permanent.
for (const base of [1, 3, 7, 33, 149, 999, 12345]) {
  ok(Number.isInteger(withGst(base)), `integer paise at ${base}`, String(withGst(base)));
}
ok(withGst(3) === 4, 'rounds to nearest, not down (3 → 4, not 3)', String(withGst(3)));

// ── degenerate input must not invent money ───────────────────────────────────
ok(withGst(0) === 0, 'zero stays zero');
ok(withGst(null) === 0, 'null is 0, not NaN', String(withGst(null)));
ok(withGst(undefined) === 0, 'undefined is 0, not NaN', String(withGst(undefined)));
ok(withGst(-500) === 0, 'a negative price cannot become a charge', String(withGst(-500)));

if (failures) {
  console.error(`\n✗ check:gst — ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ check:gst — stored prices are bases, charges add GST, and the breakup reconciles');
