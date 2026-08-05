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
 * Every device belonging to the person at this email address.
 *
 * Email → baker_appusers → auth_user_id → device_tokens. Two hops, and deliberately so: the
 * notifications table addresses a PERSON by email and that stays true. Denormalising the email onto
 * device_tokens would be one query, and wrong the first time somebody changes their address.
 */
async function tokensForEmail(email) {
  const { data: user } = await supabase
    .from('baker_appusers')
    .select('auth_user_id')
    .eq('email', email)
    .maybeSingle();
  if (!user?.auth_user_id) return [];

  const { data } = await supabase
    .from('device_tokens')
    .select('token')
    .eq('auth_user_id', user.auth_user_id);
  return (data ?? []).map(r => r.token);
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
  const result = { sent: 0, failed: 0, pruned: 0 };
  if (!pushConfigured() || !email) return result;

  const tokens = await tokensForEmail(email);
  if (!tokens.length) return result;

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
