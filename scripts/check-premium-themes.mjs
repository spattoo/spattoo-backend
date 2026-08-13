#!/usr/bin/env node
// ── Premium themes are withheld at RENDER, not only at CHOICE ─────────────────────────────────────
//
// The bug this locks down: a baker picks a premium theme on Blaze, downgrades to Flame, and keeps
// rendering it forever. Nothing resets storefront_theme_id, and until now the public storefront
// route never asked whether the plan still allowed it — the only gate was the 403 when CHOOSING one
// (routes/bakers.js). A downgrade never goes through that path, so it never hit the gate.
//
// It is worth a gate of its own because the failure is invisible from every angle you would look
// from: the row is correct, the write path is correctly guarded, the page renders, nobody errors.
// The only symptom is a Flame baker with a Blaze shop, and nothing would ever surface it.
//
// Pure function, no database — this asserts the RULE. Run: npm run check:premium-themes

import { servedThemeKey, FALLBACK_THEME_KEY } from '../src/lib/storefrontTheme.js';

let failed = 0;
const check = (label, got, want) => {
  if (got === want) return;
  failed++;
  console.error(`  ✗ ${label}\n      expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

const BASIC   = { key: 'spotlight',  is_premium: false };
const PREMIUM = { key: 'atelier',    is_premium: true  };
const BLAZE   = { premium_themes: true  };
const FLAME   = { premium_themes: false };

// ── The case that prompted this ─────────────────────────────────────────────────────────────────
check('premium theme + no entitlement → falls back',
  servedThemeKey(PREMIUM, FLAME), FALLBACK_THEME_KEY);
check('premium theme + entitlement → served',
  servedThemeKey(PREMIUM, BLAZE), 'atelier');

// ── A basic theme is never withheld ─────────────────────────────────────────────────────────────
// The rule must not quietly become a second definition of who may have a storefront at all — that
// decision belongs to getOrderAcceptance, which 404s before this is ever reached.
check('basic theme on a lower plan → served',
  servedThemeKey(BASIC, FLAME), 'spotlight');
check('basic theme with no entitlements at all → served',
  servedThemeKey(BASIC, null), 'spotlight');
check('basic theme with an empty entitlement set → served',
  servedThemeKey(BASIC, {}), 'spotlight');

// ── Absent data must not withhold anything ──────────────────────────────────────────────────────
// A baker with no theme has always been served the fallback; that is not a downgrade and must not
// start behaving like one.
check('no theme at all → fallback',
  servedThemeKey(null, FLAME), FALLBACK_THEME_KEY);
check('theme row with no is_premium flag → treated as basic',
  servedThemeKey({ key: 'aurora' }, FLAME), 'aurora');

// ── The premium + missing-entitlements combination ──────────────────────────────────────────────
// getEntitlements collapses every key to its fallback for a blocked subscription, and
// premium_themes falls back to false — so this is what an expired Blaze baker resolves to. They are
// 404'd earlier, but the rule must not depend on that happening first.
check('premium theme + null entitlements → falls back',
  servedThemeKey(PREMIUM, null), FALLBACK_THEME_KEY);
check('premium theme + undefined entitlements → falls back',
  servedThemeKey(PREMIUM, undefined), FALLBACK_THEME_KEY);

if (failed) {
  console.error(`\n✗ check:premium-themes — ${failed} rule(s) broken\n`);
  process.exit(1);
}
console.log('✓ check:premium-themes — a premium theme is served only with the entitlement');
