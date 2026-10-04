// ── Which rail skin a baker is actually SERVED ───────────────────────────────────────────────────
//
// Lifted in shape from lib/storefrontTheme.js, which solved the same problem for premium storefront
// themes and whose reasoning applies here unchanged:
//
//   RESOLVED AT RENDER, NEVER WRITTEN BACK. `baker_appusers.rail_skin` is left exactly as the baker
//   set it. Clearing it on downgrade would destroy a choice they made and turn re-subscribing into a
//   support ticket; resolving here means their skin returns the moment they are on Blaze again. It
//   also keeps the grace window right for free — `past_due` is not in BLOCKED_STATUSES, so a baker
//   with a failed card does not watch their rail change colour while they sort the payment out.
//
// ⚠️ WHERE IT DIFFERS FROM THE THEME, AND WHY. A storefront theme is CUSTOMER-FACING, which is why
// migration 054 refused to withhold one at render for months: taking away somebody's live shop
// because we re-priced a theme is not a thing a price change should do. A rail skin is seen by the
// baker alone. Nothing a customer sees depends on it, so there is no equivalent harm and no reason
// for the two events to be treated differently here.
//
// Pure, so `npm run check:rail-skins` can assert it without a database.

/** What everyone falls back to. Must match the row seeded `is_default` in migration 120. */
export const FALLBACK_RAIL_SKIN = 'chrome';

/**
 * @param {string|null} key                       baker_appusers.rail_skin, as stored
 * @param {{ key: string, is_premium: boolean }[]} skins  the rail_skins master rows
 * @param {{ rail_skins?: boolean }|null} ent     resolved entitlements for this baker
 * @returns {string} the skin key to draw
 */
export function servedRailSkin(key, skins = [], ent = null) {
  if (!key) return FALLBACK_RAIL_SKIN;
  const skin = skins.find(s => s.key === key);
  // An unknown key is a skin that was removed or retired after somebody chose it. The choice stays
  // in the column — the row may come back — but there is nothing to draw, so draw the default.
  if (!skin) return FALLBACK_RAIL_SKIN;
  // Only a premium skin can be withheld. A free one is served on every plan, which is the rule that
  // stops this becoming a second, quieter definition of who may use the app at all.
  if (!skin.is_premium) return skin.key;
  return ent?.rail_skins ? skin.key : FALLBACK_RAIL_SKIN;
}

/**
 * ⚠️ WCAG relative luminance, used by the gate to refuse an unreadable skin. Here rather than in the
 * script because the same arithmetic decides whether a skin may be SAVED — a baker picking one and
 * an admin authoring one must be told the same thing, and two copies of a contrast formula is how
 * one of them ends up lenient.
 */
export function contrastRatio(a, b) {
  const lum = ([r, g, b2]) => {
    const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b2);
  };
  const [la, lb] = [lum(a), lum(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `#rgb`, `#rrggbb` or `rgba(r,g,b,a)` → `[r,g,b,a]`. Null for anything it cannot read. */
export function parseColour(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  const h = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!h) return null;
  const x = h[1].length === 3 ? h[1].split('').map(c => c + c).join('') : h[1];
  return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16), 1];
}

/** Composite `fg` (with its own alpha) over opaque `bg`. */
export const over = ([r, g, b, a], [br, bg2, bb]) =>
  [a * r + (1 - a) * br, a * g + (1 - a) * bg2, a * b + (1 - a) * bb];

/**
 * The worst contrast this skin's ink achieves against any of its own stops. The ink is usually
 * translucent white, so it is composited over each stop before measuring — a half-opaque white on a
 * mid tone is NOT white, and measuring it as white is how a skin passes on paper and fails on screen.
 */
export function worstInkContrast({ stops = [], ink }) {
  const fg = parseColour(ink);
  const bgs = stops.map(parseColour).filter(Boolean);
  if (!fg || !bgs.length) return null;
  return Math.min(...bgs.map(bg => contrastRatio(over(fg, bg), bg)));
}

/** WCAG AA for small text. The rail's labels are 9px — this is the floor they need. */
export const MIN_RAIL_CONTRAST = 4.5;
