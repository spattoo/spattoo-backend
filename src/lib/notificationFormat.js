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
