// Billing → accounting event seam (GST_INVOICING_PLAN.md, Wave 1).
//
// Core's ONLY tie to the (deferred) accounting system: on each successful charge we raise ONE durable
// event carrying a SELF-CONTAINED snapshot of the supply — party details + amounts as of the charge —
// so the accounting system needs no read-back into core. There is NO consumer yet; the row sits in
// billing_outbox until the accounting system drains it (or a message queue replaces it).
//
// Deliberately GST-agnostic: we emit the GROSS charged + the plan/period + the recipient snapshot, and
// let the accounting system derive base/tax and the CGST-SGST/IGST split. No tax math lives here.
//
// Best-effort + idempotent: event_id = razorpay_payment_id (UNIQUE) dedupes redelivered webhooks; a
// failed insert is logged, not thrown, so it never 500s the webhook (a Wave-2 reconcile sweep will
// backfill any misses once the accounting system exists — nothing consumes the outbox today).
import { supabase } from './supabase.js';
import { bakerNotifyEmail } from './notifications.js';
import { PLAN } from '../constants/subscriptionPlans.js';
import { PERIOD } from '../constants/billingPeriods.js';
import { creditPackSalePayload } from './saleEventPayloads.js';

const toIso = unixSeconds => (unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null);

// The recipient block, identical for every kind of supply — who was billed, frozen as of this
// charge. Addresses and GSTINs change; an invoice must reflect the state at the time of supply, so
// this is a SNAPSHOT and never a reference the accounting system resolves later.
//
// Shared by both emitters below rather than written twice: the two supplies differ in WHAT was
// sold, never in WHO bought it, and a second copy of this block would be one place for the two to
// drift apart on exactly the fields a tax authority reads.
async function recipientSnapshot(baker) {
  return {
    baker_id:      baker?.id ?? null,
    legal_name:    baker?.name ?? null,
    // Resolved the SAME way every other baker email is: prefer bakers.email, else the primary
    // app-user (owner) — bakers.email is optional at onboarding, so the direct baker.email was
    // always null and the invoice copy never sent.
    email:         await bakerNotifyEmail(baker),   // the recipient's invoice copy goes here
    gstin:         baker?.gstin ?? null,
    address_line1: baker?.address_line1 ?? null,
    address_line2: baker?.address_line2 ?? null,
    city:          baker?.city ?? null,
    state:         baker?.state ?? null,
    postal_code:   baker?.postal_code ?? null,
    country:       baker?.country ?? null,
  };
}

// One durable row per supply. event_id = the Razorpay payment id, which is UNIQUE, so a redelivered
// webhook cannot raise a second invoice for one payment.
async function raise(eventId, type, payload) {
  const { error } = await supabase.from('billing_outbox').insert({
    event_id: eventId,                    // idempotency (unique)
    type,
    payload,
  }, { onConflict: 'event_id', ignoreDuplicates: true });
  if (error) console.error('[billing] outbox insert failed:', error.message, '|', type, eventId);
}

export async function emitSaleEvent({ payment, subRow, baker, sub, subscriptionId, chargedAt }) {
  if (!payment?.id) return;
  const payload = {
    razorpay_payment_id: payment.id,
    subscription_id:     subscriptionId ?? null,
    plan_id:             subRow?.plan_id ?? null,
    billing_period_id:   subRow?.billing_period_id ?? null,
    // Readable plan/period labels resolved from core's constants so the accounting system needs ZERO
    // read-back into core to render the invoice line — the snapshot is fully self-contained. Ids alone
    // (above) are opaque to a separate service; these translate them at the boundary.
    plan_label:          PLAN.NAME_BY_ID[subRow?.plan_id] ?? null,
    period_label:        PERIOD.NAME_BY_ID[subRow?.billing_period_id] ?? null,
    period_months:       PERIOD.MONTHS_BY_ID[subRow?.billing_period_id] ?? null,
    gross_amount_paise:  payment.amount ?? 0,
    currency:            payment.currency ?? 'INR',
    charged_at:          chargedAt ?? new Date().toISOString(),
    // The billing cycle this charge covers — the invoice's "service period". Sourced from the Razorpay
    // subscription entity (current_start/current_end, unix seconds), falling back to the stored row.
    service_period_start: toIso(sub?.current_start) ?? subRow?.current_period_start ?? null,
    service_period_end:   toIso(sub?.current_end)   ?? subRow?.current_period_end   ?? null,
    // legal_name = the baker's business name.
    recipient: await recipientSnapshot(baker),
  };

  await raise(payment.id, 'sale.charge_captured', payload);
}

// ── A credit top-up ───────────────────────────────────────────────────────────────────
// A sibling of emitSaleEvent rather than a flag on it: a pack shares the party and the money with a
// subscription charge and NONE of its vocabulary. The payload, and the argument for its shape, live
// in saleEventPayloads.js — pure, so the gate can assert them without booting the app.
export async function emitCreditPackSaleEvent({ payment, baker, pack, chargedAt }) {
  if (!payment?.id) return;
  const payload = creditPackSalePayload({
    payment, pack, recipient: await recipientSnapshot(baker),
    chargedAt: chargedAt ?? new Date().toISOString(),
  });
  await raise(payment.id, 'sale.credit_pack_captured', payload);
}
