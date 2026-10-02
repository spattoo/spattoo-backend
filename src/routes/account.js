import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability, resolvePrincipal } from '../middleware/rbac.js';
import { config } from '../config.js';
import { DELETION_STATUS } from '../constants/accountDeletion.js';
import {
  CONSENT_SUBJECT_TYPE,
  CONSENT_SOURCE,
  CONSENT_REQUIRED_DOC_KEYS,
} from '../constants/legalDocuments.js';
import { withdrawConsent } from '../services/legalConsent.js';
import { cancelBakerSubscription } from './billing.js';
import { createHash, randomInt } from 'node:crypto';
import { rateLimit } from '../middleware/rateLimit.js';
import { normalizePhone } from '../lib/phone.js';
import { primaryOwnerConflict } from '../services/bakerProvisioning.js';
import { sendOtpSms, smsConfigured } from '../services/msg91.js';
import { maskPhone } from '../lib/mask.js';

// Account erasure lifecycle — the CONTRACT-basis §12 right (DPDP "Layer 3").
// See docs/CONSENT_WITHDRAWAL_AND_ERASURE_PLAN.md. Deletion is a lifecycle, never an instant hard
// delete: this route SOFT-deletes (reversible until erase_after); a scheduled BullMQ job
// (jobs/processors/eraseExpiredAccounts.js) does the irreversible erasure after the window.
const router = Router();

const publicState = b => ({
  deletion_status: DELETION_STATUS.NAME_BY_ID[b.deletion_status] ?? 'active',
  requested_at:    b.deletion_requested_at ?? null,
  erase_after:     b.erase_after ?? null,
});

