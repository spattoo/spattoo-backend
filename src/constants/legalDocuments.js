// Legal documents + consent-log enums (DPDP "Layer 2"). See docs/CONSENT_CAPTURE_PLAN.md.
// The doc_key values MUST match `docKey` in spattoo-web/apps/marketing/lib/legal.ts — the
// stable key a consent record references. NEVER rename one (it would orphan past consents).

export const LEGAL_DOC_KEYS = ['tos', 'privacy', 'refund', 'grievance'];

// Documents a baker must actively AGREE to (checkbox / first-login gate). The others are
// informational (surfaced, not gated).
export const CONSENT_REQUIRED_DOC_KEYS = ['tos', 'privacy'];

// Who is consenting. Compact smallint stored on consent_events.subject_type.
export const CONSENT_SUBJECT_TYPE = {
  BAKER_APPUSER: 1,
  CUSTOMER:      2,
  NAME_BY_ID: { 1: 'baker_appuser', 2: 'customer' },
};

// Accept vs withdraw. A withdrawal is a NEW append-only row, never an update.
export const CONSENT_ACTION = {
  ACCEPTED:  1,
  WITHDRAWN: 2,
  NAME_BY_ID: { 1: 'accepted', 2: 'withdrawn' },
};

// Where the consent event was captured. `ID_BY_NAME` maps an API string → the stored smallint.
// Applies to withdrawals too (action=2): SETTINGS = the Privacy & Data screen toggle,
// ACCOUNT_CLOSURE = the WITHDRAWN row appended when a baker requests account deletion.
export const CONSENT_SOURCE = {
  SIGNUP:          1,   // self-signup checkbox
  GATE:            2,   // first-login acceptance gate
  RECONSENT:       3,   // re-prompt after a version bump
  QUOTE:           4,   // customer, at storefront quote submission (future)
  SETTINGS:        5,   // withdraw an optional consent from the Privacy & Data screen
  ACCOUNT_CLOSURE: 6,   // withdrawal recorded as part of account deletion
  ID_BY_NAME: { signup: 1, gate: 2, reconsent: 3, quote: 4, settings: 5, account_closure: 6 },
  NAME_BY_ID: { 1: 'signup', 2: 'gate', 3: 'reconsent', 4: 'quote', 5: 'settings', 6: 'account_closure' },
};
