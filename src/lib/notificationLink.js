// ── Where a notification takes you ───────────────────────────────────────────────────────────────
// ONE place deciding the destination for a notification type, used by BOTH the push payload
// (jobs/processors/sendNotification.js → buildPush) and the notification centre's list.
//
// They were separate. A push knew it should open the order; the bell would have had to work it out
// again, and the two would have disagreed the first time a route moved — with the disagreement
// showing up as "the bell takes me somewhere else than the notification did", which reads as a bug
// in the app rather than in a duplicated constant.
//
// ── WHY A QUERY PARAM AND NOT A PATH ────────────────────────────────────────────────────────────
// The baker app is ONE route (spattoo-web `app/page.tsx` → CakeDesigner). There is no `/orders/123`
// for a baker — the order list is a panel inside the designer, not a page. So a deep link says WHAT
// TO OPEN and the app opens it, which is the same mechanism `?session=` already uses for live
// co-design.
//
// Returns a path relative to the app root, always — never an absolute URL. The caller knows which
// host it is addressing (APP_URL for email, the origin for push), and baking one in here would make
// this file environment-aware for no reason.

/**
 * @param {string} typeSlug  a notification_types.slug
 * @param {object} payload   the notification's payload
 * @returns {string} a path within the baker app
 */
export function linkFor(typeSlug, payload) {
  const p = payload ?? {};

  // Everything order-shaped opens that order. The orderId is on the payload for these types because
  // they were built from an order; where it is missing (an older row, a payload written before the
  // field existed) this degrades to the order LIST rather than to a broken link.
  const ORDER_TYPES = new Set([
    'order_placed_baker',
    'quote_accepted_baker',
    'quote_question_baker',
    'order_confirmed_customer',
  ]);
  if (ORDER_TYPES.has(typeSlug)) {
    return p.orderId ? `/?order=${encodeURIComponent(p.orderId)}` : '/?panel=orders';
  }

  // The morning digest is about a DAY, not one order — several orders is the normal case, so
  // singling one out would be picking arbitrarily. Opens the list.
  if (typeSlug === 'delivery_digest_baker') return '/?panel=orders';

  /* Billing-shaped: a baker reading these wants the billing screen, not an order.
   *
   * ⚠️ MATCHED AGAINST THE REAL SLUGS, which is not what this line used to do. It tested
   * `credit_` — singular — and every credits slug is `credits_*`, so `credits_low`,
   * `credits_exhausted` and `credits_purchased` have all been falling through to the app root since
   * they shipped. A baker tapping "your AI credits are running out" landed in the designer with no
   * indication of where to go, which is precisely the "the bell is decorative" outcome the fallback
   * below warns about. `payment_failed` was never listed at all.
   *
   * A prefix test is what let that hide: it looks like it covers a family, and nothing fails when
   * the family is spelled differently. The list is explicit now — a new billing slug has to be added
   * here, and that is a better failure than a silent miss.
   */
  const BILLING_TYPES = new Set([
    'subscription_activated', 'subscription_cancelled', 'subscription_expired', 'subscription_renewed',
    'credits_low', 'credits_exhausted', 'credits_purchased',
    'payment_failed',
    // The Spark trial countdown. The whole point of the email is "choose a plan", so landing anywhere
    // else would waste the one tap it earns.
    'trial_ending', 'trial_ended',
  ]);
  if (BILLING_TYPES.has(typeSlug)) return '/?panel=billing';

  // The app itself. Deliberately not null: a notification that cannot be opened is one a baker taps
  // and nothing happens, which teaches them the bell is decorative.
  return '/';
}
