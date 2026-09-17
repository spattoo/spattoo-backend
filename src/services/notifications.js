import { supabase } from './supabase.js';
import { jobQueue } from '../jobs/queue.js';
import { digestDedupeKey } from './deliveryDigest.js';
import { reminderDedupeKey, isEndedMilestone } from './trialReminders.js';
import { renewalDedupeKey } from './renewalReminders.js';
import { titleCase, rupees, dateLabel, calendarDate, clockTime, customerOrderLink } from '../lib/notificationFormat.js';
import { config } from '../config.js';

async function getTypeId(slug) {
  const { data } = await supabase
    .from('notification_types')
    .select('id')
    .eq('slug', slug)
    .single();
  return data?.id;
}

// Transactional outbox: the row is the durable record; we DISPATCH it immediately
// (push to the queue) instead of waiting for the sweeper poll — so the worker fetches
// it by id and sends with no per-notification status scan in the hot path. If the
// enqueue fails (e.g. Redis down) the row stays 'pending' and the sweeper backstop
// retries. We flip to 'enqueued' only while still 'pending', so a worker that already
// advanced the row (sent/failed) is never clobbered.
async function insertNotification(typeSlug, recipientEmail, payload, { dedupeKey = null, bakerId = null } = {}) {
  // Ready-to-show copies of the raw fields, for SMS and WhatsApp templates, added HERE for every type
  // so no notify function can forget them (withTemplateFields; the builders are further down).
  payload = withTemplateFields(typeSlug, payload);
  const typeId = await getTypeId(typeSlug);
  if (!typeId) throw new Error(`Unknown notification type: ${typeSlug}`);

  const { data: row, error } = await supabase
    .from('notifications')
    .insert({ type_id: typeId, recipient_email: recipientEmail, payload, dedupe_key: dedupeKey, baker_id: bakerId })
    .select('id')
    .single();

  // A dedupe collision is the guard WORKING, not a failure: this notification was already produced
  // (a retried job, a redeploy mid-tick), so the right outcome is to do nothing quietly. Only
  // possible when the caller supplied a key — event-triggered notifications pass none and so can
  // never take this path. 23505 = unique_violation.
  if (error?.code === '23505' && dedupeKey) return null;
  if (error) throw new Error(`Failed to insert notification: ${error.message}`);

  try {
    await jobQueue.add('send_notification', { notificationId: row.id }, {
      attempts: 1, removeOnComplete: true, removeOnFail: true,
    });
    await supabase
      .from('notifications')
      .update({ status: 'enqueued', attempts: 1 })
      .eq('id', row.id)
      .eq('status', 'pending');
  } catch (err) {
    console.error('[notifications] immediate enqueue failed, leaving for sweeper backstop:', err.message);
  }
  return row.id;
}

// The baker's notification email. `bakers.email` is OPTIONAL at onboarding, so don't
// rely on it alone — fall back to the primary app-user (owner), whose email is always
// set. Without this, baker order/quote-accepted emails silently never send. Exported so
// the billing→accounting event (billingEvents.js) snapshots the SAME resolved email onto
// the invoice recipient, instead of duplicating the primary-appuser lookup.
export async function bakerNotifyEmail(baker) {
  if (baker?.email) return baker.email;
  if (!baker?.id) return null;
  const { data } = await supabase
    .from('baker_appusers')
    .select('email')
    .eq('baker_id', baker.id)
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.email ?? null;
}

/* ── Is there any way to reach this customer? ────────────────────────────────────────────────────
 *
 * ⚠️ THIS USED TO BE `if (!customer?.email) return`, in five places, and it was not skipping EMAIL —
 * it was skipping the NOTIFICATION. No row, so no bell, no SMS, no WhatsApp, and nothing recorded to
 * say anything had been withheld. Customer email is optional, and `POST /orders/manual` (a baker
 * typing in a walk-in) takes phone OR email, so a customer with only a phone is the normal shape
 * there — and every phone channel we have built for them sat behind an email column none of them use.
 *
 * A phone alone is enough now. `recipient_email` is nullable from 097 and means the email delivery
 * address; the SMS and WhatsApp channels find their own contact from the payload's `orderId`
 * (`customerContact`, services/notificationChannels.js), never from this column.
 *
 * ⚠️ Still a guard, not a formality. With NEITHER there is genuinely nowhere to send, and inserting
 * would queue a row every channel must skip in turn — noise in the outbox that looks like breakage.
 */
