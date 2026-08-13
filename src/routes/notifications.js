import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth, attachBakerContext } from '../middleware/auth.js';
import { linkFor } from '../lib/notificationLink.js';

// ── The notification centre ──────────────────────────────────────────────────────────────────────
// Schema + the argument behind it: migrations/057_notification_centre.sql
//
// A READ over the outbox. Every row the bell shows was already being written — this adds no new
// event, no new pipeline and no new failure mode. Which is why it is a small file.
//
// No capability check: these are notifications addressed to this bakery, and anyone signed in as
// part of it is already an intended recipient. Gating on store:manage would hide a new enquiry from
// the staff member who is the one baking it.

const router = Router();

const PAGE_MAX = 50;

// ── GET /api/notifications ───────────────────────────────────────────────────────────────────────
// The bell and the list, in one call: the page of notifications plus the unread count. One request
// because the header wants the count on every load and a second round trip for one integer is worse
// than a slightly wider response.
router.get('/notifications', requireAuth, attachBakerContext, async (req, res) => {
  try {
    if (!req.bakerId) return res.status(404).json({ error: 'No baker account found' });

    const limit = Math.min(Number(req.query.limit) || 20, PAGE_MAX);

    // Baker-audience only. `order_placed_customer` is a real notification about this bakery's order
    // and is addressed to the CUSTOMER — showing it here would be showing a baker their own outbox.
    const { data, error } = await supabase
      .from('notifications')
      .select('id, payload, created_at, read_at, notification_types!inner ( slug, label, audience )')
      .eq('baker_id', req.bakerId)
      .eq('notification_types.audience', 'baker')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return serverError(req, res, error);

    const { count, error: countErr } = await supabase
      .from('notifications')
      .select('id, notification_types!inner ( audience )', { count: 'exact', head: true })
      .eq('baker_id', req.bakerId)
      .eq('notification_types.audience', 'baker')
      .is('read_at', null);
    if (countErr) return serverError(req, res, countErr);

    res.json({
      unread: count ?? 0,
      notifications: (data ?? []).map(n => ({
        id:        n.id,
        type:      n.notification_types.slug,
        label:     n.notification_types.label,
        payload:   n.payload,
        createdAt: n.created_at,
        readAt:    n.read_at,
        // Resolved SERVER-side from the shared helper, so the bell and the push that preceded it
        // cannot disagree about where a notification goes.
        link:      linkFor(n.notification_types.slug, n.payload),
      })),
    });
  } catch (err) { serverError(req, res, err); }
});

// ── POST /api/notifications/read ─────────────────────────────────────────────────────────────────
// Body: { ids?: [] } — omit ids to mark everything read ("mark all as read").
//
// Idempotent, and only ever moves unread → read: `.is('read_at', null)` means a second call cannot
// rewrite the timestamp of something read yesterday, so a double-tap does not make an old
// notification look freshly handled.
router.post('/notifications/read', requireAuth, attachBakerContext, async (req, res) => {
  try {
    if (!req.bakerId) return res.status(404).json({ error: 'No baker account found' });

    let q = supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      // Tenant-scoped in the QUERY. Marking by id alone would let anyone who guessed a bigint mark
      // another bakery's notifications read — silent, and exactly the kind of thing nobody reports.
      .eq('baker_id', req.bakerId)
      .is('read_at', null);

    const ids = req.body?.ids;
    if (Array.isArray(ids)) {
      if (!ids.length) return res.json({ marked: 0 });
      q = q.in('id', ids.slice(0, PAGE_MAX));
    }

    const { data, error } = await q.select('id');
    if (error) return serverError(req, res, error);

    res.json({ marked: (data ?? []).length });
  } catch (err) { serverError(req, res, err); }
});

export default router;
