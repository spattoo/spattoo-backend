// Cancellation reasons — surrogate ids mirror the cancellation_reasons master table
// (supabase/cancellation_reasons.sql). Code only needs the SYSTEM-attributed ids to write;
// the customer-selectable survey options are read from the DB (config-driven), never hardcoded
// into logic. Maps below cover all seeded rows for id<->key translation.
export const CANCELLATION_REASON = {
  UPGRADE:            1,
  DOWNGRADE:          2,
  ADMIN_EXTERNAL:     3,
  COMPLETED:          4,
  CUSTOMER_REQUESTED: 5,   // fallback when a voluntary cancel gives no survey reason
  ID_BY_KEY: {
    upgrade: 1, downgrade: 2, admin_external: 3, completed: 4, customer_requested: 5,
    too_expensive: 10, not_using: 11, missing_features: 12, switching: 13, other: 14,
  },
  KEY_BY_ID: {
    1: 'upgrade', 2: 'downgrade', 3: 'admin_external', 4: 'completed', 5: 'customer_requested',
    10: 'too_expensive', 11: 'not_using', 12: 'missing_features', 13: 'switching', 14: 'other',
  },
};
