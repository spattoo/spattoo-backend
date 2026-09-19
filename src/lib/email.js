// ── One email shape, and one way of normalising it ───────────────────────────────────────────────
//
// `EMAIL_RE` lived as a local const in routes/customers.js, and POST /customer/orders was about to
// type a second one. Same reasoning as lib/uuid.js: a shape check standing in front of a database
// write does not fail loudly when a copy drifts — it lets a malformed address through, or turns a
// real one away.
//
// ⚠️ NORMALISE AND TEST TOGETHER, ALWAYS IN THAT ORDER. customers.js has always lower-cased and
// trimmed BEFORE testing, and it stores the normalised form. A second path that tested the raw
// string would accept "  Foo@Bar.com " and store a value that never matches a lookup for
// "foo@bar.com" — two rows for one person, discovered much later by a baker.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed and lower-cased, or null. The form that gets STORED. */
export const normalizeEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '') || null;

/** Is this a usable address? Normalises first, because that is what will be stored. */
export const isValidEmail = (v) => {
  const n = normalizeEmail(v);
  return !!n && EMAIL_RE.test(n);
};
