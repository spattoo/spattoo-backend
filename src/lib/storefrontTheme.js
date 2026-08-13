// ── Which theme a storefront is actually SERVED with ──────────────────────────────────────────────
//
// A premium theme (storefront_themes.is_premium) needs the `premium_themes` entitlement, which is
// Blaze and above. Until now that was enforced only where a theme is CHOSEN (PATCH /baker/profile,
// a 403) and never where one is served — so a baker who picked a premium theme on Blaze and then
// downgraded to Flame kept rendering it indefinitely. Nothing resets storefront_theme_id and the
// public route never asked.
//
// ── WHY THAT GAP EXISTED, AND WHY IT NO LONGER APPLIES ────────────────────────────────────────────
// The absent check was deliberate, but for a DIFFERENT event. Migration 054 and the entitlement
// definition both argue the same case: if WE re-price a theme — flip an existing basic theme to
// premium — a baker who published on it months ago should not lose their shop's look because of
// something we did. That is fair, and it is not this.
//
// A downgrade is the baker's own action, and 054 says as much: "If that is ever wanted it needs its
// own decision and its own migration." This is that decision. Re-pricing an existing theme has been
// ruled out as something we will do, so the two events no longer share one absent check.
//
// ── RESOLVED AT RENDER, NEVER WRITTEN BACK ────────────────────────────────────────────────────────
// storefront_theme_id is left exactly as the baker set it. Nulling it on downgrade would destroy a
// choice they made and turn re-subscribing into a support ticket; resolving here means their theme
// simply returns the moment they are on Blaze again. It also keeps the grace window right for free:
// `past_due` is not in BLOCKED_STATUSES, so a baker with a failed card keeps their entitlements and
// their shop does not visibly go cheap while they sort the payment out.
//
// Pure so `npm run check:premium-themes` can assert it without a database.

// What a storefront falls back to. The same key the route has always defaulted to when a baker had
// no theme at all, so a downgrade lands on a page the codebase already renders everywhere.
export const FALLBACK_THEME_KEY = 'spotlight';

/**
 * @param {{ key?: string, is_premium?: boolean }|null} theme  the joined storefront_themes row
 * @param {{ premium_themes?: boolean }|null} ent               resolved entitlements for this baker
 * @returns {string} the theme key to serve
 */
export function servedThemeKey(theme, ent) {
  const key = theme?.key || FALLBACK_THEME_KEY;
  // Only a premium theme can be withheld. A basic theme is served to everyone, on every plan, in
  // every subscription state that gets this far — which is the rule that keeps this from becoming a
  // second, quieter definition of who may have a storefront at all.
  if (!theme?.is_premium) return key;
  return ent?.premium_themes ? key : FALLBACK_THEME_KEY;
}
