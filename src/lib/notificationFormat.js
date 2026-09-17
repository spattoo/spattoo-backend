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
 * The storefront, on the baker's own subdomain — not the baker app, which `lib/notificationLink.js`
 * covers and which a customer cannot sign in to. Deep-links to the order summary (review, accept a
 * quote, see an update), falling back to the storefront root when there is no orderId, which is
 * still better than no link at all.
 *
 * ⚠️ IT WAS WRITTEN THREE TIMES, inline in the email builder — design_updated, quote_issued and
 * order_completed each rebuilt it from `bakerSlug`. That was survivable while email was the only
 * channel that had a link. It stopped being survivable when WhatsApp needed the same URL as a
 * template VARIABLE: a fourth copy, in a different file, filling a message whose text nobody can
 * edit without re-approval at Meta. Two of them already disagreed — order_completed drops the
 * `/orders/<id>` deep link and sends you to the shop front.
 *
 * Returns null when there is no slug, and every caller must handle that: a template variable cannot
 * be empty (Meta rejects the send), so a link-carrying WhatsApp template is SKIPPED rather than sent
 * with a gap.
 *
 * ⚠️ `urlTemplate` is PASSED IN, not read from config here. This module is a leaf that both the
 * email builder and the payload builder import, and reaching for config would make importing a date
 * formatter require a complete production environment — REDIS_URL and all — to load. The shape of
 * the link is the thing worth having once; which host it points at is one line at each caller. */
export function customerOrderLink(p, urlTemplate, { deep = true } = {}) {
  const slug = p?.bakerSlug ?? null;
  if (!slug || !urlTemplate) return null;
  const base = urlTemplate.replace('{slug}', slug).replace(/\/+$/, '');
  return deep && p?.orderId ? `${base}/orders/${p.orderId}` : base;
}
