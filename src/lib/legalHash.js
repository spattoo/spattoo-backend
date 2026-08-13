import { createHash } from 'node:crypto';

// Integrity hash for a published legal document version (DPDP "Layer 2").
// See docs/CONSENT_CAPTURE_PLAN.md §3.
//
// UNKEYED sha256 — deliberately NO HMAC key, NO salt. The hash must be INDEPENDENTLY
// reproducible: an auditor/court can re-hash the frozen text and confirm it matches. A key
// would require our secret to verify (destroys that) and buys no non-repudiation against
// ourselves since we own the store. Notarization-grade proof (digital signature / RFC-3161
// timestamp) is a later add-on, not HMAC.
//
// What matters instead is CANONICALIZATION: hash a fixed byte form so the recorded hash
// always reproduces. Apply canonicalizeLegalText() identically at publish and at
// re-verification. Hash the FINAL, token-substituted published text (what the user saw),
// not the raw markdown with {{PLACEHOLDERS}}.
export function canonicalizeLegalText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')      // strip a leading UTF-8 BOM
    .replace(/\r\n?/g, '\n')     // normalize CRLF / CR → LF
    .replace(/[ \t]+$/gm, '')    // trim trailing spaces/tabs on each line
    .replace(/\s+$/, '\n');      // collapse trailing blank lines to a single newline
}

export function legalContentHash(text) {
  return createHash('sha256').update(canonicalizeLegalText(text), 'utf8').digest('hex');
}