// ── GET /api/baker/account/deletion-status ── so the app can show a "scheduled for deletion /
// restore" banner. Any baker app-user may read it (the whole baker is affected).
router.get('/baker/account/deletion-status', requireAuth, resolvePrincipal, async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'Not a baker account' });
    const { data, error } = await supabase
      .from('bakers')
      .select('deletion_status, deletion_requested_at, erase_after')
      .eq('id', req.bakerId)
      .single();
    if (error) return serverError(req, res, error);
    res.json(publicState(data));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/baker/account/delete ── request erasure of the baker account (owner-only via the
// dedicated `account:delete` capability — staff cannot). Soft-delete + take the storefront offline
// (cease outward processing) + audit row + record consent WITHDRAWN for the necessary docs.
// Idempotent: a second call while already pending returns the existing state.
router.post('/baker/account/delete', requireAuth, requireCapability('account:delete'), async (req, res) => {
  try {
    const bakerId = req.bakerId;
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { data: baker, error: readErr } = await supabase
      .from('bakers')
      .select('id, deletion_status, deletion_requested_at, erase_after')
      .eq('id', bakerId)
      .single();
    if (readErr) return serverError(req, res, readErr);
    if (baker.deletion_status === DELETION_STATUS.PENDING_ERASURE) return res.json(publicState(baker));
    if (baker.deletion_status === DELETION_STATUS.ERASED) return res.status(410).json({ error: 'already_erased' });

    // Stop billing FIRST, fail-closed: never complete a deletion that implies billing stopped while
    // Razorpay keeps charging. Reuses the ONE cancel path (immediate Razorpay cancel + grace until
    // period end). If the provider can't be reached the whole request aborts — the soft-delete is
    // reversible/retryable, so a momentary Razorpay outage shouldn't leave a half-cancelled account.
    try {
      await cancelBakerSubscription(bakerId, { changedBy: 'baker', note: 'account deletion' });
    } catch (e) {
      if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
      return serverError(req, res, e);
    }

    const nowIso     = new Date().toISOString();
    const eraseAfter = new Date(Date.now() + config.retention.accountWindowDays * 86400000).toISOString();

    // Soft-delete + take the storefront offline. deletion_status=ACTIVE is the optimistic lock so a
    // concurrent double-submit can't stack two requests.
    const { data: updated, error: updErr } = await supabase
      .from('bakers')
      .update({
        deletion_status:       DELETION_STATUS.PENDING_ERASURE,
        deletion_requested_at: nowIso,
        erase_after:           eraseAfter,
        notice_sent_at:        null,
        storefront_published:  false,
      })
      .eq('id', bakerId)
      .eq('deletion_status', DELETION_STATUS.ACTIVE)
      .select('id, deletion_status, deletion_requested_at, erase_after')
      .maybeSingle();
    if (updErr) return serverError(req, res, updErr);
    if (!updated) {   // lost the race — re-read and return whatever state won
      const { data: fresh } = await supabase
        .from('bakers').select('deletion_status, deletion_requested_at, erase_after').eq('id', bakerId).single();
      return res.json(publicState(fresh));
    }

    // Append-only audit of the request (kept forever — proof it was handled lawfully).
    await supabase.from('deletion_requests').insert({
      baker_id:     bakerId,
      requested_by: req.user.id,
      reason:       typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 2000) : null,
      ip:           req.ip ?? null,
      erase_after:  eraseAfter,
    });

    // Record consent WITHDRAWN for the necessary docs (the audit trail of the closure). Best-effort:
    // a failure here must not block the deletion the user asked for.
    try {
      await withdrawConsent({
        subjectType: CONSENT_SUBJECT_TYPE.BAKER_APPUSER,
        subjectId:   req.user.id,
        docKeys:     [...CONSENT_REQUIRED_DOC_KEYS],
        source:      CONSENT_SOURCE.ACCOUNT_CLOSURE,
        ip:          req.ip,
        userAgent:   req.headers['user-agent'] ?? null,
      });
    } catch (e) {
      console.error('[account/delete] consent withdrawal record failed (non-blocking):', e.message);
    }

    res.json(publicState(updated));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/baker/account/restore ── cancel a pending erasure within the reversal window. Does
// NOT auto-republish the storefront (the baker re-publishes deliberately) and does NOT revive the
// subscription — the Razorpay cancel from delete is irreversible, so a restored baker keeps grace
// access until period end, then must re-subscribe via Billing for paid features. No-op after erasure.
router.post('/baker/account/restore', requireAuth, requireCapability('account:delete'), async (req, res) => {
  try {
    const bakerId = req.bakerId;
    if (!bakerId) return res.status(403).json({ error: 'Not a baker account' });

    const { data: updated, error: updErr } = await supabase
      .from('bakers')
      .update({
        deletion_status:       DELETION_STATUS.ACTIVE,
        deletion_requested_at: null,
        erase_after:           null,
        notice_sent_at:        null,
      })
      .eq('id', bakerId)
      .eq('deletion_status', DELETION_STATUS.PENDING_ERASURE)   // only a pending erasure is restorable
      .select('id, deletion_status, deletion_requested_at, erase_after')
      .maybeSingle();
    if (updErr) return serverError(req, res, updErr);
    if (!updated) return res.status(409).json({ error: 'not_pending_erasure' });

    // Close out the open audit row(s).
    await supabase
      .from('deletion_requests')
      .update({ cancelled_at: new Date().toISOString() })
      .eq('baker_id', bakerId)
      .is('cancelled_at', null)
      .is('erased_at', null);

    res.json(publicState(updated));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Changing your own phone number ────────────────────────────────────────────────────────────
//
// ⚠️ READ migrations/119 BEFORE TOUCHING THIS. The short version: this is a POSSESSION PROOF, not
// an authentication. The caller is already past requireAuth — we are not asking who they are, we
// are asking whether they can receive SMS at a number they do not yet own on paper. Supabase's
// OTP cannot answer that question, because its answer is a SESSION: signInWithOtp would sign the
// baker in as whoever holds the number (or mint a new empty user and sign them in as that), and
// verifyOtp({ type: 'phone_change' }) would write the number onto auth.users, where it becomes a
// password-free sign-in door — phone auth is enabled on this project because the storefront needs
// it. So the code is ours, start to finish, and MSG91 stays the delivery pipe it already was.
//
// OWNER ONLY. baker_appusers.phone is unique across is_primary rows (migrations 015/016) and
// migration 015 names what that index is for: "one phone number per baker (subscription
// boundary)". Moving it is a billing-adjacent act, not a profile tweak.

const PHONE_CODE_TTL_SEC  = 10 * 60;   // long enough for a slow carrier, short enough to matter
const PHONE_CODE_ATTEMPTS = 5;         // per issued code; the 6th wrong guess burns it

const hashCode = code => createHash('sha256').update(String(code)).digest('hex');

// Keyed on the auth user, never the IP: the abuse unit here is an account, and a baker on hotel
// wifi must not inherit a stranger's budget. `req.user` is set by requireAuth, which runs first.
const phoneStartLimit = rateLimit({
  name: 'acct-phone-start', limit: 5, windowSec: 900, key: req => req.user?.id,
  message: 'Too many code requests. Please wait a few minutes and try again.',
});
const phoneConfirmLimit = rateLimit({
  name: 'acct-phone-confirm', limit: 15, windowSec: 900, key: req => req.user?.id,
  message: 'Too many attempts. Please wait a few minutes and try again.',
});

// The caller's OWN owner row, or null. Every route below writes exactly this row and no other, so
// the lookup is by auth_user_id — there is no path here that takes a target id from the request.
async function ownerRow(authUserId) {
  const { data } = await supabase
    .from('baker_appusers')
    .select('id, baker_id, phone, phone_country, is_primary')
    .eq('auth_user_id', authUserId)
    .maybeSingle();
  return data?.is_primary ? data : null;
}

// ── POST /api/baker/account/phone/start ───────────────────────────────────────
// Body: { phone, country? }. Sends a code to the NEW number. Answers with the masked destination
// so the client can say where it went without re-deriving a normalised form it never saw.
router.post('/baker/account/phone/start', requireAuth, phoneStartLimit, async (req, res) => {
  try {
    // Shape first — a malformed number should cost nothing. normalizePhone is the single validator
    // every write path shares (lib/phone.js), so the stored shape here matches onboarding's exactly.
    const phone = normalizePhone(req.body?.phone, req.body?.country || 'IN');
    if (!phone.ok) return res.status(400).json({ error: phone.error, field: 'phone' });

    const owner = await ownerRow(req.user.id);
    if (!owner) return res.status(403).json({ error: 'Only the account owner can change this number.' });
    if (owner.phone === phone.e164) {
      return res.status(400).json({ error: 'That is already your number.', field: 'phone' });
    }

    // Check the collision BEFORE spending an SMS. The unique index would catch it either way, but
    // at that point the baker has already waited for a code and typed it, and the failure arrives
    // as a 23505 at the end of a flow they cannot retry differently.
    if (await primaryOwnerConflict({ phone: phone.e164 })) {
      return res.status(409).json({
        error: 'That phone number is already registered to another bakery.',
        code: 'owner_exists', field: 'phone',
      });
    }

    // Deliberately BEFORE the insert: a row with no code on its way is a dead attempt the baker
    // would be told to verify.
    if (!smsConfigured()) return res.status(503).json({ error: 'Text messages are not available right now.' });

    // randomInt, not Math.random: this is a credential, however short-lived.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

    // Supersede the user's older live attempts. Without this, a baker who typed the wrong number,
    // corrected it and asked again would have two valid codes, and the confirm step below — which
    // reads the newest — would silently accept the one for the number they abandoned.
    await supabase
      .from('appuser_phone_changes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('auth_user_id', req.user.id)
      .is('consumed_at', null);

    const { error: insErr } = await supabase.from('appuser_phone_changes').insert({
      auth_user_id: req.user.id,
      new_phone:    phone.e164,
      new_country:  phone.country,
      code_hash:    hashCode(code),
      expires_at:   new Date(Date.now() + PHONE_CODE_TTL_SEC * 1000).toISOString(),
    });
    if (insErr) return serverError(req, res, insErr);

    // A provider failure must NOT read as "code sent" — the baker would sit and wait for nothing.
    try {
      await sendOtpSms({ phone: phone.e164, otp: code });
    } catch (err) {
      return res.status(502).json({ error: 'We could not send the code. Please try again.' });
    }

    res.json({ sent: true, to: maskPhone(phone.e164), expiresIn: PHONE_CODE_TTL_SEC });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/baker/account/phone/confirm ─────────────────────────────────────
// Body: { code }. The number is NOT in the body — it is read off the attempt row, so a caller
// cannot prove one number and write another.
router.post('/baker/account/phone/confirm', requireAuth, phoneConfirmLimit, async (req, res) => {
  try {
    const code = String(req.body?.code ?? '').trim();
    if (!code) return res.status(400).json({ error: 'Enter the code we sent you.', field: 'code' });

    const owner = await ownerRow(req.user.id);
    if (!owner) return res.status(403).json({ error: 'Only the account owner can change this number.' });

    const { data: attempt, error: readErr } = await supabase
      .from('appuser_phone_changes')
      .select('id, new_phone, new_country, code_hash, expires_at, attempts')
      .eq('auth_user_id', req.user.id)
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (readErr) return serverError(req, res, readErr);
    if (!attempt || new Date(attempt.expires_at) < new Date()) {
      return res.status(410).json({ error: 'That code has expired. Please ask for a new one.', code: 'expired' });
    }
    if (attempt.attempts >= PHONE_CODE_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many wrong codes. Please ask for a new one.', code: 'burned' });
    }

    if (hashCode(code) !== attempt.code_hash) {
      // Count the miss on the ROW. The Redis limiter above fails open by design; a brute-force
      // ceiling on a six-digit code must not.
      await supabase
        .from('appuser_phone_changes')
        .update({ attempts: attempt.attempts + 1 })
        .eq('id', attempt.id);
      return res.status(401).json({ error: 'That code is not right.', field: 'code' });
    }

    // Burn the code FIRST. If the write below fails, a replay must not be able to reuse it.
    await supabase
      .from('appuser_phone_changes')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', attempt.id);

    const { error: updErr } = await supabase
      .from('baker_appusers')
      .update({ phone: attempt.new_phone, phone_country: attempt.new_country })
      .eq('id', owner.id);
    if (updErr) {
      // The number was claimed by another bakery between start and confirm. Rare, but the index is
      // the authority and this is the only honest thing to say about it.
      if (updErr.code === '23505') {
        return res.status(409).json({
          error: 'That phone number is already registered to another bakery.',
          code: 'owner_exists', field: 'phone',
        });
      }
      return serverError(req, res, updErr);
    }

    res.json({ phone: attempt.new_phone, country: attempt.new_country });
  } catch (err) {
    serverError(req, res, err);
  }
});


export default router;
