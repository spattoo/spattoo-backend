// GSTIN (Goods & Services Tax Identification Number) — 15 chars:
//   [2] state code · [10] PAN · [1] entity code · 'Z' · [1] checksum
// e.g. 36ABCDE1234F1Z5 (36 = Telangana). We validate structure + the checksum digit so a malformed
// number never lands on a legal invoice. Case-insensitive input is upper-cased by normalizeGstin.
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const CODE = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';   // base-36 alphabet used by the checksum

export function normalizeGstin(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

// The GSTIN checksum (last char): weighted mod-36 over the first 14 chars, alternating factor 1/2,
// with the "extra" carry from each product folded back in (the official CBIC algorithm).
function gstinChecksum(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CODE.indexOf(first14[i]);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CODE[(36 - (sum % 36)) % 36];
}

// true only for a structurally-valid GSTIN with a correct checksum.
export function isValidGstin(raw) {
  const g = normalizeGstin(raw);
  if (!GSTIN_RE.test(g)) return false;
  return gstinChecksum(g.slice(0, 14)) === g[14];
}

// The state code (first 2 digits) — the recipient's place of supply for a registered baker.
export function gstinStateCode(raw) {
  const g = normalizeGstin(raw);
  return GSTIN_RE.test(g) ? g.slice(0, 2) : null;
}
