import { config } from '../config.js';

// ── Cloudflare Turnstile, verified by US ─────────────────────────────────────
//
// The app's login already uses Turnstile, but nothing in this codebase has ever VERIFIED a token:
// there, enforcement is Supabase-native — the widget produces a token, Supabase checks it, and we
// hold no secret (see spattoo-core's auth/Captcha.jsx, which says exactly that).
//
// Our own public endpoints have no such backstop. If we accept a form without checking the token,
// the widget is decoration: a script posting straight at the API never loads the page, never gets a
// token, and would sail through. So this is the first place we hold TURNSTILE_SECRET_KEY.
//
// ── WHAT IT ACTUALLY PROVES ─────────────────────────────────────────────────
// That a real browser loaded our page recently. Nothing more. It does not say who someone is, and it
// will not stop a human typing nonsense or somebody paying a solving service. It is a large filter,
// not a wall — worth being precise about, because a captcha invites the belief that the endpoint
// behind it is now safe.
//
// ── FAIL CLOSED, UNLIKE THE RATE LIMITER ────────────────────────────────────
// rateLimit.js fails OPEN by design: a limiter must never take the site down, and its failure mode
// is "more requests than we wanted". This fails CLOSED. Its failure mode is "unverified requests",
// and the whole point is to reject those. A demo form that is briefly unavailable costs one lead who
// can email instead; one that quietly stops checking costs a filled table and a burnt sending
// reputation, and nobody notices until the mail starts landing in spam.
//
// The exception is NOT CONFIGURED, which is different from BROKEN: with no secret key this returns
// true and the caller relies on its other layers. That keeps dev and any deployment without the key
// working, exactly as smtp/razorpay/fcm already do here.

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function turnstileConfigured() {
  return !!config.turnstile?.secretKey;
}

/**
 * Is this token real, and was it issued for us?
 *
 * @param {string} token  the widget's token, from the form
 * @param {string} [ip]   the client's IP, which Cloudflare cross-checks against where the token was issued
 * @returns {Promise<boolean>}
 */
export async function verifyTurnstile(token, ip) {
  // Not configured → not enforced. See above.
  if (!turnstileConfigured()) return true;
  if (!token || typeof token !== 'string') return false;

  const body = new URLSearchParams({ secret: config.turnstile.secretKey, response: token });
  if (ip) body.set('remoteip', ip);

  try {
    // Bounded. Without a timeout a slow provider becomes OUR slow endpoint, and a public form is
    // exactly where a hung request pool hurts.
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`[turnstile] siteverify returned ${res.status}`);
      return false;
    }
    const data = await res.json();
    if (!data.success) {
      // The CODES, never the token. Enough to tell a misconfigured secret
      // ('invalid-input-secret') from a bot ('invalid-input-response') without logging something
      // that could be replayed within its lifetime.
      console.warn('[turnstile] rejected:', (data['error-codes'] ?? []).join(', ') || 'no reason given');
      return false;
    }
    return true;
  } catch (e) {
    console.error('[turnstile] verify failed:', e.message);
    return false;                       // fail closed
  }
}
