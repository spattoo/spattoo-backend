// Entitlement registry — DEFINITIONS only (plan-agnostic). The actual per-plan
// VALUES live as data on the plan row (subscription_plans.features jsonb), so the
// resolver never branches on plan name/rank and renaming/restructuring plans needs
// no code change. `fallback` is the conservative value used when a plan hasn't set
// a key yet, and the value an inactive subscription collapses to.
//   bool → false (locked) | int → a safe floor (0 = none, 1 = the minimum)
// null in a plan's features means "unlimited" for an int key (see resolver).
// `label` is the human name shown in the admin plan editor (registry-driven form).
export const ENTITLEMENTS = {
  // booleans
  storefront:             { type: 'bool', fallback: false, label: 'Public storefront' },                       // {slug}.spattoo.com — now ON for all tiers
  custom_branding:        { type: 'bool', fallback: false, label: 'Custom branding (logo/colours/story)' },     // now ON for all tiers
  custom_templates:       { type: 'bool', fallback: false, label: 'Custom templates (deprecated)' },            // superseded by max_saved_templates; inert
  ai_background_removal:  { type: 'bool', fallback: false, label: 'AI background removal' },
  whatsapp_notifications: { type: 'bool', fallback: false, label: 'WhatsApp notifications (deferred)' },        // #20 — off all tiers; inert
  xray_reports:           { type: 'bool', fallback: false, label: 'X-Ray reports' },
  // numeric limits — null (in a plan's features) = unlimited
  max_team_members:       { type: 'int',  fallback: 1, label: 'Team members' },
  max_saved_templates:    { type: 'int',  fallback: 0, label: 'Saved templates (custom)' },                     // Spark 3 / Flame 30 / Blaze+ unlimited
  // "My Decorations" uploads. Counts BOTH the baker's shared library AND their customers' private
  // uploads (both sit in the baker's tenant).
  //
  // NOT a pricing lever — it is set to the SAME generous number on every plan, on purpose. Once
  // background removal is our own model rather than a metered vendor, an upload costs us essentially
  // nothing (R2 storage is ~$0.015/GB-month with zero egress; the inference is our own CPU on a box we
  // pay a flat rate for). Charging for something with no marginal cost is an arbitrary limit that only
  // generates support tickets.
  //
  // It exists as a CEILING: element:manage is granted to customers, so the upload endpoint is reachable
  // from a public storefront, and an unbounded write path is not something to discover after the fact.
  // A real baker will never approach it; a runaway client will. If it ever needs to become a tier lever,
  // the machinery is already here — change the numbers, no deploy.
  max_custom_elements:    { type: 'int',  fallback: 0, label: 'Own decorations (upload ceiling)' },
};

// Non-entitlement plan CONFIG that also lives in subscription_plans.features (read by
// provisioning, NOT by the entitlement resolver). Surfaced in the admin plan editor so it
// stays editable alongside entitlements.
export const PLAN_CONFIG = {
  trial_days: { type: 'int', fallback: 30, label: 'Spark trial (days)' },
};

// Flat, ordered schema for the admin plan editor — key/type/label/fallback per field,
// tagged by section. The form renders bool→checkbox, int→number+"unlimited". The registry
// is the single source of truth, so a new key here automatically grows a new form field.
export function planEditorSchema() {
  const fields = (obj, section) =>
    Object.entries(obj).map(([key, def]) => ({ key, type: def.type, label: def.label, fallback: def.fallback, section }));
  return { entitlements: fields(ENTITLEMENTS, 'entitlement'), config: fields(PLAN_CONFIG, 'config') };
}

// Subscription statuses that DENY access (the coarse gate). past_due / pending are
// intentionally NOT here — they're a grace/dunning window (mirrors the client
// paywall, which only blocks expired/cancelled/paused).
export const BLOCKED_STATUSES = new Set(['expired', 'cancelled', 'paused', 'no_subscription']);
