// ── GST on a price we charge ─────────────────────────────────────────────────────────
// Pure, no imports — see scripts/check-gst.mjs.
//
// Every price we STORE (subscription_plans, credit_packs) is the BASE, exclusive of tax. Every
// amount we CHARGE is base + GST. Those are two different numbers and conflating them is a money
// bug in both directions:
//
//   charge the base            → we collect 18% too little, and the accounting service (which
//                                treats whatever was charged as GROSS and divides tax back out of
//                                it) reports a sale 15.25% smaller than intended. This is exactly
//                                what credit packs did until 2026-08-02: a ₹149 pack charged ₹149,
//                                of which ₹22.73 was then owed as GST.
//   charge base + GST twice    → the customer pays 39.24% over the sticker price.
//
// Core has its own gstBreakup() for DISPLAY (billing/planPricing.js). This is the server side, and
// the server is what Razorpay is told to charge — so this is the one that decides what leaves a
// baker's bank account.

// The rate, in one place. Not read from a table: it is a statutory rate that changes by legislation
// on a known date, not by configuration, and a wrong value here is visible on every invoice. When
// it does change, it changes here and in core's GST_RATE_PCT together.
export const GST_RATE_PCT = 18;

// What to charge for a stored base price, in paise.
//
// Rounds to the nearest paise rather than truncating: Razorpay takes integer paise, and truncating
// would under-collect the tax by up to a paise on every transaction — small, but it is the kind of
// small that a reconciliation cannot explain.
export function withGst(basePaise, ratePct = GST_RATE_PCT) {
  const base = Math.max(0, Math.round(Number(basePaise) || 0));
  return base + Math.round(base * ratePct / 100);
}

// The three numbers a checkout screen needs. Derived from the same function that computes the
// charge, so what a baker is shown and what they are billed cannot drift.
export function gstBreakup(basePaise, ratePct = GST_RATE_PCT) {
  const base  = Math.max(0, Math.round(Number(basePaise) || 0));
  const total = withGst(base, ratePct);
  return { basePaise: base, gstPaise: total - base, totalPaise: total, ratePct };
}
