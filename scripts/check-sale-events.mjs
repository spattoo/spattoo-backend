#!/usr/bin/env node
// ── the accounting event contract ─────────────────────────────────────────────
// Every row in billing_outbox becomes a GST INVOICE — a legal document, issued by a service in
// another repo, from a payload this one writes. That makes the payload a contract, and it is the
// worst kind to get wrong: nothing here fails, nothing logs, and the mistake surfaces as a wrong
// invoice already sent to a customer, or as money taken with no invoice at all.
//
// Two failures this guards against, both of which have already happened once in some form:
//
//   1. SILENCE. A pack sale emitted nothing for its entire existence — the branch that mints the
//      credits simply had no emitter, so every top-up was money in with no accounting event. The
//      gate below asserts a pack sale produces a payload at all, and one with a gross on it.
//
//   2. A FALSE LINE. The tempting fix was to pass a pack through emitSaleEvent(), whose payload is
//      subscription vocabulary — plan_id, billing_period_id, period_months, a service period. A
//      pack has none of those, and an invoice that names a plan nobody bought is worse than a
//      missing one, because it is believed. The gate asserts those fields are ABSENT rather than
//      null: present-and-null still reads as "a plan we failed to record".
//
// Pure — the payload builders take everything they need as arguments, so this needs no database,
// no network and no clock. Run via `npm run check:sale-events` (or the aggregate `npm run check`).

// No env stubbing and no import graph: saleEventPayloads.js imports NOTHING, deliberately. The
// first version of this gate imported billingEvents.js instead, which starts supabase, the mailer
// and Redis — it printed its result and then hung forever retrying connections to a stub host.
import { creditPackSalePayload, messagePackSalePayload, SUBSCRIPTION_ONLY_FIELDS }
  from '../src/services/saleEventPayloads.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

// A real capture, as Razorpay sends it: amount in paise, no subscription_id (a pack is an ORDER).
const payment = { id: 'pay_TESTpack01', order_id: 'order_TESTpack01', amount: 14900, currency: 'INR' };
const pack    = { id: 2, pack_key: 'topup_150', label: '150 credits', credits: 150, price_paise: 14900 };
const recipient = { baker_id: 'b-1', legal_name: 'Test Bakes', email: 'a@b.c', gstin: null };
const chargedAt = '2026-08-02T06:00:00.000Z';

const p = creditPackSalePayload({ payment, pack, chargedAt, recipient });

// ── 1. It exists, and it carries money ───────────────────────────────────────
ok(p && typeof p === 'object', 'a pack sale builds a payload');
ok(p.gross_amount_paise === 14900, 'gross comes through in paise', `got ${p.gross_amount_paise}`);
ok(p.currency === 'INR', 'currency is stated');
ok(p.charged_at === chargedAt, 'charged_at is the capture time, not now()');
ok(p.recipient === recipient, 'the recipient snapshot is carried verbatim');

// The gross is read from the PAYMENT, never the pack — if a price changed between checkout and
// capture, the invoice must state what was actually taken.
const repriced = creditPackSalePayload({
  payment: { ...payment, amount: 9900 }, pack, chargedAt, recipient,
});
ok(repriced.gross_amount_paise === 9900,
   'gross follows the payment, not the current shelf price', `got ${repriced.gross_amount_paise}`);

// ── 2. It names what was sold, well enough to become an invoice line ─────────
ok(p.pack_key === 'topup_150', 'the pack key identifies the supply');
ok(p.pack_label === '150 credits', 'the label is the baker’s own words for it');
ok(p.credits === 150, 'the quantity of credits is stated');
ok(p.quantity === 1, 'one pack, one line');

// ── 3. It is unmistakably NOT a subscription ─────────────────────────────────
ok(p.sale_kind === 'credit_pack', 'sale_kind discriminates in the payload');
for (const f of SUBSCRIPTION_ONLY_FIELDS) {
  ok(!(f in p), `subscription-only field is absent, not null: ${f}`);
}

