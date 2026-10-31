// ── Who may generate a 3D decoration ─────────────────────────────────────────────────────────────
//
// Blaze and above. Sandeep: *"generating the 3d elements is allowed from blaze and above
// subscription only."*
//
// This is a pure function with no database and no express in it, for the same reason
// `lib/storefrontTheme.js` is: the RULE is the part worth pinning down, and a rule expressed only
// as a chain of middleware on one route is a rule that the second route gets wrong. `routes/ai3d.js`
// has six routes already and the baker-facing ones are not written yet.
//
// ⚠️ IT IS NOT `requireEntitlement('generate_3d_decorations')`, AND THAT IS THE WHOLE POINT OF THE
// FILE. Two things that generic middleware gets wrong here:
//
//   1. STAFF HAVE NO PLAN. An admin is a row in `admins`; `ctxEntitlements` looks in
//      `baker_appusers`, finds nothing, and returns status 'no_baker' with active false. So
//      requireEntitlement on the admin studio's own route answers "your subscription is not
//      active" to a colleague who has no subscription and never will. Staff authority is a
//      capability (`catalog:admin`), resolved somewhere else entirely, and the two systems meet
//      here rather than in each route.
//   2. GENERATING AND SEEING ARE DIFFERENT QUESTIONS. Spending our money at a vendor is gated;
//      looking at a model you already made is not. Mixing them means a downgrade confiscates
//      finished work, which `premium_themes` already decided we do not do.
//
// The verdict carries its own status code so the route stays a one-liner and two routes cannot
// disagree about whether a lapsed subscription is a 402 or a 403.

export const GENERATE_3D_ENTITLEMENT = 'generate_3d_decorations';

/**
 * May this principal START a generation (which spends real money at a vendor)?
 *
 * @param {object}  p
 * @param {boolean} p.isAdmin  internal staff — a row in `admins` (req.isAdmin, set by rbac)
 * @param {boolean} p.active   subscription not expired/cancelled/paused (BLOCKED_STATUSES)
 * @param {object}  p.ent      RESOLVED entitlement VALUES — getEntitlements(...).ent, never the
 *                             wrapper. Reading a key off the wrapper is silently undefined; that
 *                             has reached production twice and `check:entitlement-shape` exists
 *                             because of it.
 * @returns {{ok: true, as: 'staff'|'baker'}
 *          |{ok: false, status: 402|403, code: string, entitlement?: string, error: string}}
 */
export function generate3dVerdict({ isAdmin = false, active = false, ent = null } = {}) {
  // Staff first, and before the subscription question rather than after it: they have no
  // subscription to be asked about. The catalogue team generates elements for the shared library,
  // which is our own cost centre, not a baker's plan.
  if (isAdmin) return { ok: true, as: 'staff' };

  // 402, not 403: authenticated and the plan may well include this — the subscription is the
  // problem. Mirrors middleware/entitlements.js so the client can keep one handler.
  if (!active) {
    return {
      ok: false, status: 402, code: 'SUBSCRIPTION_INACTIVE',
      error: 'Your subscription is not active.',
    };
  }

  // `=== true` rather than truthy, deliberately: the value arrives as jsonb off the plan row, and
  // the string "false" is truthy in JavaScript. A plan edited by hand in admin is the realistic way
  // that string gets there.
  if (ent?.[GENERATE_3D_ENTITLEMENT] !== true) {
    return {
      ok: false, status: 403, code: 'ENTITLEMENT_REQUIRED', entitlement: GENERATE_3D_ENTITLEMENT,
      error: 'Generating 3D decorations is available on Blaze and above.',
    };
  }

  return { ok: true, as: 'baker' };
}

/**
 * May this principal SEE generations they already made?
 *
 * Always yes, and this exists to say so out loud. A model a baker generated on Blaze is their work;
 * dropping to Flame stops them making new ones and takes nothing away. Written as a function rather
 * than a comment so `check:generate-3d` can hold it, because the tempting "tidy-up" is to put the
 * same guard on both routes and that tidy-up is a regression.
 *
 * Scoping — whose rows come back — is a WHERE clause on created_by in the route, not an
 * entitlement. This answers the plan question only.
 */
export function maySeeOwnGenerations() {
  return true;
}
