import { createHash, randomInt } from 'node:crypto';
import { supabase } from '../services/supabase.js';

// ── Issuing and checking a texted code, once ────────────────────────────────────────────────────
//
// Two flows now prove a phone number: changing the one on an account (routes/account.js) and
// proving the first one during onboarding (routes/bakers.js), which cannot use the account flow at
// all — there is no `baker_appusers` row to own yet, and `requireRecentPassword` has nothing to
// gate because the baker signed up minutes ago.
//
// ⚠️ SO THE MECHANICS LIVE HERE RATHER THAN BEING COPIED. The parts worth not having two of are the
// parts that are easy to get subtly wrong the second time: superseding older live attempts, a
// brute-force ceiling counted ON THE ROW (the Redis limiter fails open by design and this must
// not), burning the code BEFORE acting on it so a failure downstream cannot leave it replayable,
// and never storing the code itself.
//
// What each caller does AFTER a proof is its own business — the account flow writes the new number
// onto the owner row, onboarding just records that the number was proved — so this returns the
// verdict and writes nothing but the attempt.

/* ⚠️ ONE POLICY FOR BOTH CONTACTS AND BOTH FLOWS. A phone proof and an email proof want the same
   window and the same ceiling, and a copy of these numbers is how the pair drifts the first time
   either is tuned. */
export const CODE_TTL_SEC  = 10 * 60;   // long enough for a slow carrier, short enough to matter
export const CODE_ATTEMPTS = 5;         // per issued code; the 6th wrong guess burns it

export const hashCode = code => createHash('sha256').update(String(code)).digest('hex');

/**
 * Supersede the user's older live attempts and record a new one.
 *
 * ⚠️ Superseding is not tidiness. Without it a baker who typed the wrong number, corrected it and
 * asked again would hold two valid codes, and `verifyContactCode` — which reads the newest — would
 * silently accept the one for the number they abandoned.
 *
 * @returns {Promise<{ code: string }>} the plaintext code, for the SMS and for nothing else.
 */
export async function issueContactCode({ authUserId, kind, value, country = null }) {
  // randomInt, not Math.random: this is a credential, however short-lived.
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

  await supabase
    .from('appuser_contact_changes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('auth_user_id', authUserId)
    .eq('kind', kind)
    .is('consumed_at', null);

  const { error } = await supabase.from('appuser_contact_changes').insert({
    auth_user_id: authUserId,
    kind,
    new_value:    value,
    new_country:  country,
    code_hash:    hashCode(code),
    expires_at:   new Date(Date.now() + CODE_TTL_SEC * 1000).toISOString(),
  });
  if (error) throw error;
  return { code };
}

/**
 * Check a code against the newest live attempt.
 *
 * @returns {Promise<{ ok: true, value: string, country: string|null, id: string }
 *                  | { ok: false, status: number, body: object }>}
 *   A failure carries the status and body the route should answer with, so the two callers cannot
 *   describe the same refusal differently to the same baker.
 */
export async function verifyContactCode({ authUserId, kind, code }) {
  const { data: attempt, error } = await supabase
    .from('appuser_contact_changes')
    .select('id, new_value, new_country, code_hash, expires_at, attempts')
    .eq('auth_user_id', authUserId)
    /* ⚠️ SCOPED BY KIND since migration 123. Without it a baker changing both contacts at once
       confirms whichever they started LAST with either code — the two flows would share one
       "newest live attempt" and the email code would move the phone number. */
    .eq('kind', kind)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  if (!attempt || new Date(attempt.expires_at) < new Date()) {
    return { ok: false, status: 410, body: { error: 'That code has expired. Please ask for a new one.', code: 'expired' } };
  }
  if (attempt.attempts >= CODE_ATTEMPTS) {
    return { ok: false, status: 429, body: { error: 'Too many wrong codes. Please ask for a new one.', code: 'burned' } };
  }
  if (hashCode(code) !== attempt.code_hash) {
    // Count the miss on the ROW. The Redis limiter fails open by design; a brute-force ceiling on a
    // six-digit code must not.
    await supabase
      .from('appuser_contact_changes')
      .update({ attempts: attempt.attempts + 1 })
      .eq('id', attempt.id);
    return { ok: false, status: 401, body: { error: 'That code is not right.', field: 'code' } };
  }

  /* Burn the code FIRST, and stamp WHY it was burned. If whatever the caller does next fails, a
     replay must not be able to reuse it.

     ⚠️ `verified_at` EXISTS BECAUSE `consumed_at` CANNOT ANSWER "was this proved" — it is stamped
     both here and on every attempt superseded above, so a gate reading it as proof would accept
     the number a baker typed, abandoned and corrected. See migration 130. */
  const now = new Date().toISOString();
  await supabase
    .from('appuser_contact_changes')
    .update({ consumed_at: now, verified_at: now })
    .eq('id', attempt.id);

  return { ok: true, id: attempt.id, value: attempt.new_value, country: attempt.new_country };
}

/**
 * Has this user proved this exact value recently?
 *
 * ⚠️ THE VALUE IS COMPARED, NOT JUST THE PROOF. Otherwise a baker proves one number, edits the
 * field, and submits a different one with a valid proof sitting behind it — which is the whole
 * gate, defeated by changing an input after passing it.
 */
export async function provedRecently({ authUserId, kind, value, withinSec = 60 * 60 }) {
  const since = new Date(Date.now() - withinSec * 1000).toISOString();
  const { data, error } = await supabase
    .from('appuser_contact_changes')
    .select('id')
    .eq('auth_user_id', authUserId)
    .eq('kind', kind)
    .eq('new_value', value)
    .gte('verified_at', since)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}