const reachable = (customer) => !!(customer?.email || customer?.phone);

export async function notifyOrderPlaced({ order, baker, customer, authoredBy = 'customer' }) {
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  const payload = {
    customerName,
    customerFirstName: customer.first_name,
    customerEmail:     customer.email,
    customerPhone:     customer.phone,
    bakerName:         baker.name,
    deliveryDate:      order.delivery_date,
    deliveryTime:      order.delivery_time,
    deliveryMode:      order.delivery_mode,
    deliveryAddress:   order.delivery_address,
    weightKg:          order.weight_kg,
    flavours:          order.flavours,
    specialInstructions: order.special_instructions,
    thumbnailUrl:      order.design_thumbnail_url ?? null,
    // Who put this order in. The customer's email thanks them for designing it only when they did —
    // a baker designing for a customer must not be thanked on their behalf. Defaults to 'customer'
    // so an older caller that does not pass it keeps the wording it has always had.
    authoredBy,
  };
  const jobs = [];

  const bakerEmail = await bakerNotifyEmail(baker);
  if (bakerEmail) {
    jobs.push(insertNotification('order_placed_baker', bakerEmail, payload, { bakerId: baker.id }));
  }
  /* ⚠️ MISSED BY THE FIRST PASS AT THIS BUG, and worth saying why. The five early returns fixed with
     migration 097 were spelled `if (!customer?.email) return` — a grep for that shape walks straight
     past this one, which is the same mistake written inside-out. A customer who gave a phone and no
     email got no "we have your order" at all. Same fix, same reason. */
  if (reachable(customer)) {
    jobs.push(insertNotification('order_placed_customer', customer.email ?? null, payload));
  }

  await Promise.all(jobs);
}

// Baker edited the design while it's still open (shared-pen window). Email the
// customer that there are recommendations / an update to review. `mode` tunes the
// copy: 'recommendations' (initiated) vs 'updated' (quoted, i.e. after a quote).
export async function notifyDesignUpdated({ order, baker, customer, mode = 'updated' }) {
  if (!reachable(customer)) return;
  await insertNotification('design_updated_customer', customer.email ?? null, {
    customerFirstName: customer.first_name,
    bakerName:         baker.name,
    bakerSlug:         baker.slug ?? null,
    orderId:           order.id,
    mode,                                   // 'recommendations' | 'updated'
    thumbnailUrl:      order.design_thumbnail_url ?? null,
  });
}

// Baker issued a quote. Email the customer the price + advance + the baker's note,
// with a link to review/approve it.
export async function notifyQuoteIssued({ order, baker, customer }) {
  if (!reachable(customer)) return;
  await insertNotification('quote_issued_customer', customer.email ?? null, {
    customerFirstName: customer.first_name,
    bakerName:         baker.name,
    bakerSlug:         baker.slug ?? null,
    orderId:           order.id,
    quotedPrice:       order.quoted_price ?? null,
    quoteValidUntil:   order.quote_valid_until ?? null,
    advanceAmount:     order.advance_amount ?? null,
    quoteNote:         order.quote_note ?? null,
  });
}

// Customer approved the quote (design + price agreed). Email the baker so they can
// collect the advance and confirm.
export async function notifyQuoteAccepted({ order, baker, customer }) {
  const bakerEmail = await bakerNotifyEmail(baker);
  if (!bakerEmail) return;
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  await insertNotification('quote_accepted_baker', bakerEmail, {
    customerName,
    orderId:    order.id,
    finalPrice: order.final_price ?? order.quoted_price ?? null,
  }, { bakerId: baker.id });
}

// Customer asked a question on the quote ("Talk to {baker}"). Email the baker the note.
export async function notifyQuoteQuestion({ order, baker, customer, message }) {
  const bakerEmail = await bakerNotifyEmail(baker);
  if (!bakerEmail) return;
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ');
  await insertNotification('quote_question_baker', bakerEmail, {
    customerName,
    orderId: order.id,
    message,
  }, { bakerId: baker.id });
}

