# Feature Gating / Entitlements — Design

> Status: **design / not yet implemented.** The subscription data model already exists
> (`subscription_plans`, `baker_subscriptions`, the `get_baker_subscription` RPC, status/plan/period
> enums in `src/constants/`). What's missing is the **enforcement layer** described here.

## 1. The core model: two orthogonal layers

Gating is the **AND** of two independent systems:

- **RBAC (capabilities)** — *who the user is* within a baker (`owner` / `staff`). Positive-grant,
  role-based, DB-managed, already enforced via `requireCapability('store:manage')`. **Unchanged.**
- **Entitlements (plan features)** — *what the baker's plan unlocks* (spark / flame / blaze / forge).
  **New layer.**

```
allowed = hasCapability('template:manage')    // RBAC — who you are
        && hasEntitlement('custom_templates') // Plan — what you bought
```

These answer different questions and change independently — keep them separate; never fold plan logic
into RBAC.

## 2. Where entitlements live: data on the plan (NOT a code matrix by plan name)

Entitlement **values live on the plan row** (`subscription_plans.features jsonb`, already present,
currently `{}`). Code holds **only the key registry** (definition + plan-agnostic fallback). The
resolver keys on `plan.id` and never branches on plan name or rank.

Rationale: plans get renamed / reordered / added as the business evolves. Binding entitlement logic to
plan **names** (or rank math like `rank >= 2`) is fragile. `subscription_plans` is a **bounded lookup
(4 rows)**, so a jsonb column is the scale-correct store — no normalized entitlements table needed.

**Robustness:**

| Business change | Impact |
|---|---|
| Rename a plan's label (marketing) | edit `display_name` only — zero code, zero entitlement change |
| Rename the slug (`name`) too | resolver keys on `plan.id` (immutable surrogate) — still zero code |
| Add a new tier | admin creates it in `ManagePlans` + sets `features` — no deploy |
| Reorder / insert a mid-tier | nothing — entitlements are explicit per plan, not rank math |
| Add a new entitlement key | add one registry line; `fallback` applies to all plans until admin sets values |

**Conventions:** `subscription_plans.name` is the stable slug; `display_name` is the renameable label.
Bakers reference their plan by `subscription_plan_id` (surrogate FK). **Gating logic must never compare
plan names or ranks** — only explicit per-plan entitlement values.

## 3. Server-side (the authority)

### 3a. Entitlement registry — `src/constants/entitlements.js`

Definitions only, plan-agnostic (mirrors the other `src/constants/*.js` files):

```js
export const ENTITLEMENTS = {
  // booleans
  custom_branding:        { type: 'bool', fallback: false },
  custom_templates:       { type: 'bool', fallback: false },
  ai_background_removal:  { type: 'bool', fallback: false },
  whatsapp_notifications: { type: 'bool', fallback: false },
  custom_subdomain:       { type: 'bool', fallback: false },
  xray_reports:           { type: 'bool', fallback: false },
  // numeric limits — null = unlimited; conservative fallback until set
  max_orders_per_month:   { type: 'int',  fallback: 0 },
  max_team_members:       { type: 'int',  fallback: 1 },
};
```

### 3b. Resolver — `getEntitlements(bakerId)`

Builds on the existing `deriveSubscription()` (which already derives `expired` when `end_date` passes):

```js
async function getEntitlements(bakerId) {
  const sub = await deriveSubscription(bakerId);                  // existing RPC
  const features = (await getPlanFeatures(sub?.plan?.id)) ?? {};  // by plan.id, NOT name
  const blocked = ['expired', 'cancelled', 'paused'].includes(sub?.status);
  const ent = {};
  for (const [key, def] of Object.entries(ENTITLEMENTS)) {
    const raw = features[key] ?? def.fallback;                    // value lives on the plan
    ent[key] = blocked ? def.fallback : raw;                      // status collapse
  }
  // plan name returned for display/telemetry ONLY — never for gating
  return { planId: sub?.plan?.id, plan: sub?.plan?.name, status: sub?.status, ent };
}
```

**Status collapse** centralizes (server-side, authoritative) what the `CakeDesigner` paywall does
today for `expired` / `cancelled` / `paused`. Memoize the result on `req` so a request resolves once.

### 3c. Enforcement primitives (mirror `requireCapability`)

