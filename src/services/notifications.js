import { supabase } from './supabase.js';
import { jobQueue } from '../jobs/queue.js';

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
async function insertNotification(typeSlug, recipientEmail, payload) {
  const typeId = await getTypeId(typeSlug);
  if (!typeId) throw new Error(`Unknown notification type: ${typeSlug}`);

  const { data: row, error } = await supabase
    .from('notifications')
    .insert({ type_id: typeId, recipient_email: recipientEmail, payload })
    .select('id')
    .single();
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

export async function notifyOrderPlaced({ order, baker, customer }) {
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
  };

  const jobs = [];

  const bakerEmail = await bakerNotifyEmail(baker);
  if (bakerEmail) {
    jobs.push(insertNotification('order_placed_baker', bakerEmail, payload));
  }
  if (customer.email) {
    jobs.push(insertNotification('order_placed_customer', customer.email, payload));
  }

  await Promise.all(jobs);
}

// Baker edited the design while it's still open (shared-pen window). Email the
// customer that there are recommendations / an update to review. `mode` tunes the
// copy: 'recommendations' (initiated) vs 'updated' (quoted, i.e. after a quote).
export async function notifyDesignUpdated({ order, baker, customer, mode = 'updated' }) {
  if (!customer?.email) return;
  await insertNotification('design_updated_customer', customer.email, {
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
  if (!customer?.email) return;
  await insertNotification('quote_issued_customer', customer.email, {
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
  });
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
  });
}

// Baker invited a customer to a design session. Email the customer the private
// storefront link (OTP gates access). Async via the outbox — the invite route no
// longer sends inline. No-op if there's no email (SMS/WhatsApp not yet wired).
export async function notifyCustomerInvited({ to, bakerName, firstName, link, brandColor, logoUrl, note, expiresAt }) {
  if (!to) return;
  await insertNotification('customer_invite', to, {
    bakerName, firstName, link, brandColor, logoUrl, note, expiresAt,
  });
}

// Baker confirmed the order (advance received). Email the customer.
export async function notifyOrderConfirmed({ order, baker, customer }) {
  if (!customer?.email) return;
  await insertNotification('order_confirmed_customer', customer.email, {
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
  if (!customer?.email) return;
  await insertNotification('order_ready_customer', customer.email, {
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
  if (!customer?.email) return;
  await insertNotification('order_completed_customer', customer.email, {
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
async function notifySubscription(typeSlug, baker, payload) {
  const email = await bakerNotifyEmail(baker);
  if (!email) return;
  await insertNotification(typeSlug, email, {
    bakerName: baker?.name ?? null,
    timeZone:  baker?.timezone ?? null,
    ...payload,
  });
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
