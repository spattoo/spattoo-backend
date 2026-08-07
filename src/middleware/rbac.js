import { supabase } from '../services/supabase.js';

// ── Role & capability resolution ──────────────────────────────────────────────
// Authorization is a POSITIVE grant. An unrecognized identity gets no role and
// no capabilities (deny-by-default) — it is NEVER inferred from the absence of a
// row. The role↔capability matrix lives in the DB so it can be managed from the
// admin UI; `admin` (is_super) holds every capability, including future ones.

const SUPER = '*';

// Resolve { role, bakerId, capabilities } for an authenticated Supabase user.
export async function loadPrincipal(user) {
  const userId = user.id;

  // 1. Admin? — explicit positive grant only.
  const { data: admin } = await supabase
    .from('admins')
    .select('role')
    .eq('auth_user_id', userId)
    .maybeSingle();

  let role = null;
  let bakerId = null;
  let customerId = null;
  let firstName = null;
  let lastName = null;

  if (admin) {
    role = admin.role; // 'admin' | 'admin_staff'
  } else {
    // 2. Baker app-user?
    const { data: appUser } = await supabase
      .from('baker_appusers')
      .select('baker_id, role, first_name, last_name')
      .eq('auth_user_id', userId)
      .maybeSingle();
    if (appUser) {
      role = appUser.role;        // 'owner' | 'staff'
      bakerId = appUser.baker_id;
      firstName = appUser.first_name;
      lastName = appUser.last_name;
    } else {
      // 3. Customer? Access is invite-gated: a verified contact only becomes a
      //    'customer' principal while a VALID invite exists. Baker context comes
      //    from that invite — there is no global customer session.
      const resolved = await resolveCustomer(user);
      if (resolved) {
        role = 'customer';
        bakerId = resolved.baker_id;
        customerId = resolved.customer_id;
        firstName = resolved.first_name;
        lastName = resolved.last_name;
      }
    }
  }

  return { role, bakerId, customerId, firstName, lastName, isAdmin: !!admin, capabilities: await capabilitiesForRole(role) };
}

