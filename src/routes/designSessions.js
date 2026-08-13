import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability, resolvePrincipal } from '../middleware/rbac.js';
import { DESIGN_SESSION_STATUS as ST } from '../constants/designSessionStatuses.js';

// ── Live co-design sessions ────────────────────────────────────────────────────
// The DURABLE source of truth behind the Supabase Realtime channel `session:<id>`:
// who holds the pen (edit baton), the last-persisted design, and the lifecycle.
// The live design itself flows over Realtime (Phase 1 client); this API is what
// starts a room, gates membership, arbitrates the pen, persists for durability, and
// ends the room. Design-state broadcast/apply is client-side and not routed here.
//
// Membership (Phase 0): a staff member of the session's baker, OR the session's
// customer. The anonymous read-only spectator is Phase 2 (needs a scoped token).

const router = Router();

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // hard expiry; a repeatable job sweeps to status=expired (never an in-proc timer)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const channelFor = (id) => `session:${id}`;

function serializeSession(s) {
  return {
    id: s.id,
    channel: channelFor(s.id),
    baker_id: s.baker_id,
    customer_id: s.customer_id,
    order_id: s.order_id,
    status: ST.KEY_BY_ID[s.status_id] ?? null,   // translate surrogate id → readable key at the boundary
    host_user_id: s.host_user_id,
    editor_user_id: s.editor_user_id,            // who holds the pen (null = nobody)
    design_snapshot: s.design_snapshot ?? null,
    created_at: s.created_at,
    last_active_at: s.last_active_at,
    ended_at: s.ended_at,
    expires_at: s.expires_at,
  };
}

async function loadSession(id) {
  if (!id || !UUID_RE.test(id)) return null;
  const { data } = await supabase.from('design_sessions').select('*').eq('id', id).maybeSingle();
  return data ?? null;
}

// Is the authenticated principal (already resolved onto req) a member of this session?
// A baker-staff member of the session's baker, or the session's bound customer.
function isParticipant(req, session) {
  if (req.customerId && session.customer_id && req.customerId === session.customer_id) return true;
  if (req.role && req.role !== 'customer' && req.bakerId && session.baker_id && req.bakerId === session.baker_id) return true;
  return false;
}

// Does an auth.users id belong to a participant of this session? Used to validate a `grant` target.
async function isParticipantUserId(session, userId) {
  if (!userId) return false;
  if (session.customer_id) {
    const { data: c } = await supabase
      .from('customers').select('id').eq('id', session.customer_id).eq('auth_user_id', userId).maybeSingle();
    if (c) return true;
  }
  const { data: u } = await supabase
    .from('baker_appusers').select('id').eq('baker_id', session.baker_id).eq('auth_user_id', userId).maybeSingle();
  return !!u;
}

