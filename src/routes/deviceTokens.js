import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth, attachBakerContext } from '../middleware/auth.js';

// ── Where a device says "notify me" ──────────────────────────────────────────────────────────────
// Schema + the argument behind it: migrations/053_device_tokens.sql
//
// No capability check and no entitlement, deliberately. Registering the device you are already
// signed in on is not a privileged act — the token is useless to anyone else, and the notifications
// it will receive are ones this person is already emailed. Gating it behind store:manage would stop
// staff from being told about the orders they are the ones baking.

const router = Router();

const PLATFORMS = new Set(['web', 'android', 'ios']);

// ── POST /api/device-tokens ───────────────────────────────────────────────────────────────────────
// Called after the browser (or the app) obtains an FCM registration token. Safe to call on every
// load — the SDK returns the same token, and this upserts.
router.post('/device-tokens', requireAuth, attachBakerContext, async (req, res) => {
  try {
    if (!req.bakerId) return res.status(404).json({ error: 'No baker account found' });

    const token = String(req.body?.token ?? '').trim();
    if (!token) return res.status(400).json({ error: 'token is required' });
    // Bounded because it is written to an indexed column and arrives from a client. Real FCM tokens
    // are ~160-350 chars; 4096 is generous without being unbounded.
    if (token.length > 4096) return res.status(400).json({ error: 'token is too long' });

    const platform = String(req.body?.platform ?? 'web').toLowerCase();
    if (!PLATFORMS.has(platform)) return res.status(400).json({ error: 'unknown platform' });

    // UPSERT on the token, not insert. The same string arriving again is that device re-registering,
    // and re-pointing the row at whoever is signed in NOW is what hands a shop tablet over cleanly
    // instead of notifying both the old owner and the new one.
    const { error } = await supabase
      .from('device_tokens')
      .upsert({
        token,
        platform,
        baker_id:     req.bakerId,        // server-resolved, never from the client
        auth_user_id: req.user.id,        // ditto — the session says who this is
        last_seen_at: new Date().toISOString(),
      }, { onConflict: 'token' });
    if (error) return serverError(req, res, error);

    res.status(201).json({ registered: true });
  } catch (err) { serverError(req, res, err); }
});

// ── DELETE /api/device-tokens ─────────────────────────────────────────────────────────────────────
// Sign-out, or "stop notifying this device". Scoped to the caller's own token: deleting by token
// alone would let anyone who learned a token silence somebody else's phone.
router.delete('/device-tokens', requireAuth, async (req, res) => {
  try {
    const token = String(req.body?.token ?? '').trim();
    if (!token) return res.status(400).json({ error: 'token is required' });

    const { error } = await supabase
      .from('device_tokens')
      .delete()
      .eq('token', token)
      .eq('auth_user_id', req.user.id);
    if (error) return serverError(req, res, error);

    // Always 200, even when nothing matched. A device unregistering does not need to know whether it
    // was registered, and a 404 here would leak which tokens exist.
    res.json({ unregistered: true });
  } catch (err) { serverError(req, res, err); }
});

export default router;
