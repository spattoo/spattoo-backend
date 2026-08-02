// ── What an accounting event says about a supply ──────────────────────────────────────
// The payload half of billingEvents.js, kept in its own module with NO IMPORTS AT ALL — no
// supabase, no notifications, no config.
//
// Every row this shapes becomes a GST INVOICE, issued by a service in another repo from exactly
// these fields. That makes it the part most worth asserting offline, and the part that must be
// assertable WITHOUT a database, a mail transport or a Redis connection — importing billingEvents.js
// starts all three, and a gate that has to boot the application to check the shape of a JSON object
// is a gate nobody will run.
//
// Same reason decorationPolicy.js is a pure module. See scripts/check-sale-events.mjs.

// ── A credit top-up ───────────────────────────────────────────────────────────────────
// A pack sale is a taxable supply at the moment of ISSUE (AI_CREDITS_PLAN.md §2.4) — the credits
// are handed over when the money lands, and never expire — so it needs an invoice exactly as a
// subscription charge does.
//
// ── WHY THIS IS NOT emitSaleEvent WITH A FLAG ─────────────────────────────────────────
// Half of the subscription payload is subscription vocabulary: plan_id, billing_period_id,
// period_months, a service period. A pack has none of them. Passing nulls through that emitter
// would write a row CLAIMING to describe a plan and describing nothing — and a false line in an
// accounting feed is worse than an absent one, because the absent one is visibly missing while the
// false one gets believed and posted to a customer.
//
// ── SERVICE PERIOD IS NULL, AND THAT IS THE FACT ──────────────────────────────────────
// A subscription charge buys a window of service and the invoice states it. A pack buys credits
// outright: supplied once, never expiring, covering no period. The keys are present and null so a
// consumer can tell "point supply" from "the sender forgot this field".
export function creditPackSalePayload({ payment, pack, chargedAt, recipient }) {
  return {
    // The discriminator, stated in the payload as well as in the event type, so an adapter that
    // dispatches on either one reaches the same conclusion.
    sale_kind:           'credit_pack',
    razorpay_payment_id: payment?.id ?? null,
    razorpay_order_id:   payment?.order_id ?? null,   // a pack is an ORDER; there is no subscription
    // What was sold, named well enough to become an invoice line with no read-back into core. The
    // label is the baker's own words for it, so their invoice matches the button they pressed.
    pack_id:             pack?.id ?? null,
    pack_key:            pack?.pack_key ?? null,
    pack_label:          pack?.label ?? null,
    credits:             pack?.credits ?? null,
    quantity:            1,
    // Gross actually charged, read from the PAYMENT rather than the pack — if a price changed
    // between checkout and capture, the invoice must state what was taken, not what the shelf says
    // today.
    gross_amount_paise:  payment?.amount ?? pack?.price_paise ?? 0,
    currency:            payment?.currency ?? 'INR',
    charged_at:          chargedAt,
    service_period_start: null,
    service_period_end:   null,
    recipient,
  };
}

// Vocabulary belonging to a SUBSCRIPTION charge, which must never appear on a pack sale. Exported
// so the gate asserts against the same list the comment above argues from, rather than a second
// copy that can quietly fall out of date.
export const SUBSCRIPTION_ONLY_FIELDS = [
  'plan_id', 'plan_label', 'billing_period_id', 'period_label', 'period_months', 'subscription_id',
];
