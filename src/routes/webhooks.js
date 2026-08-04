import { Router } from 'express';
import { Webhook } from 'standardwebhooks';
import { supabase } from '../services/supabase.js';
import { getTask } from '../services/meshy.js';
import { finalizeOrUpdate } from './meshy.js';
import { config } from '../config.js';
import { sendOtpSms, smsConfigured } from '../services/msg91.js';

const router = Router();

// ── POST /webhooks/meshy ──────────────────────────────────────────────────────
// Meshy's webhook is ACCOUNT-GLOBAL (one HTTPS URL configured in the Meshy dashboard);
// it POSTs the task object on completion. There is no documented signature, so we do NOT
// trust the body: we read only the task id from it, then RE-FETCH the authoritative task
// via the API before finalizing. Always return 200 so Meshy doesn't retry-spam.
// Raw-body mounting happens in server.js (before express.json()).
router.post('/webhooks/meshy', async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());
    const taskId = payload?.id ?? payload?.task_id ?? payload?.result;
    if (!taskId) return res.json({ ok: true });

    const { data: row } = await supabase
      .from('meshy_generations').select('*').eq('meshy_task_id', taskId).maybeSingle();
    if (!row) return res.json({ ok: true });

    // Verify by re-fetching — don't act on the unsigned webhook body directly.
    const task = await getTask(taskId);
    await finalizeOrUpdate(row, task);

    res.json({ ok: true });
  } catch (err) {
    console.error('Meshy webhook error:', err.message);
    res.json({ ok: true }); // swallow — never trigger Meshy redelivery
  }
});

// ── POST /webhooks/supabase-sms ───────────────────────────────────────────────
// Supabase's Send SMS Hook. Fires whenever Supabase Auth wants to text a code — which for us is
// signInWithOtp({ phone }) from the storefront and invite OTP paths. Supabase has ALREADY minted
// the code by the time we're called; our whole job is to hand it to MSG91.
//
// Nothing in core or in the OTP handlers changed to make this work. signInWithOtp/verifyOtp keep
// their exact contract — the hook slots in underneath Supabase, not beside it — which is why this
// is a delivery integration and not an auth rewrite.
//
// UNLIKE the Meshy hook above, this body IS signed (standardwebhooks), so it can be trusted —
// but only after verify() passes. The signature is the only thing standing between this endpoint
// and anyone who learns the URL, so failure to verify must never fall through to a send.
//
// Raw-body mounting happens in server.js before express.json(): the signature covers the exact
// bytes, and a parse-then-restringify would change them and fail every time.
router.post('/webhooks/supabase-sms', async (req, res) => {
  try {
    if (!smsConfigured() || !config.sms.hookSecret) {
      // A deployment without MSG91 credentials should say so plainly rather than 500 from inside
      // the provider call. Reachable if `sms` is in STOREFRONT_OTP_CHANNELS before the keys land.
      return res.status(503).json({ error: { http_code: 503, message: 'SMS not configured' } });
    }

    // Supabase issues the secret as `v1,whsec_<base64>`; the verifier wants the base64 alone.
    const secret = config.sms.hookSecret.replace('v1,whsec_', '');
    const { user, sms } = new Webhook(secret)
      .verify(req.body.toString(), Object.fromEntries(Object.entries(req.headers)));

    await sendOtpSms({ phone: user.phone, otp: sms.otp });
    res.json({});
  } catch (err) {
    // MUST be non-2xx, and this is the opposite of the Meshy handler's deliberate swallow.
    // Supabase propagates a hook failure back out of signInWithOtp, where storefront.js already
    // turns it into a 502 the customer sees. Answering 200 on a failed send would tell them a
    // code is on its way when nothing was sent — they'd wait, then abandon the enquiry.
    console.error('Supabase SMS hook error:', err.message);
    res.status(500).json({ error: { http_code: 500, message: err.message } });
  }
});

export default router;
