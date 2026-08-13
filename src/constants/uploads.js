// Uploads — the enums stored as compact surrogates on baker_uploads (schema-scale rule: the table
// grows with every design, so a smallint rides every row and every index, never a text key). Callers
// still speak strings: translate at the API boundary, same convention as constants/legalDocuments.js.

// WHO clicked upload. Note this is authorship, NOT ownership — `baker_uploads.for_customer_id` says
// whose upload it is. The two diverge exactly when a baker uploads on a customer's behalf (the photo
// she sent over WhatsApp), which is the case the old model got wrong.
export const UPLOADED_BY = {
  BAKER_APPUSER: 1,
  CUSTOMER:      2,
  NAME_BY_ID: { 1: 'baker', 2: 'customer' },
};

// Only a baker's OWN upload may be released into the library. A customer's may not — ToS 6.2 licenses
// their Content "solely ... to carry out the actions you direct", and their photo becoming furniture in
// other customers' pickers is not an action they directed. See supabase/baker_uploads.sql.
//
// A named predicate, not an inline `=== 1` at the call site: when a SECOND release surface appears (a
// marketplace listing, a shared template), it asks the same question rather than inventing its own.
export function promotable(upload) {
  return upload?.uploaded_by_type === UPLOADED_BY.BAKER_APPUSER;
}
