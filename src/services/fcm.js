import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { config } from '../config.js';
import { supabase } from './supabase.js';

// ── The ONE place a push notification is sent. ───────────────────────────────────────────────────
// FCM today; the provider lives behind this file, same as nodemailer behind mailer.js and MSG91
// behind msg91.js. Third time that seam has been used, and it is the reason adding push did not
// touch the outbox at all.
//
// ── WHY FCM AND NOT RAW WEB-PUSH ────────────────────────────────────────────────────────────────
// A browser can be pushed to with plain VAPID and the `web-push` package, no Firebase involved. It
// was not chosen because the Capacitor apps are a fortnight out: FCM sends to a browser, an Android
// app and (relaying through APNs) an iPhone with ONE token shape, ONE credential and ONE send path.
// Raw web-push would work now and be deleted then.
//
// ── PUSH IS THE FAST CHANNEL, NOT THE RELIABLE ONE ──────────────────────────────────────────────
// Email stays the durable record. Everything here is best-effort by design: a failed push must never
// fail the notification, because the baker has already been emailed and a retry storm against dead
// tokens helps nobody. See the caller in processors/sendNotification.js.

let app = null;

// Is push configured? Callers check this rather than catching — an unconfigured deployment is a
// normal state (no Firebase project yet, local dev), not an error to be logged every send.
export function pushConfigured() {
  return !!config.fcm.serviceAccount;
}

function messaging() {
  if (!app) {
    // The service account is a JSON blob in one env var. Parsed here rather than at config load so
    // a malformed value breaks pushes and not the whole API boot — email must keep working.
    const creds = JSON.parse(config.fcm.serviceAccount);
    app = getApps()[0] ?? initializeApp({ credential: cert(creds) }, 'push');
  }
  return getMessaging(app);
}

/**
 * Every device that should hear about a notification addressed to this email.
 *
 * TWO ways an address resolves, and both are needed:
 *
 *   1. A PERSON — `baker_appusers.email` → their own devices.
 *   2. A BAKERY — `bakers.email` → every device in that shop.
 *
 * The second is not a nicety. `bakerNotifyEmail()` PREFERS `bakers.email` (the bakery's contact
 * address) and only falls back to an app user's, so a baker-targeted notification usually carries an
 * address that exists nowhere in `baker_appusers`. Resolving by person alone found nothing, sent
 * nothing, and said nothing — the enquiry email arrived and the phone stayed dark.
 *
 * Sending to the whole shop is also the behaviour you want on its own terms: two staff on shift
 * should both hear that an enquiry came in, and a device is only in `device_tokens` because somebody
 * signed in on it and asked to be told.
 *
 * A Set, because the two paths overlap whenever the bakery's contact address is also a staff
 * member's — which is the common case for a one-person bakery, and would otherwise buzz twice.
 */
async function tokensForRecipient(email) {
  const tokens = new Set();

  const { data: user } = await supabase
    .from('baker_appusers')
    .select('auth_user_id')
    .eq('email', email)
    .maybeSingle();
  if (user?.auth_user_id) {
    const { data } = await supabase
      .from('device_tokens')
      .select('token')
      .eq('auth_user_id', user.auth_user_id);
    for (const r of data ?? []) tokens.add(r.token);
  }

  const { data: baker } = await supabase
    .from('bakers')
    .select('id')
    .eq('email', email)
    .maybeSingle();
  if (baker?.id) {
    const { data } = await supabase
      .from('device_tokens')
      .select('token')
      .eq('baker_id', baker.id);
    for (const r of data ?? []) tokens.add(r.token);
  }

  return [...tokens];
}

/** Drop tokens FCM has told us are dead. A device that uninstalled is not a delivery failure to retry. */
async function prune(tokens) {
  if (!tokens.length) return;
  await supabase.from('device_tokens').delete().in('token', tokens);
  console.log(`[fcm] pruned ${tokens.length} dead token(s)`);
}

/**
 * Send one notification to every device of one recipient.
 *
 * @param {{ email: string, title: string, body: string, url?: string, tag?: string }} msg
 * @returns {Promise<{ sent: number, failed: number, pruned: number }>}
 */
export async function sendPush({ email, title, body, url, tag }) {
  const result = { sent: 0, failed: 0, pruned: 0, tokens: 0 };
  if (!pushConfigured()) { result.reason = 'not_configured'; return result; }
  if (!email) { result.reason = 'no_recipient'; return result; }

  const tokens = await tokensForRecipient(email);
  result.tokens = tokens.length;
  // The commonest silent outcome, and it used to log nothing at all: the notification was produced,
  // the email was sent, and nobody had a device registered under that address. Indistinguishable
  // from "push was never attempted" unless it says so.
  if (!tokens.length) { result.reason = 'no_devices'; return result; }

  // DATA-ONLY, no `notification` block. With one, the browser and Android both render the payload
  // themselves and our service worker's onBackgroundMessage never runs — so the click-through and
  // the icon would silently stop being ours. Sending data only keeps one place deciding what a
  // Spattoo notification looks like and where tapping it goes.
  const res = await messaging().sendEachForMulticast({
    tokens,
    data: { title, body, url: url ?? '/', ...(tag ? { tag } : {}) },
    webpush: { headers: { Urgency: 'high' } },
    android: { priority: 'high' },   // wake the device rather than batching — see the OEM note in the plan
  });

  const dead = [];
  res.responses.forEach((r, i) => {
    if (r.success) { result.sent++; return; }
    result.failed++;
    // These two mean the token is gone for good (uninstalled, or a token that never existed).
    // Anything else — a network blip, a quota — is transient and the row stays.
    const code = r.error?.code ?? '';
    if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
      dead.push(tokens[i]);
    }
  });

  await prune(dead);
  result.pruned = dead.length;
  return result;
}
