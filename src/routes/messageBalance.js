import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { requireAuth } from '../middleware/auth.js';
import { resolvePrincipal, requireCapability } from '../middleware/rbac.js';
import { withGst, gstBreakup } from '../lib/gst.js';
import {
  getMessageBalance, getMessageSettings, setMessageSettings,
  listMessagePacks, listMessageHistory, countMessagesSent,
} from '../services/messageBalance.js';
import { CUSTOMER_MESSAGE_EVENTS, MESSAGE_SENDER } from '../constants/customerMessages.js';
import { supabase } from '../services/supabase.js';

// ── Customer updates: the balance, the choices, the packs, the ledger ────────────────────────────
// Everything Settings → Customer updates reads. Sending and spending are not here — a message is
// debited by the notification sender, and that lands after the screen exists.
const router = Router();

const DAY = 86_400_000;

/* GET /api/baker/message-balance
 *
 * One call for the whole section: balance, what they chose, the packs, and what has gone out lately.
 * ⚠️ FOUR QUERIES IN PARALLEL rather than four round trips from the browser — this screen is opened
 * to answer "what have I got and what is it doing", and a balance that arrives before the usage makes
 * the number jump while someone is reading it. */
router.get('/baker/message-balance', requireAuth, resolvePrincipal, async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'Not a baker account' });
    const now = Date.now();

    const [balance, settings, packs, week, month, baker] = await Promise.all([
      getMessageBalance(req.bakerId),
      getMessageSettings(req.bakerId),
      listMessagePacks(),
      countMessagesSent(req.bakerId, new Date(now - 7 * DAY).toISOString()),
      countMessagesSent(req.bakerId, new Date(now - 30 * DAY).toISOString()),
      supabase.from('bakers').select('name').eq('id', req.bakerId).maybeSingle(),
    ]);

    /* ⚠️ THE BAKER'S OWN NAME GOES INTO THE PREVIEW, not a placeholder. A baker reading
       "{bakery} has sent you a quote" is reading a spec; reading "Feelings and Flavours has sent you
       a quote" is reading what their customer gets, which is the only version worth deciding on.
       Everything else in the preview stays a sample — a real price or date would imply we are quoting
       a real order. */
    const bakeryName = baker?.data?.name || 'Your bakery';
    const events = CUSTOMER_MESSAGE_EVENTS.map(e => ({
      ...e,
      body: e.body.replaceAll('{bakery}', bakeryName),
    }));

    res.json({
      balance,
      enabledTypes: settings.enabledTypes,
      everSaved:    settings.updatedAt != null,
      // Prices carry their tax breakup from the SAME function that will charge it, so the screen can
      // never quote a number the checkout then disagrees with (lib/gst.js).
      packs: packs.map(p => ({ ...p, totalPaise: withGst(p.basePaise), gst: gstBreakup(p.basePaise) })),
      sent: { last7Days: week, last30Days: month },
      events,
      // Shown in the preview on purpose: a baker paying for a message their customer sees branded
      // SPATOO should see that before they pay, not after.
      sender: MESSAGE_SENDER,
    });
  } catch (err) { serverError(req, res, err); }
});

/* PUT /api/baker/message-settings   { enabledTypes: string[] }
 *
 * ⚠️ `customer:manage` and not merely being a baker: this decides what a bakery's CUSTOMERS receive
 * and it spends the bakery's balance, so it is the same permission as managing those customers. */
router.put('/baker/message-settings', requireAuth, resolvePrincipal, requireCapability('customer:manage'),
  async (req, res) => {
    try {
      if (!req.bakerId) return res.status(403).json({ error: 'Not a baker account' });
      const wanted = req.body?.enabledTypes;
      if (!Array.isArray(wanted)) return res.status(400).json({ error: 'enabledTypes must be an array' });
      const saved = await setMessageSettings(req.bakerId, wanted);
      res.json(saved);
    } catch (err) {
      if (err?.status === 400) return res.status(400).json({ error: err.message });
      serverError(req, res, err);
    }
  });

/* GET /api/baker/message-history?before=<iso>
 *
 * Every message that went out, newest first. Paged by instant rather than offset: a ledger grows at
 * the top, so an offset page shifts under the reader between one "load more" and the next. */
router.get('/baker/message-history', requireAuth, resolvePrincipal, async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'Not a baker account' });
    const before = typeof req.query.before === 'string' ? req.query.before : null;
    const { rows, hasMore } = await listMessageHistory(req.bakerId, { before });
    res.json({
      entries: rows.map(r => ({
        id: r.id, kind: r.kind, messages: r.messages, packKey: r.pack_key,
        typeSlug: r.type_slug, channel: r.channel, recipient: r.recipient, createdAt: r.created_at,
      })),
      hasMore,
    });
  } catch (err) { serverError(req, res, err); }
});

export default router;