// Baker invited a customer to a design session. Sends the private storefront link (OTP gates
// access). Async via the outbox — the invite route no longer sends inline.
//
// ⚠️ The only customer notification with no `orderId`, so `customerContact` cannot look the phone up
// and the invite has to CARRY it. That is what `customerPhone` is for, and why the reachability test
// here is spelled out rather than calling `reachable()`: the contact arrives loose, not as a
// customer row.
export async function notifyCustomerInvited({ to, bakerName, firstName, link, brandColor, logoUrl, note, expiresAt, customerPhone = null }) {
  if (!to && !customerPhone) return;
  await insertNotification('customer_invite', to ?? null, {
    bakerName, firstName, link, brandColor, logoUrl, note, expiresAt,
    customerPhone,   // an invite has no order to look the customer up by
  });
}

// Baker confirmed the order (advance received). Email the customer.
export async function notifyOrderConfirmed({ order, baker, customer }) {
  if (!reachable(customer)) return;
  await insertNotification('order_confirmed_customer', customer.email ?? null, {
    customerFirstName: customer.first_name,
    bakerName:         baker.name,
    bakerSlug:         baker.slug ?? null,
    orderId:           order.id,
    finalPrice:        order.final_price ?? null,
    thumbnailUrl:      order.design_thumbnail_url ?? null,
  });
}

// Baker marked the order ready (for pickup / delivery). Tell the customer.
export async function notifyOrderReady({ order, baker, customer }) {
  if (!reachable(customer)) return;
  await insertNotification('order_ready_customer', customer.email ?? null, {
    customerFirstName: customer.first_name,
    bakerName:         baker.name,
    bakerSlug:         baker.slug ?? null,
    orderId:           order.id,
    deliveryMode:      order.delivery_mode ?? null,
    deliveryDate:      order.delivery_date ?? null,
    deliveryTime:      order.delivery_time ?? null,
    thumbnailUrl:      order.design_thumbnail_url ?? null,
    photoUrls:         order.photoUrls ?? [],   // optional finished-cake photos (≤3), rendered inline
  });
}

// Baker marked the order complete (delivered / picked up). Thank the customer and
// close the loop.
export async function notifyOrderCompleted({ order, baker, customer }) {
  if (!reachable(customer)) return;
  await insertNotification('order_completed_customer', customer.email ?? null, {
    customerFirstName: customer.first_name,
    bakerName:         baker.name,
    bakerSlug:         baker.slug ?? null,
    orderId:           order.id,
    thumbnailUrl:      order.design_thumbnail_url ?? null,
  });
}

// ── Subscription lifecycle (baker-facing) ────────────────────────────────────
// Notify the BAKER about their OWN Spattoo subscription. Fired from the billing webhook
// (routes/billing.js) on Razorpay events, gated to the baker's CURRENT subscription. Recipient
// uses the same bakers.email → primary-owner fallback as the order emails. `timeZone` rides along
// so the template formats dates in the baker's zone (not UTC). One internal helper; thin per-event
// exports (DRY). `baker` = { id, name, email, timezone }.
async function notifySubscription(typeSlug, baker, payload = {}) {
  const email = await bakerNotifyEmail(baker);
  if (!email) return;
  const timeZone = baker?.timezone ?? null;
  await insertNotification(typeSlug, email, {
    bakerName: baker?.name ?? null,
    timeZone,
    ...payload,
  });
}

/* Ready-to-show copies of the raw fields, for SMS and WhatsApp templates. An email formats these
   itself, but a template gap prints a field exactly as stored — "blaze", "2026-10-15T10:00:00.000Z",
   149900 — so without these the baker would read the raw values.

   Added only for fields the event actually carries, so admin's field list for a type does not offer a
   date that type never has. A present-but-empty raw field gives a null copy: the channel is then
   skipped with the reason recorded, rather than sending a dash. */
function readableSubscriptionFields(payload, timeZone) {
  const out = {};
  if ('planName' in payload)      out.planLabel       = payload.planName ? titleCase(payload.planName) : null;
  if ('nextBillingAt' in payload) out.nextBillingDate = dateLabel(payload.nextBillingAt, timeZone);
  if ('accessUntil' in payload)   out.accessUntilDate = dateLabel(payload.accessUntil, timeZone);
  if ('amount' in payload)        out.amountLabel     = payload.amount != null ? rupees(payload.amount) : null;
  return out;
}

// The types that go through notifySubscription — the exports just below this block.
export const SUBSCRIPTION_NOTIFICATION_TYPES = new Set([
  'subscription_activated', 'subscription_renewed', 'payment_failed', 'subscription_cancelled', 'subscription_expired',
]);

