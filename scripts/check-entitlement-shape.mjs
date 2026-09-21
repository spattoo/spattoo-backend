#!/usr/bin/env node
// ── The entitlement VALUES are under `.ent`, and reading the wrapper is silent ───────────────────
//
// `getEntitlements(bakerId)` returns:
//
//     { planId, plan, status, active, ent, anchor }
//                                      ^^^ the values live here
//
// Read a key off the RESULT instead of off `.ent` and you get `undefined` — which is falsy, so
// every boolean entitlement reads as OFF and every numeric one as absent. Nothing throws. Nothing
// logs. The page renders. The only symptom is a paying baker quietly not getting what they pay for.
//
// ── IT HAS HAPPENED TWICE, MONTHS APART ─────────────────────────────────────────────────────────
//   2026-08  `grantWelcomeMessages` destructured the key off the result and refused every paying
//            baker their welcome credits. Written up in plans/message-recharge.md, which ends:
//            "Assume the next one is silent too."
//   2026-09  `getOrderAcceptance` returned `ent: e` — the whole wrapper — so `ent.premium_themes`
//            was undefined on the public storefront route and EVERY premium theme fell back to
//            Spotlight, on every plan. Found only because a real customer's shop looked wrong.
//
// Both were one word. Neither was catchable by the feature's own gate: `check:premium-themes`
// asserts `servedThemeKey` as a pure function against hand-written fixtures shaped the RIGHT way,
// so it proved the rule while the wiring that feeds it was wrong.
//
// Pure text reading. Run via `npm run check:entitlement-shape`.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
                      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `\n      ${extra}` : ''}`);
};

// ── 1. getOrderAcceptance hands over the VALUES ─────────────────────────────────────────────────
// It exists to save the public storefront route a second resolve, so what it passes on has to be
// the thing that route reads — not the wrapper it came in.
const ents = strip(read('src/services/entitlements.js'));
const acceptance = ents.slice(ents.indexOf('export async function getOrderAcceptance'));
const body = acceptance.slice(0, acceptance.indexOf('\n}') + 2);
ok(/ent:\s*\w+\.ent\b/.test(body),
   'getOrderAcceptance returns the entitlement VALUES (`ent: e.ent`)',
   'returning the whole getEntitlements result makes every key undefined at the call site');
ok(!/ent:\s*e\s*[,}]/.test(body),
   'getOrderAcceptance does not return the raw getEntitlements result',
   '`ent: e` is the 2026-09-21 production bug — every premium theme served as Spotlight');

// ── 2. Nobody reads an entitlement key straight off getEntitlements ─────────────────────────────
// The 2026-08 shape. `const { premium_themes } = await getEntitlements(id)` is always undefined.
const KEYS = Object.keys(
  Object.fromEntries(
    [...read('src/constants/entitlements.js').matchAll(/^\s{2}([a-z_]+):\s*\{/gm)].map(m => [m[1], 1]),
  ),
);
ok(KEYS.length > 5, 'the entitlement registry was read', `${KEYS.length} keys`);

const walk = (dir) => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? walk(join(dir, e.name)) : (e.name.endsWith('.js') ? [join(dir, e.name)] : []));

for (const file of walk('src')) {
  const text = strip(read(file));
  // `const { X, Y } = await getEntitlements(...)` where X or Y is an entitlement key.
  for (const m of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+getEntitlements\(/g)) {
    const named = m[1].split(',').map(x => x.trim().split(':')[0].trim());
    const wrong = named.filter(n => KEYS.includes(n));
    ok(wrong.length === 0,
       `${file} destructures an entitlement key straight off getEntitlements`,
       `"${wrong.join(', ')}" — the values are under .ent, so these read undefined (silently falsy)`);
  }
}

// ── 3. And the public storefront still reads it the right way ───────────────────────────────────
// The route that carried the bug. Named explicitly so a refactor cannot quietly restore it.
const sf = strip(read('src/routes/storefront.js'));
ok(/servedThemeKey\(\s*baker\.storefront_themes\s*,\s*ent\s*\)/.test(sf),
   'the public storefront passes the resolved entitlements to servedThemeKey');
ok(!/servedThemeKey\([^)]*\.ent\.ent/.test(sf),
   'and is not double-reaching through .ent.ent to paper over a wrapper');

console.log(failures
  ? `\n✗ check:entitlement-shape — ${failures} failure(s).`
  : '\n✓ check:entitlement-shape — entitlement values are read from .ent, never off the wrapper');
process.exit(failures ? 1 : 0);
