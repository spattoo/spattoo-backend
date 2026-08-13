// Account erasure lifecycle enums (DPDP "Layer 3"). See docs/CONSENT_WITHDRAWAL_AND_ERASURE_PLAN.md.
// deletion_status is a compact smallint on the hot `bakers` row (schema-scale rule) — translated
// to a readable label at the API boundary, never stored as text.

export const DELETION_STATUS = {
  ACTIVE:          0,   // normal
  PENDING_ERASURE: 1,   // soft-deleted; within the reversal window until erase_after
  ERASED:          2,   // personal data erased/anonymized by the scheduled job
  NAME_BY_ID: { 0: 'active', 1: 'pending_erasure', 2: 'erased' },
};

// Per-table erasure MANIFEST — the single declarative source of truth for what the erasure job
// nulls out, so erasure isn't ad-hoc DELETEs scattered per table (DRY). Each entry: a table, the
// column that scopes rows to a baker, and the PERSONAL columns to null. NON-personal / statutory
// data (financial rows, the accounting service) is intentionally absent — it is retained.
//
// ⚠️ REVIEW BEFORE GO-LIVE: completeness is a compliance requirement — a missed personal column =
// incomplete erasure. Extend this list as the schema grows; the job needs no code change.
export const ERASURE_MANIFEST = [
  { table: 'baker_appusers', bakerFk: 'baker_id', nullColumns: ['first_name', 'last_name', 'email', 'phone', 'phone_country'] },
  { table: 'customers',      bakerFk: 'baker_id', nullColumns: ['first_name', 'last_name', 'email', 'phone'] },
];