/* The ready-to-show field NAMES a notification of this type gets, given a payload of it.
 *
 * ⚠️ For admin's field list. That list is read off a type's most recent notification, and one sent
 * before these fields existed does not carry them — so admin could not pick `planLabel` and its save
 * check refused it as unknown, leaving only the raw `planName`. Derived from the same function that
 * adds them, so the two cannot drift. */
export function addedTemplateFields(typeSlug, payload) {
  const build = TEMPLATE_FIELD_BUILDERS[typeSlug];
  return build ? Object.keys(build(payload ?? {}, null)) : [];
}

/* Ready-to-show copies of an order's details, for SMS and WhatsApp templates.
 *
 * ⚠️ NEVER NULL, unlike the subscription copies. An order may have no date, no size and no flavour
 * yet — the storefront allows it — and a template gap with no value skips the whole message. A new
 * quote request is the one notification a baker must not miss, so an unknown detail is written as
 * unknown ("No date given") instead of silencing the WhatsApp. */
function readableOrderFields(p) {
  const date = calendarDate(p.deliveryDate);
  const time = clockTime(p.deliveryTime);
  // The same reading of a flavour as the email's order table (sendNotification.js orderDetailsHtml).
  const flavourNames = (Array.isArray(p.flavours) ? p.flavours : [])
    .map(f => (typeof f === 'string' ? f : (f?.name ?? f?.flavour)))
    .filter(Boolean);
  return {
    deliveryWhen:    date ? (time ? `${date}, ${time}` : date) : 'No date given',
    fulfilmentLabel: p.deliveryMode === 'home_delivery' ? 'Home delivery' : 'Pickup',
    weightLabel:     p.weightKg ? `${p.weightKg} kg` : 'Not given',
    flavoursLabel:   flavourNames.length ? flavourNames.join(', ') : 'Not chosen',
  };
}

// Which types carry ready-to-show fields, and the function that makes them.
/* A price as SMS can carry it: "Rs. 1,499". No ₹, which would turn the whole SMS into 70-character
   Unicode. Order prices are stored in RUPEES (numeric(10,2)), so no paise maths, and "1499.00" and 1499
   read the same.
 *
 * ⚠️ "Rs. " IS INSIDE THE VALUE, AND THAT IS THE POINT — the template used to write it and hold a bare
 * number. DLT tags are typed and exclusive: `{#number#}` takes digits only, `{#alphanumeric#}` REJECTS a
 * value that is all digits. A price is sometimes one and sometimes the other — "999" is digits, "1,499"
 * has a comma, "1,499.5" has both — so a bare price fails whichever tag the template uses. Prefixed, it
 * always carries letters, so `{#alphanumeric#}` is always right.
 *
 * ⚠️ Rounding to plain digits was the other way out and is worse: the price field is inputMode="decimal"
 * (OrdersPanel), so 1499.50 is reachable, and a quote SMS stating a price the baker did not quote is not
 * a formatting detail. The separator and the paise both survive this way. */