// A pack covers no service period, and that is a FACT about the supply rather than a gap. Present
// and null says "point supply"; missing entirely would read as "we forgot to send it".
ok('service_period_start' in p && p.service_period_start === null,
   'service_period_start is present and null (point supply, not a missing field)');
ok('service_period_end' in p && p.service_period_end === null,
   'service_period_end is present and null');

// ── 4. Idempotency handle ────────────────────────────────────────────────────
// event_id is the razorpay payment id (UNIQUE on billing_outbox), so a redelivered webhook cannot
// raise a second invoice. The payload must carry it too, because the accounting system reconciles
// against Razorpay by this id and cannot see our outbox column.
ok(p.razorpay_payment_id === 'pay_TESTpack01', 'the payment id is in the payload');
ok(p.razorpay_order_id === 'order_TESTpack01', 'the order id is carried (a pack is an order)');


// ── 4. A MESSAGE pack, which is the same trap wearing a different unit ───────
//
// ⚠️ ADDED WITH THE FEATURE, NOT AFTER IT. This gate exists because credit-pack sales emitted
// NOTHING for their entire existence — money in, no accounting event, no invoice — and nobody
// noticed because nothing failed. Message packs are a second pack sale on the same rails, so they
// get the same assertions in the same commit rather than waiting for the same discovery.
const msgPayment = { id: 'pay_TESTmsg01', order_id: 'order_TESTmsg01', amount: 11800, currency: 'INR' };
const msgPack    = { id: 2, pack_key: 'msg_225', label: 'Standard', messages: 225, price_paise: 10000 };

const m = messagePackSalePayload({ payment: msgPayment, pack: msgPack, chargedAt, recipient });

ok(m && typeof m === 'object', 'a message pack sale builds a payload');
ok(m.sale_kind === 'message_pack', 'it is discriminated as a message pack', `got ${m.sale_kind}`);
ok(m.gross_amount_paise === 11800, 'gross is the GST-INCLUSIVE amount charged', `got ${m.gross_amount_paise}`);
ok(m.pack_key === 'msg_225', 'the pack key identifies the supply');
ok(m.pack_label === 'Standard', 'the label is the baker\'s own words for it');
ok(m.charged_at === chargedAt, 'charged_at is the capture time');
ok(m.recipient === recipient, 'the recipient snapshot is carried verbatim');

// ⚠️ THE UNIT. "225 credits" on an invoice for a message pack is a support ticket: the baker checks
// their credit balance, finds it unchanged, and concludes they paid for nothing.
ok(m.messages === 225, 'the quantity is stated in MESSAGES', `got ${m.messages}`);
ok(!('credits' in m), 'it does NOT say credits — wrong unit on a legal document');

// The gross follows the payment, for the same reason it does on a credit pack.
const msgRepriced = messagePackSalePayload({
  payment: { ...msgPayment, amount: 5900 }, pack: msgPack, chargedAt, recipient,
});
ok(msgRepriced.gross_amount_paise === 5900,
   'message gross follows the payment, not the current shelf price', `got ${msgRepriced.gross_amount_paise}`);

// ⚠️ Never the BASE as a fallback. message_packs.price_paise is GST-exclusive: passing it would tell
// accounting ₹100 was collected when ₹118 was, understating the sale by the entire tax.
const noAmount = messagePackSalePayload({
  payment: { id: 'p', order_id: 'o' }, pack: msgPack, chargedAt, recipient,
});
ok(noAmount.gross_amount_paise === 0,
   'a payment with no amount reports 0, never the pack base', `got ${noAmount.gross_amount_paise}`);

// And no subscription vocabulary, exactly as for a credit pack.
for (const f of SUBSCRIPTION_ONLY_FIELDS) {
  ok(!(f in m), `a message pack payload has no ${f}`);
}

if (failures) {
  console.error(`\n✗ check:sale-events — ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ check:sale-events — a pack sale emits an invoiceable, non-subscription payload');