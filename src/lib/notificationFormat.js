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
