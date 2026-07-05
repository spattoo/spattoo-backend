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
import { PLAN } from '../constants/subscriptionPlans.js';
import { PERIOD } from '../constants/billingPeriods.js';

const toIso = unixSeconds => (unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null);

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
    // Recipient snapshot — frozen at charge time (addresses/GSTIN change; the invoice must reflect the
    // state as of this supply). legal_name = the baker's business name.
    recipient: {
      baker_id:      baker?.id ?? null,
      legal_name:    baker?.name ?? null,
      email:         baker?.email ?? null,   // recipient copy of the invoice is emailed here (accounting side)
      gstin:         baker?.gstin ?? null,
      address_line1: baker?.address_line1 ?? null,
      address_line2: baker?.address_line2 ?? null,
      city:          baker?.city ?? null,
      state:         baker?.state ?? null,
      postal_code:   baker?.postal_code ?? null,
      country:       baker?.country ?? null,
    },
  };

  const { error } = await supabase.from('billing_outbox').insert({
    event_id: payment.id,                 // idempotency (unique)
    type:     'sale.charge_captured',
    payload,
  }, { onConflict: 'event_id', ignoreDuplicates: true });
  if (error) console.error('[billing] emitSaleEvent outbox insert failed:', error.message, '| payment', payment.id);
}