// ── Start a session ─────────────────────────────────────────────────────────────
// Baker or customer (both hold design:create). The host holds the pen to start.
// Body: { order_id?, customer_id?, design? }.
router.post('/design-sessions', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const bakerId = req.bakerId;
    if (!bakerId) return res.status(403).json({ error: 'No baker context for this account' });

    const { order_id = null, customer_id = null, design = null } = req.body ?? {};

    // If finalizing an existing order, it must belong to this baker (tenancy).
    if (order_id) {
      const { data: order } = await supabase
        .from('orders').select('id, baker_id').eq('id', order_id).maybeSingle();
      if (!order || order.baker_id !== bakerId) return res.status(404).json({ error: 'Order not found' });
    }

    // The customer being co-designed with (if the baker names one up front) must be theirs.
    // A customer host binds themselves; a baker host may pass the customer explicitly.
    let boundCustomer = req.customerId ?? null;
    if (!boundCustomer && customer_id) {
      const { data: cust } = await supabase
        .from('customers').select('id, baker_id').eq('id', customer_id).maybeSingle();
      if (!cust || cust.baker_id !== bakerId) return res.status(404).json({ error: 'Customer not found' });
      boundCustomer = customer_id;
    }

    const insert = {
      baker_id: bakerId,
      customer_id: boundCustomer,
      order_id,
      status_id: ST.ACTIVE,
      host_user_id: req.user.id,
      editor_user_id: req.user.id,   // host starts with the pen
      design_snapshot: design ?? null,
      expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    };
    const { data, error } = await supabase.from('design_sessions').insert(insert).select('*').single();
    if (error) return serverError(req, res, error);
    res.status(201).json(serializeSession(data));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Get session state (hydrate a joiner / late joiner) ───────────────────────────
router.get('/design-sessions/:id', requireAuth, resolvePrincipal, async (req, res) => {
  try {
    const session = await loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!isParticipant(req, session)) return res.status(403).json({ error: 'Not a participant of this session' });
    res.json(serializeSession(session));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Persist the live design (durability; editor only) ────────────────────────────
// The pen holder periodically flushes the current design so late joiners hydrate and
// the room survives a reload. The live stream itself is Realtime, not this route.
router.put('/design-sessions/:id/design', requireAuth, resolvePrincipal, async (req, res) => {
  try {
    const { design } = req.body ?? {};
    if (design == null) return res.status(400).json({ error: 'design is required' });

    const session = await loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!isParticipant(req, session)) return res.status(403).json({ error: 'Not a participant of this session' });
    if (session.status_id !== ST.ACTIVE) return res.status(409).json({ error: 'Session is not active' });
    if (session.editor_user_id !== req.user.id) return res.status(409).json({ error: 'You do not hold the pen' });

    const { data, error } = await supabase.from('design_sessions')
      .update({ design_snapshot: design, last_active_at: new Date().toISOString() })
      .eq('id', session.id).select('*').single();
    if (error) return serverError(req, res, error);
    res.json(serializeSession(data));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Pen (edit-baton) control ─────────────────────────────────────────────────────
// Body: { action: 'take' | 'release' | 'grant', to?: <auth.users id> }.
//  take    — become the editor. Free if nobody holds it; a baker-staff member can always
//            reclaim (override) so the baker can take the pen back at any time.
//  release — the current editor drops the pen (nobody editing).
//  grant   — the current editor hands the pen to another participant.
router.post('/design-sessions/:id/pen', requireAuth, resolvePrincipal, async (req, res) => {
  try {
    const { action, to = null } = req.body ?? {};
    const session = await loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!isParticipant(req, session)) return res.status(403).json({ error: 'Not a participant of this session' });
    if (session.status_id !== ST.ACTIVE) return res.status(409).json({ error: 'Session is not active' });

    const me = req.user.id;
    const isBakerStaff = !!req.role && req.role !== 'customer';
    let editor;

    if (action === 'take') {
      if (session.editor_user_id && session.editor_user_id !== me && !isBakerStaff) {
        return res.status(409).json({ error: 'Someone else holds the pen' });
      }
      editor = me;
    } else if (action === 'release') {
      if (session.editor_user_id !== me) return res.status(409).json({ error: 'You do not hold the pen' });
      editor = null;
    } else if (action === 'grant') {
      if (session.editor_user_id !== me) return res.status(409).json({ error: 'You do not hold the pen' });
      if (!(await isParticipantUserId(session, to))) return res.status(400).json({ error: 'Target is not a participant' });
      editor = to;
    } else {
      return res.status(400).json({ error: "action must be 'take', 'release', or 'grant'" });
    }

    const { data, error } = await supabase.from('design_sessions')
      .update({ editor_user_id: editor, last_active_at: new Date().toISOString() })
      .eq('id', session.id).select('*').single();
    if (error) return serverError(req, res, error);
    res.json(serializeSession(data));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── End the session ──────────────────────────────────────────────────────────────
router.post('/design-sessions/:id/end', requireAuth, resolvePrincipal, async (req, res) => {
  try {
    const session = await loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (!isParticipant(req, session)) return res.status(403).json({ error: 'Not a participant of this session' });
    if (session.status_id === ST.ENDED || session.status_id === ST.EXPIRED) {
      return res.json(serializeSession(session));   // idempotent
    }
    const { data, error } = await supabase.from('design_sessions')
      .update({ status_id: ST.ENDED, ended_at: new Date().toISOString(), editor_user_id: null })
      .eq('id', session.id).select('*').single();
    if (error) return serverError(req, res, error);
    res.json(serializeSession(data));
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
