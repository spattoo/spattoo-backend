import { config } from '../config.js';

// ── The ONE place an SMS is sent. ────────────────────────────────────────────
// MSG91 today; the PROVIDER lives behind this file, so swapping it is a change to THIS file
// only, no caller touched. Same pattern as nodemailer behind services/mailer.js and the
// telemetry vendor behind lib/telemetry.js.
//
// ── WHY THIS IS A PIPE AND NOT AN OTP SERVICE ────────────────────────────────────────────────
// MSG91 sells a complete OTP product: it generates the code, stores it, and verifies it for you.
// We use none of that, and pass our OWN code in the `otp` param instead.
//
// The reason is the session. POST /api/storefront/:slug/verify-otp answers with a Supabase
// session, and POST /api/orders then reads the verified contact OUT OF THAT TOKEN rather than
// trusting the enquiry body — that token IS the proof the number was checked. Only Supabase can
// mint it. Letting MSG91 own the code would mean the thing that proves the number and the thing
// that carries the proof are different systems, and the whole chain would have to be rebuilt to
// save one webhook.
//
// So Supabase mints and checks; we carry. If this file ever grows a verify() function, something
// has gone wrong.
const OTP_URL = 'https://control.msg91.com/api/v5/otp';

// Is a sender configured? The hook checks this so a deployment without MSG91 credentials fails
// loudly at the edge rather than sending a confusing provider error to the customer.
export function smsConfigured() {
  return !!(config.sms.authKey && config.sms.templateId);
}

/**
 * Deliver an already-minted OTP to a phone number.
 *
 * @param {{ phone: string, otp: string }} args  `phone` in E.164 (Supabase's shape, with `+`).
 * @returns {Promise<object>} MSG91's parsed response body.
 * @throws  on any provider failure — the caller decides how to react.
 */
export async function sendOtpSms({ phone, otp }) {
  // Supabase hands us E.164 WITH the leading '+' ("+919876543210"); MSG91 wants country code and
  // digits only. Stripping every non-digit rather than just the '+' also absorbs the spaces and
  // dashes a hand-typed test number arrives with.
  const mobile = String(phone ?? '').replace(/\D/g, '');
  if (!mobile) throw new Error('sendOtpSms: phone is required');

  const url = new URL(OTP_URL);
  url.searchParams.set('template_id', config.sms.templateId);
  url.searchParams.set('mobile', mobile);
  url.searchParams.set('otp', otp);   // OURS — see the note above on why we never let MSG91 mint it.

  return postToMsg91(url, {});
}

// One POST to MSG91, read the only way that is safe.
//
// MSG91 answers 200 even for failures — a bad template id, an unregistered sender, an exhausted
// balance all arrive as `{"type":"error"}` under a green status. Reading res.ok alone would
// report every one of those as a successful send, and the customer would wait for a code that
// was never accepted.
async function postToMsg91(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authkey: config.sms.authKey, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.type === 'error') {
    throw new Error(body?.message || `MSG91 send failed (HTTP ${res.status})`);
  }
  return body;
}

// ── Every other SMS: a DLT-approved template, filled from a notification ─────────────────────────
// Used by the notification sender (jobs/processors/sendNotification.js) for the SMS channels switched
// on in admin. Needs only the auth key. The template id comes from admin, per notification type
// (notification_channels.template_ref) — never from MSG91_TEMPLATE_ID, which is the OTP template and
// nothing else.
const FLOW_URL = 'https://control.msg91.com/api/v5/flow';

export function templateSmsConfigured() {
  return !!config.sms.authKey;
}

/**
 * Send one DLT-approved template SMS.
 *
 * @param {{ phone: string, templateId: string, variables?: Record<string, string> }} args
 *   `variables` are keyed by the names the template's variables were given in MSG91 (VAR1, …).
 *   The names are case-sensitive.
 * @returns {Promise<object>} MSG91's parsed response body.
 * @throws  on any provider failure — the caller decides how to react.
 */
export async function sendTemplateSms({ phone, templateId, variables = {} }) {
  const mobile = String(phone ?? '').replace(/\D/g, '');
  if (!mobile) throw new Error('sendTemplateSms: phone is required');
  if (!templateId) throw new Error('sendTemplateSms: templateId is required');

  // ⚠️ `template_id` is the name MSG91's panel uses now; its older docs call the same value `flow_id`.
  // Not yet proven against a live send — if the first one answers "flow id missing", this is why.
  return postToMsg91(FLOW_URL, {
    template_id: templateId,
    short_url:   '0',
    recipients:  [{ mobiles: mobile, ...variables }],
  });
}