const priceRs = v => {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n)
    ? `Rs. ${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
    : null;
};

/* The storefront link, as a template VARIABLE.
 *
 * ⚠️ WHY IT HAS TO BE A STORED FIELD. The email builds this URL itself, at send time, from
 * `bakerSlug`. A WhatsApp template cannot: its text is approved at Meta and filled positionally from
 * `config.params`, which names PAYLOAD FIELDS. There is no expression to evaluate, so a link that is
 * not a field is a link a WhatsApp template can never say.
 *
 * Null when there is no slug — `validateChannel` lets admin map a variable to it either way, and the
 * sender skips a template whose variable came back empty rather than sending a message with a hole.
 */
function readableCustomerLink(p) {
  return {
    orderLink:      customerOrderLink(p, config.storefront.urlTemplate),
    storefrontLink: customerOrderLink(p, config.storefront.urlTemplate, { deep: false }),
  };
}

function readableQuoteFields(p) {
  const out = {};
  if ('quotedPrice' in p) out.quotedPriceRs = priceRs(p.quotedPrice);
  if ('finalPrice' in p)  out.finalPriceRs  = priceRs(p.finalPrice);
  return out;
}

function readableDigestFields(p) {
  const n = Number(p.count) || 0;
  return { deliveriesLabel: n === 1 ? '1 order' : `${n} orders` };
}

function readableCreditsFields(p, timeZone) {
  return 'resetsOn' in p ? { resetsOnDate: dateLabel(p.resetsOn, timeZone) } : {};
}

function readableErasureFields(p, timeZone) {
  return 'eraseAfter' in p ? { eraseDate: dateLabel(p.eraseAfter, timeZone) } : {};
}

const TEMPLATE_FIELD_BUILDERS = {
  ...Object.fromEntries([...SUBSCRIPTION_NOTIFICATION_TYPES].map(t => [t, readableSubscriptionFields])),
  order_placed_baker:       readableOrderFields,
  order_placed_customer:    readableOrderFields,
  quote_accepted_baker:     readableQuoteFields,
  /* Customer-facing: the quote copies PLUS the link, because these are the ones a WhatsApp template
     sends someone to. `design_updated`, `order_ready` and `order_completed` have no price to make
     readable and take the link alone. */
  quote_issued_customer:    p => ({ ...readableQuoteFields(p), ...readableCustomerLink(p) }),
  order_confirmed_customer: p => ({ ...readableQuoteFields(p), ...readableCustomerLink(p) }),
  design_updated_customer:  readableCustomerLink,
  order_ready_customer:     p => ({ ...readableOrderFields(p), ...readableCustomerLink(p) }),
  order_completed_customer: readableCustomerLink,
  delivery_digest_baker:    readableDigestFields,
  credits_low:              readableCreditsFields,
  credits_exhausted:        readableCreditsFields,
  account_erasure_notice:   readableErasureFields,
};

/* A payload as a template sees it: the stored fields plus the ready-to-show copies, in the baker's time
   zone. For admin's "Send test", which fills a template from a notification that may have been sent
   before those copies existed. */
export function withTemplateFields(typeSlug, payload) {
  const p = payload ?? {};
  const build = TEMPLATE_FIELD_BUILDERS[typeSlug];
  return build ? { ...p, ...build(p, p.timeZone ?? null) } : p;
}

// Welcome a NEW baker after their bakery is created (post-confirmation onboarding kit). Recipient
// is the owner's email (bakers.email is optional at creation). Fired from createBakerForUser.
export async function notifyBakerWelcome({ email, firstName, bakerName, slug }) {
  if (!email) return;
  await insertNotification('baker_welcome', email, {
    firstName: firstName ?? null,
    bakerName: bakerName ?? null,
    slug:      slug      ?? null,   // template builds the storefront URL from this
  });
}

// The DPDP Rule-8 pre-erasure notice: tell the baker their account data will be erased in ~48h and
// that logging in / restoring cancels it. Fired by the erasure sweep (eraseExpiredAccounts.js).
// `baker` = { id, name, email, timezone }; `eraseAfter` = ISO instant.
export async function notifyAccountErasureScheduled(baker, { eraseAfter }) {
  const email = await bakerNotifyEmail(baker);
  if (!email) return;
  await insertNotification('account_erasure_notice', email, {
    bakerName:  baker?.name ?? null,
    timeZone:   baker?.timezone ?? null,
    eraseAfter: eraseAfter ?? null,
  });
}

// ── A credit top-up receipt ──────────────────────────────────────────────────
// The one thing a baker keeps after buying credits. Not a sibling of notifySubscription() despite
// looking like one: that helper is about a PLAN and its payload vocabulary is plan/period/renewal,
// none of which a pack has.
//
// The GST invoice the accounting service emails for the same payment is a legal document, not a
// receipt — different sender, addressed to the registered business, and it says nothing about the
// wallet. Both are wanted.
//
// `walletBalance` is the balance AFTER this purchase, passed in rather than read here so the
// number in the email is the one the ledger actually produced, not a second read that a concurrent
// spend could have moved.
export async function notifyCreditsPurchased(baker, { credits, amount, walletBalance, paymentId }) {
  const email = await bakerNotifyEmail(baker);
  if (!email) return;
  await insertNotification('credits_purchased', email, {
    bakerName:     baker?.name ?? null,
    timeZone:      baker?.timezone ?? null,
    credits:       credits       ?? null,
    amount:        amount        ?? null,   // paise, like every other payment payload
    walletBalance: walletBalance ?? null,
    paymentId:     paymentId     ?? null,   // the handle support runs on, if they ever need us
  });
}

export const notifySubscriptionActivated = (baker, p) => notifySubscription('subscription_activated', baker, p);
export const notifySubscriptionRenewed   = (baker, p) => notifySubscription('subscription_renewed',   baker, p);
export const notifyPaymentFailed         = (baker, p) => notifySubscription('payment_failed',          baker, p);
export const notifySubscriptionCancelled = (baker, p) => notifySubscription('subscription_cancelled',  baker, p);
export const notifySubscriptionExpired   = (baker, p) => notifySubscription('subscription_expired',    baker, p);

// ── Running out of credits ───────────────────────────────────────────────────
// Two thresholds of the MONTHLY allowance, and they are not the same message: at 80% nothing has
// stopped and the baker may not need to do anything; at 100% something has.
//
// `resetsOn` rides along because the single most useful fact in both emails is the date the
// allowance comes back — it is what turns "you are running out" into a decision someone can
// actually make ("that's Tuesday, I'll wait").
export async function notifyCreditsLow(baker, { threshold, left, allowance, walletBalance, resetsOn, canBuy }) {
  const slug = threshold === 'exhausted' ? 'credits_exhausted' : 'credits_low';
  const email = await bakerNotifyEmail(baker);
  if (!email) return;
  await insertNotification(slug, email, {
    bakerName:     baker?.name ?? null,
    timeZone:      baker?.timezone ?? null,
    left:          left          ?? 0,
    allowance:     allowance     ?? null,
    walletBalance: walletBalance ?? 0,
    resetsOn:      resetsOn      ?? null,
    // Whether topping up is even an option on this plan. Without it the email would offer a door
    // that is not there, and "buy more credits" that leads to "your plan cannot" is worse than
    // saying only what is true: the credits come back on the 1st.
    canBuy:        canBuy === true,
  });
}

// ── Deliveries due today (scheduled, not event-triggered) ────────────────────────────────────────
// The morning digest, one per baker per day. Everything about WHAT it says is decided in
// services/deliveryDigest.js and handed here already shaped.
//
// Returns the notification id, or NULL when the dedupe key caught a repeat — the caller counts that
// as "already produced today", which is a normal outcome of a re-run rather than an error.
// ── The Spark trial countdown (scheduled, not event-triggered) ──────────────────────────────────
// One per baker per MILESTONE — 7 days out, 2 days out, the last day, and the morning after. WHEN it
// fires is decided in services/trialReminders.js; this is delivery.
//
// Returns the notification id, or NULL when the dedupe key caught a repeat. The caller counts that
// as "this milestone was already sent", which is the normal outcome of a re-run rather than an error
// — and is also what stops a baker sitting in the seven-day bucket for five days getting five
// identical emails.
export async function notifyTrialReminder({ baker, milestone, payload }) {
  // ⚠️ Through bakerNotifyEmail, never baker.email. NO baker row on dev carries an address — the
  // reachable one is the primary baker_appusers row, which this resolves. Reading baker.email
  // directly produces a job that sends nothing and reports success.
  const email = await bakerNotifyEmail(baker);
  // No address, no reminder. Silent because a bakery with no reachable email is a state onboarding
  // owns, not something a daily cron should start alarming about.
  if (!email) return null;

  const slug = isEndedMilestone(milestone) ? 'trial_ended' : 'trial_ending';
  return insertNotification(slug, email, payload, {
    dedupeKey: reminderDedupeKey(baker.id, milestone),
    bakerId:   baker.id,
  });
}

/* The paid-plan renewal reminder. Sibling of notifyTrialReminder, and it differs in exactly one
 * place that matters: the dedupe key carries the PERIOD, not a milestone, so the same baker is
 * reminded again next cycle. See services/renewalReminders.js for why that is the whole design. */
export async function notifyRenewalReminder({ baker, periodEnd, payload }) {
  // Through bakerNotifyEmail, never baker.email — see notifyTrialReminder. No baker row on dev
  // carries an address; the reachable one is the primary baker_appusers row.
  const email = await bakerNotifyEmail(baker);
  // Silent: a bakery with no reachable email is a state onboarding owns, not something a daily cron
  // should alarm about.
  if (!email) return null;

  return insertNotification('subscription_renewing', email, payload, {
    dedupeKey: renewalDedupeKey(baker.id, periodEnd),
    bakerId:   baker.id,
  });
}

export async function notifyDeliveryDigest({ baker, date, payload }) {
  const email = await bakerNotifyEmail(baker);
  // No address, no digest. Silent because a bakery without a reachable email is a state the
  // onboarding flow owns, not something a 7am cron should start alarming about daily.
  if (!email) return null;

  return insertNotification('delivery_digest_baker', email, payload, {
    dedupeKey: digestDedupeKey(baker.id, date),
    bakerId:   baker.id,
  });
}
