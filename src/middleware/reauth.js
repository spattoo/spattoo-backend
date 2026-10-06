// ── "Prove it is still you" — step-up auth for a sensitive change ────────────────────────────────
//
// A session is a long-lived thing. It survives a closed laptop, a borrowed phone, a shoulder, and
// it is the only thing standing between a passer-by and the screen where a bakery's phone number
// and password live. requireAuth answers "is this a valid session"; it cannot answer "is the person
// holding it the owner, right now". This does.
//
// ⚠️ THE PASSWORD NEVER REACHES THIS API, AND THAT IS THE POINT.
// The obvious build is a route that takes a password and checks it. It works, and it costs three
// things: a plaintext credential crossing a boundary it has never crossed (today the password goes
// from the browser straight to Supabase, at login and nowhere else); an endpoint that answers "is
// this the right password", which is a brute-force oracle; and a defence that would lean on
// middleware/rateLimit.js, which FAILS OPEN by design — correct for traffic shaping, wrong as the
// only thing between an attacker and unlimited guesses.
//
// Instead the client re-authenticates against Supabase exactly as it does at login, and Supabase
// stamps the fact into the next access token:
//
//     amr: [{ method: 'password', timestamp: 1790963165 }]
//
// We read that stamp off the token requireAuth has already validated. The client cannot forge it —
// it is inside a JWT Supabase signed — and cannot manufacture it by refreshing.
//
// ⚠️ MEASURED, NOT ASSUMED (2026-10-02). A live dev token carried amr `{method:'otp', timestamp}`
// dated 9 August against an `iat` of 2 October: 54.3 days apart. That gap is the whole guarantee —
// if a refresh reset the stamp the two would be minutes apart, and a stale session would pass a
// freshness check forever. It does not. The claim records when the method was actually used.
//
// ⚠️ THE METHOD MUST BE `password`. That same token proves why: its only entry was `otp`, from a
// magic-link sign-in in August. "A recent amr entry" would have been satisfied by an OTP the user
// never typed a password for, which is not the question being asked.

const DEFAULT_MAX_AGE_SEC = 15 * 60;

// Read the claims out of a token that has ALREADY been validated.
//
// No signature check here on purpose, and it is not a shortcut: requireAuth ran first and called
// supabase.auth.getUser(token), which is Supabase validating the token against its own keys and
// revocation state. Re-verifying locally would need the JWT secret in config — a second copy of a
// credential, to re-answer a question already answered. What this does is read the payload of the
// exact string that passed.
function claimsOf(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    // base64url, not base64 — `-` and `_` are legal in a JWT segment and atob/Buffer reject them.
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;                      // a malformed token is a failed check, never a thrown 500
  }
}

/**
 * The most recent moment this token's owner proved the given method, as a unix timestamp, or null.
 *
 * `amr` has two shapes in the wild — Supabase's own `{ method, timestamp }[]`, and the RFC-8176
 * plain `string[]` that a custom access-token hook may return. The second carries no time, so it
 * can never satisfy a freshness question and is deliberately read as "no proof" rather than as
 * "proved at an unknown time".
 */
export function methodProvedAt(claims, method = 'password') {
  const amr = claims?.amr;
  if (!Array.isArray(amr)) return null;
  const times = amr
    .filter(e => e && typeof e === 'object' && e.method === method && Number.isFinite(e.timestamp))
    .map(e => e.timestamp);
  return times.length ? Math.max(...times) : null;
}

/**
 * Require that the caller typed their password within `maxAgeSec`.
 *
 * ⚠️ THE WINDOW MUST EXCEED ANY FLOW IT GUARDS. The phone change sends a code good for ten minutes
 * (routes/account.js), and the baker has to wait for an SMS in the middle of it. A window shorter
 * than that would reject the confirm step of a change the same person legitimately started, which
 * reads as a bug and teaches people to distrust the gate.
 */
export function requireRecentPassword({ maxAgeSec = DEFAULT_MAX_AGE_SEC } = {}) {
  return function requireRecentPasswordMw(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    const claims = token ? claimsOf(token) : null;
    const provedAt = methodProvedAt(claims, 'password');

    if (provedAt == null) {
      // Distinguished from "stale" so the client can say the right thing. A baker who has only ever
      // signed in by magic link has no password to confirm, and telling them their confirmation
      // expired would send them round a loop they cannot finish.
      return res.status(401).json({
        error: 'Please confirm your password to make this change.',
        code: 'reauth_required',
      });
    }

    const age = Math.floor(Date.now() / 1000) - provedAt;
    if (age > maxAgeSec) {
      return res.status(401).json({
        error: 'Please confirm your password again.',
        code: 'reauth_expired',
      });
    }

    req.passwordProvedAt = provedAt;
    next();
  };
}

export const REAUTH_MAX_AGE_SEC = DEFAULT_MAX_AGE_SEC;
