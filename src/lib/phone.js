// Use the FULL ("max") metadata, not the default "min" bundle — "min" only does loose
// length checks and wrongly accepts junk like "123123123" / over-length numbers for IN.
// "max" enforces real per-country patterns (India = 10 digits, valid prefix).
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

// Normalise a free-text phone number into canonical E.164 + ISO-3166 country.
// Single source of truth for phone validation across every write path (admin
// onboarding, self-signup, and any future profile-edit route) — so the stored
// shape and the "valid?" verdict never drift between callers.
//
//   normalizePhone('98765 43210', 'IN')  → { ok: true, e164: '+919876543210', country: 'IN' }
//   normalizePhone('+1 415 555 2671')    → { ok: true, e164: '+14155552671',  country: 'US' }
//   normalizePhone('', 'IN')             → { ok: false, error: 'Phone number is required' }
//   normalizePhone('123', 'IN')          → { ok: false, error: 'Enter a valid phone number' }
//
// `defaultCountry` (ISO-2) is the region used to interpret numbers written without
// a "+<dialcode>" prefix; an explicit "+…" always wins. Defaults to India.
export function normalizePhone(input, defaultCountry = 'IN') {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: 'Phone number is required' };

  const parsed = parsePhoneNumberFromString(raw, (defaultCountry || 'IN').toUpperCase());
  if (!parsed || !parsed.isValid()) {
    return { ok: false, error: 'Enter a valid phone number' };
  }
  return { ok: true, e164: parsed.number, country: parsed.country ?? defaultCountry };
}