```js
// boolean gate — 403 with a structured, client-actionable error
const requireEntitlement = (key) => async (req, res, next) => {
  const { ent } = await ctxEntitlements(req);   // memoized on req
  if (!ent[key]) return res.status(403).json({
    error: 'Upgrade required', code: 'ENTITLEMENT_REQUIRED', entitlement: key,
  });
  next();
};

// numeric quota — checked inline at the action against a live usage count
async function assertQuota(req, key, currentCount) {
  const { ent } = await ctxEntitlements(req);
  const limit = ent[key];
  if (limit != null && currentCount >= limit) throw new QuotaError(key, limit);
}
```

Middleware order: `requireAuth` → `attachBakerContext` → `requireCapability(...)` →
`requireEntitlement(...)`.

### 3d. Enforcement points

| Gate | Route file | Type | Check |
|---|---|---|---|
| `custom_templates` | `templates.js` (create) | bool | `requireEntitlement('custom_templates')` |
| `max_orders_per_month` | `orders.js` (create) | quota | count this month's orders for `baker_id` vs limit |
| `max_team_members` | `customers.js` / staff invite | quota | count `baker_appusers` vs limit |
| `ai_background_removal` | bg-removal route | bool | `requireEntitlement(...)` |
| `custom_branding` | `bakers.js` profile PATCH | bool | gate logo/color fields |
| `custom_subdomain` / publish | `bakers.js` storefront | bool | `requireEntitlement(...)` |

Quota counts need indexes: `orders(baker_id, created_at)` (monthly count) and `baker_appusers(baker_id)`.

### 3e. Expose to the client

- Add `GET /api/baker/entitlements` → `{ planId, plan, status, ent }`.
- Also fold `ent` + `plan` + `status` into the existing `GET /api/baker/profile` response, so
  `BakerApp` receives entitlements in the call it already makes on mount.

### 3f. Validate `features` against the registry

`ManagePlans` and `PATCH /api/admin/subscription-plans/:id` must validate the submitted `features` JSON
against `ENTITLEMENTS` — reject unknown keys and wrong types. The registry is the single contract for
what is gateable.

## 4. Client-side (UX only — never the real gate)

1. `useEntitlements()` — reads `ent` / `plan` / `status` (already returned by `/api/baker/profile`)
   into baker context.
2. Combine with the existing `hasCap` in `CakeDesigner.jsx`:
   ```js
   const canSaveTemplate = hasCap('template:manage') && ent.custom_templates;
   {canSaveTemplate
     ? <button onClick={saveTemplate}>Save as Template</button>
     : <UpgradePrompt feature="custom_templates" />}
   ```
3. Handle the API `403 ENTITLEMENT_REQUIRED` → upgrade modal (covers UI-gate bypass). Extend the
   existing `blockedStatuses` paywall to read from `status`.
4. **Remove the hardcoded `PLAN_INFO` in `BillingPanel.jsx`** — derive the plan feature lists from the
   resolved entitlements so there is one source of truth (kills the current drift between `PLAN_INFO`
   and the DB `features` column).

## 5. Prerequisites / cleanups (do first)

1. **Apply the pending `supabase/baker_subscriptions_status_id.sql`** migration — standardize on
   `status_id smallint` (schema doctrine) before building enforcement on mixed text/int status.
2. **Confirm `bakers.subscription_status_id`** has a creating migration — code references it but none was
   found.
3. **Reconcile tier naming** — `OnboardBaker.jsx` still uses legacy `['trial','starter','pro',
   'enterprise']` while everything else is `spark/flame/blaze/forge`. Since `bakerProvisioning` already
   defaults new bakers to a Spark trial, drop the legacy tier picker; assign plans via
   `BakerSubscriptions`.

## 6. Build order

1. Prereqs (migrations + tier-naming cleanup).
2. `entitlements.js` registry + resolver + `requireEntitlement` / `assertQuota` (no behavior change yet).
3. Seed `subscription_plans.features` per plan (idempotent `ON CONFLICT`-style update); wire registry
   validation into `ManagePlans`.
4. Expose entitlements on `/api/baker/profile` + `/api/baker/entitlements`.
5. Apply gates route-by-route (start `custom_templates`, then order/team quotas).
6. Client `useEntitlements` + `UpgradePrompt` + 403 handling; de-dup `BillingPanel`.

## 7. Open decisions

- Confirm the **real per-plan entitlement values** to seed into `features` (the registry only defines
  keys/types/fallbacks; the actual numbers per plan are a business call — inferred starting points came
  from `BillingPanel` / `ManagePlans`).
- Confirm the initial **set of gateable keys** in the registry (the table above is the proposed
  starting menu).
```
