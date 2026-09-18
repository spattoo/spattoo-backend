// ── How a notification shows a date, a plan name and an amount ──────────────────────────────────
// Shared by the email builder (jobs/processors/sendNotification.js) and by services/notifications.js,
// which stores ready-to-show copies in the payload for SMS and WhatsApp templates. One definition, so
// an email and a WhatsApp message about the same renewal cannot print it two different ways.

// Format an INSTANT (ISO timestamptz) as a calendar date in the recipient's timezone — NOT the
// server's UTC — so "renews on Aug 2" doesn't display as Aug 1 for an IST baker (the datetime
// convention: convert at the edge using the actor's zone). Falls back to Asia/Kolkata.
export function formatDateTz(iso, tz) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz || 'Asia/Kolkata' });
  } catch {
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  }
}

export const titleCase = s => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
export const rupees    = paise => `₹${(Number(paise || 0) / 100).toLocaleString('en-IN')}`;

/* The same date, for a template gap: null rather than '—' when there is none. A null gap makes the
   channel skip and record why (services/notificationChannels.js); a dash would be sent to the baker. */
export const dateLabel = (iso, tz) => (iso ? formatDateTz(iso, tz) : null);

/* A CALENDAR date stored as "2026-09-16" — no time, no zone — as "16 September 2026". Read in UTC on
   purpose: it names a day, not an instant, and reading midnight in a zone west of UTC lands on the day
   before. Anything not in that shape is shown as it was given. */
export function calendarDate(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd ?? ''))) return ymd ? String(ymd) : null;
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/* A clock time stored as "14:30" as "2:30 PM". Anything else is shown as it was given. */
export function clockTime(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? ''));
  if (!m) return hhmm ? String(hhmm) : null;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}


/* ── Where a CUSTOMER'S notification sends them ──────────────────────────────────────────────────
 *
 * TWO links, deliberately separate, because they answer different questions:
 *
 *   customerOrderLink()  "open THIS order"  → www.spattoo.com/o/<orderId>   (one fixed host)
 *   storefrontLink()     "visit the shop"   → {slug}.spattoo.com            (the bakery's own)
 *
 * ⚠️ THE ORDER LINK HAS A SINGLE FIXED HOST, AND THAT IS THE WHOLE POINT. It used to be
 * `{slug}.spattoo.com/orders/<uuid>` — a host that changes with every bakery — which cannot be a
 * WhatsApp URL button (the button's base, host included, is fixed at template approval), cannot be
 * covered by one DLT CTA whitelist entry (whitelisting is per domain), and is 85 characters against
 * an SMS budget of 160. `www.spattoo.com/o/<uuid>` is 62, is a valid button base, and is one
 * whitelist entry for every baker there will ever be. `routes/orderLink.js` resolves it back to the
 * right storefront.
 *
 * ⚠️ THE SHOP LINK KEEPS THE BAKER'S OWN SUBDOMAIN, and must. "Order another anytime from Feelings
 * and Flavours" should land on THEIR shop front under THEIR name — routing that through a shared
 * Spattoo host would take a customer to us on their way back to the bakery. Only the order link
 * needs the fixed host, because only the order link goes in a template.
 *
 * Both return null without the field they need, and every caller must handle it: a WhatsApp or SMS
 * template variable cannot be empty (the provider rejects the send), so a link-carrying message is
 * SKIPPED rather than sent with a gap.
 *
 * ⚠️ `base` is PASSED IN, not read from config here. This module is a leaf that both the email
 * builder and the payload builder import, and reaching for config would make importing a date
 * formatter require a complete production environment — REDIS_URL and all — to load. The shape of
 * each link is the thing worth having once; which host it points at is one line at each caller.
 */

/** "Open this order" — one fixed host for every baker. `base` is config.marketing.url. */
export function customerOrderLink(p, base) {
  if (!p?.orderId || !base) return null;
  return `${String(base).replace(/\/+$/, '')}/o/${p.orderId}`;
}

/** "Visit the shop" — the bakery's own subdomain. `urlTemplate` is config.storefront.urlTemplate. */
export function storefrontLink(p, urlTemplate) {
  const slug = p?.bakerSlug ?? null;
  if (!slug || !urlTemplate) return null;
  return urlTemplate.replace('{slug}', slug).replace(/\/+$/, '');
}
