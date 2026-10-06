// Masking a contact for display — "we sent a code to ••••3210".
//
// Lives here rather than beside its first caller because there are now two OTP flows that have to
// say the same sentence: the storefront's sign-in code, and an owner proving a new phone number
// (routes/account.js). Two copies of a masking rule is two different-looking confirmations of the
// same act, and the second one is always the one that drifts.
//
// These are for DISPLAY, not for secrecy: the person being shown the mask already typed the number.
// The point is to confirm the destination back to them, not to hide it from an attacker.

export function maskEmail(e) {
  if (!e) return null;
  const [u, d] = e.split('@');
  if (!d) return null;
  return `${u.slice(0, 1)}${'•'.repeat(Math.max(1, u.length - 1))}@${d}`;
}

export function maskPhone(p) {
  if (!p) return null;
  const digits = p.replace(/\D/g, '');
  return digits.length <= 4 ? p : `${'•'.repeat(digits.length - 4)}${digits.slice(-4)}`;
}
