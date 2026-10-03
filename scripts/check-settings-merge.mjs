#!/usr/bin/env node
// ── two screens, one jsonb column ────────────────────────────────────────────────────────────────
//
// `bakers.settings` had one owner for its whole life — the Store Settings page — so writing the
// body verbatim was safe. The 2026-10-03 split ended that: store HOURS moved to the Store page and
// ORDERS & DELIVERY stayed in Settings, and both live in this column. A verbatim write means
// whichever screen saves last deletes the other's keys.
//
// That failure is silent. Nothing errors, nothing warns, and it surfaces later as "my delivery
// radius keeps resetting" — which nobody traces to a screen they were not on. Same shape as the
// replace-set bug spattoo-core's catalogue.test.jsx was written to prevent.
//
// Source assertions: the route needs Supabase and an authenticated request, so what is checkable
// here is that the merge is PRESENT and SHAPED right. Run via `npm run check:settings-merge`.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/routes/bakers.js', import.meta.url), 'utf8');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

// Isolate the handler, so a match anywhere else in a 1000-line router cannot stand in for one here.
const from = src.indexOf("router.put('/baker/settings'");
ok(from > -1, 'PUT /baker/settings still exists');
const route = src.slice(from, src.indexOf('\nrouter.', from + 10));

// ── the merge itself ─────────────────────────────────────────────────────────
ok(/\.select\('settings'\)/.test(route),
   'it reads the stored blob before writing one');
ok(/settings:\s*\{\s*\.\.\.\(existing\?\.settings \?\? \{\}\),\s*\.\.\.settings\s*\}/.test(route),
   'the write spreads the stored blob UNDER the incoming keys, so absent keys survive');

// ⚠️ Order matters and reads almost identically reversed. `{...incoming, ...existing}` would make
// every save a no-op — the stored value would win over the new one — which is the opposite bug and
// just as quiet.
// Read the patch LINE, not a brace-matched span: `?? {}` closes a brace inside the expression, so a
// `[^}]*` scan stops early and reports an ordering it never actually saw. (It did, first run.)
const patchLine = route.split('\n').find(l => l.includes('const patch =')) ?? '';
ok(patchLine.includes('...(existing?.settings') && patchLine.includes('...settings }'),
   'the patch line spreads both', patchLine.trim());
ok(patchLine.indexOf('existing?.settings') < patchLine.lastIndexOf('...settings'),
   'the INCOMING keys win, so a save actually saves', patchLine.trim());

// ── what must NOT be merged ──────────────────────────────────────────────────
// These are columns, not blob keys. They are pulled out before the merge and patched separately,
// and a merge that swallowed them would bury a real column as jsonb — two copies, one of them dead.
ok(/const \{ lead_time_days, delivery_radius_km, \.\.\.settings \} = req\.body/.test(route),
   'the two real columns are still pulled out of the body first');
ok(/patch\.lead_time_days = days/.test(route),      'lead_time_days is still written as a column');
ok(/patch\.delivery_radius_km =/.test(route),       'delivery_radius_km is still written as a column');

// ── one level, deliberately ──────────────────────────────────────────────────
// A deep merge would make a nested key impossible to REMOVE: `delivery` is an object and the screens
// write it whole when a baker switches something off inside it.
ok(!/deepMerge|mergeDeep|lodash\.merge/.test(route),
   'the merge is shallow — a deep one would make a nested key undeletable');

if (failures) {
  console.error(`\n✗ check:settings-merge — ${failures} failing`);
  process.exit(1);
}
console.log('✓ check:settings-merge — two screens share the blob; neither save erases the other');
