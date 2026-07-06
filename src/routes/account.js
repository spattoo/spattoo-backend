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

export default router;
