# GST & Invoicing — plan

How Spattoo charges and (eventually) invoices GST on SaaS subscriptions. Spattoo is the **supplier**
(GST-registered in **Telangana**, state code **36**); the baker is the **recipient**. SaaS = **18% GST**.
One taxable supply = one successful charge (initial + every renewal).

## Guiding boundary
The **core app never contains accounting/GST logic**. Its only responsibility is to (a) charge the correct
GST-inclusive amount and (b) **raise an event** on each successful charge. A separate, independently-deployable
**accounting system** (own UI + datastore, deferred — see below) consumes those events and owns invoicing,
the sales register, and GSTR-1. This keeps the hot billing path unburdened and the two systems releasable on
independent cadences.

## Build sequencing
**V1 scope, built in two waves** (accounting deprioritised, NOT dropped — it must land before go-live):

### Wave 1 — now, in the existing app (this doc's Phase 1)
1. **Gross Razorpay plans** — recreate the 9 tier×period plans at **base × 1.18** (GST-inclusive). DB
   `subscription_plans` prices stay **base**. Pre-production → clean swap, no live-subscriber migration.
2. **Baker GSTIN** — optional `bakers.gstin`, captured/edited on the checkout screen (prefilled), **saved to
   the profile** so automatic renewals reuse it. 15-char format validated (client + server).
3. **Checkout review screen** — before opening Razorpay: **Base + GST (18%) + Total** as a single flat tax
   line (NO CGST/SGST/IGST split in core) + the GSTIN field. Then hand the gross to Razorpay Checkout.
4. **Event seam (placeholder)** — a durable `billing_outbox` row written on `subscription.charged` via one
   `emitSaleEvent()` call. Carries a **snapshot** (recipient legal name/address/state/GSTIN, gross, currency,
   plan/period, payment + subscription ids). **No consumer yet.** Core does zero tax math — the event carries
   raw facts; the accounting system derives base/tax later.

### Wave 2 — before go-live: the accounting system (deferred, still V1)
A separate deployable (e.g. `spattoo-accounting`) with its own DB + UI, consuming the events (via a message
queue for true separation), that owns:
- **Immutable, append-only invoice / sales register** — gap-free invoice numbers (per-FY series, single
  writer), party snapshots, `place_of_supply`, `sac_code`, taxable value, **CGST 9% + SGST 9%** (Telangana
  recipient) / **IGST 18%** (else), total. Corrections only via linked **credit notes**.
- **Place of supply** — prefer the recipient GSTIN's own state code, else the address state.
- **Artifacts** — render the tax-invoice PDF; **email the recipient copy to the baker** (push; no cross-service
  reads from the baker app).
- **Internal UI** — sales register (filter by FY/month/state/baker), CGST/SGST/IGST totals, invoice drill-down,
  **GSTR-1 export** (B2B invoice-level + B2C consolidated). Access = Spattoo accounting/owner only.

### Out of scope
Returns filing (export feeds a CA / Zoho / ClearTax), double-entry ledger, **e-invoicing / IRN** (below the
₹5 Cr turnover threshold — leave schema room for `irn`/`qr` later), TCS/TDS, multi-currency (INR only).

## Why the pricing works with one plan per tier×period
The GST total is **18% regardless of intra- vs inter-state** — only the *split* (CGST+SGST vs IGST) differs,
and that split is an invoice concern, not the amount charged. So one Razorpay plan at `base × 1.18` serves
every Indian baker. Razorpay's subscription Checkout does **not** itemise base+GST — hence our own review screen.

## Event contract (`sale.charge_captured`)
Written to `billing_outbox` (idempotent on `event_id = razorpay_payment_id`). Payload (raw facts, no tax math):
```
{ payment_id, razorpay_payment_id, subscription_id, plan_id, billing_period_id,
  gross_amount_paise, currency, charged_at,
  recipient: { baker_id, legal_name, gstin, address_line1, address_line2, city, state, postal_code, country } }
```
When the accounting system arrives, it drains the outbox (or an MQ replaces it) and derives base = gross ÷ 1.18,
splits by place of supply, and issues the numbered invoice.

## Prerequisites / config
- Supplier profile (GSTIN, legal name, Telangana address, SAC 9983-series @ 18% — confirm exact SAC with CA)
  lives in the **accounting system** (its master data), not core.
- Migration: `bakers.gstin`, `billing_outbox` table.
- Recreate the 9 `RAZORPAY_PLAN_*` at gross.

## Related
- `SUBSCRIPTION_COVERAGE.md` (E5) · `PRICING_AND_QUOTE_PLAN.md` (GST landscape) · `spattoo-docs/features/subscription-billing.md`
