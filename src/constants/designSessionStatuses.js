// Fixed enum → constant map (matches subscriptionStatuses.js). The lookup rows live in
// supabase/design_sessions.sql (design_session_statuses); these ids MUST stay in sync.
// The hot design_sessions table stores status_id (smallint); the API translates to `key`
// at the boundary so HTTP callers only ever speak keys, never magic numbers.
export const DESIGN_SESSION_STATUS = {
  ACTIVE:  1,
  ENDED:   2,
  EXPIRED: 3,
  ID_BY_KEY: { active: 1, ended: 2, expired: 3 },
  KEY_BY_ID: { 1: 'active', 2: 'ended', 3: 'expired' },
};