// Match an OTP-verified session to a customer. Returns { customer_id, baker_id } or null.
//
// ── TWO WAYS IN, AND WHY THERE ARE NOW TWO ────────────────────────────────────
// 1. BOUND (checked first). A `customers` row carrying this auth_user_id. Set by
//    the invite verify AND by the storefront verify, both of which bind only when
//    unbound so a binding is never overwritten. This is an identity the DB itself
//    asserts — no contact matching, nothing to spoof.
// 2. INVITED (the original). Contact match plus a currently-valid invite.
//
// (2) alone described a product that no longer exists: it was written when a baker
// added a customer and invited them, and almost every customer now walks in through
// the storefront and serves themselves. Under (2) a self-service visitor got a
// session and NO role — so the 3D designer 401'd on every catalogue endpoint and
// rendered an empty cake. The comment this replaces said "there is no global
// customer session"; that was a decision for the invite era, not a law.
//
// ── WHAT (1) DOES NOT WEAKEN ─────────────────────────────────────────────────
// It is not a way to become a customer of a baker you have nothing to do with. The
// row must already exist for that baker, and only two paths write one: an invite,
// or verifying on that baker's own published storefront. Deny-by-default is intact
// — this adds a positive grant, it does not soften the absence of one.
//
// The baker_id it returns is NOT load-bearing for order routes: POST and GET
// /customer/orders re-resolve the customer themselves from (baker in the request,
// auth_user_id in the token). It matters for capabilities, which are per-ROLE and
// identical whichever baker won. Hence "most recent wins" for a contact that is a
// customer of several bakers — the same MVP rule the invite path already used, and
// no more load-bearing here than it was there.
export async function resolveCustomer(user) {
  // ── 1. Bound identity ───────────────────────────────────────────────────────
  const { data: bound } = await supabase
    .from('customers')
    .select('id, baker_id, first_name, last_name')
    .eq('auth_user_id', user.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (bound?.length) {
    const c = bound[0];
    return {
      customer_id: c.id,
      baker_id:    c.baker_id,
      first_name:  c.first_name ?? null,
      last_name:   c.last_name ?? null,
    };
  }

  // ── 2. Invited ──────────────────────────────────────────────────────────────
  if (!user.email && !user.phone) return null;

  // SEC-10: match with parameterised `.eq` (encoded by supabase-js), NEVER a string-built `.or()`
  // — a crafted verified email/phone could otherwise inject PostgREST filter syntax and broaden the
  // customer match. Two lookups (email, phone) merged + de-duped preserves the "email OR phone" set.
  const byId = new Map();
  const collect = async (column, value) => {
    const { data } = await supabase
      .from('customers').select('id, first_name, last_name').eq(column, value);
    for (const c of data ?? []) byId.set(c.id, c);
  };
  if (user.email) await collect('email', user.email);
  if (user.phone) await collect('phone', user.phone);

  const customers = [...byId.values()];
  if (!customers.length) return null;

  const nowIso = new Date().toISOString();
  const { data: invites } = await supabase
    .from('customer_invites')
    .select('customer_id, baker_id, expires_at')
    .in('customer_id', customers.map(c => c.id))
    .in('status', ['pending', 'sent', 'opened'])      // not completed/expired/revoked
    .order('created_at', { ascending: false });

  const valid = (invites ?? []).find(iv => !iv.expires_at || iv.expires_at > nowIso);
  if (!valid) return null;
  const match = customers.find(c => c.id === valid.customer_id);
  return {
    customer_id: valid.customer_id,
    baker_id: valid.baker_id,
    first_name: match?.first_name ?? null,
    last_name: match?.last_name ?? null,
  };
}

// Capability keys for a role. is_super → ['*'] (matches every capability).
export async function capabilitiesForRole(role) {
  if (!role) return [];

  const { data: roleRow } = await supabase
    .from('roles')
    .select('is_super')
    .eq('key', role)
    .maybeSingle();
  if (roleRow?.is_super) return [SUPER];

  const { data } = await supabase
    .from('role_capabilities')
    .select('capability_key')
    .eq('role_key', role);
  return (data ?? []).map(r => r.capability_key);
}

export function hasCapability(capabilities, cap) {
  return capabilities?.includes(SUPER) || capabilities?.includes(cap);
}

// Load the principal onto req ONCE (idempotent). Run after requireAuth. Shared by every guard
// below so the field-set never drifts (one place attaches req.role/bakerId/isAdmin/capabilities).
async function ensurePrincipal(req) {
  if (req.capabilities !== undefined) return;
  const p = await loadPrincipal(req.user);
  req.role = p.role;
  req.bakerId = p.bakerId;
  req.customerId = p.customerId;
  req.firstName = p.firstName;
  req.lastName = p.lastName;
  req.isAdmin = p.isAdmin;
  req.capabilities = p.capabilities;
}

// Middleware: attach req.role / req.bakerId / req.capabilities. Run after requireAuth.
export async function resolvePrincipal(req, res, next) {
  try { await ensurePrincipal(req); next(); } catch (err) { next(err); }
}

// Guard: requires a specific capability. Run after requireAuth; lazily resolves the principal:
//   router.post('/x', requireAuth, requireCapability('customer:manage'), handler)
export function requireCapability(cap) {
  return async (req, res, next) => {
    try {
      await ensurePrincipal(req);
      if (hasCapability(req.capabilities, cap)) return next();
      return res.status(403).json({ error: 'Forbidden', missing: cap });
    } catch (err) {
      next(err);
    }
  };
}

// Boundary guard: requires an INTERNAL admin principal (a row in `admins`, role admin/admin_staff),
// NOT merely someone who happens to hold an admin capability. Mounted ONCE at the `/api/admin`
// prefix (see server.js) so every admin route is gated at the boundary — a route can't forget it.
// Run after requireAuth. Per-route requireCapability still applies on top for finer grants.
export async function requireAdmin(req, res, next) {
  try {
    await ensurePrincipal(req);
    if (req.isAdmin) return next();
    return res.status(403).json({ error: 'Forbidden' });
  } catch (err) {
    next(err);
  }
}
