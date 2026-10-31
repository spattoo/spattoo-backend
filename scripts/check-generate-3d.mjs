#!/usr/bin/env node
// ── Generating a 3D decoration is Blaze+, and the route has to ASK ───────────────────────────────
//
// Sandeep: *"generating the 3d elements is allowed from blaze and above subscription only."*
//
// Two halves, because the rule has two ways to go wrong and only one of them is a logic error.
//
// ── WHY THIS IS WORTH A GATE AT ALL ─────────────────────────────────────────────────────────────
// Every other paid flag in the registry is free for us to honour — a reel renders on the baker's
// own GPU, a rail skin is CSS. This one spends money at a vendor on the press of a button, and
// `routes/ai3d.js` does not import `services/aiCredits.js`, so nothing reserves, counts or refuses
// a single generation. There is no meter under it. The plan flag is the entire cost control, which
// means a route that forgets to ask is not a packaging mistake, it is an open tab at Tripo.
//
// ── AND WHY THE SECOND HALF IS NEEDED ───────────────────────────────────────────────────────────
// Today every ai3d route sits under `/api/admin`, which `server.js` gates with `requireAdmin` at
// the mount — so no baker can reach any of them and the rule is, right now, unreachable too. The
// baker-facing routes are not written yet. They will have to live OUTSIDE `/api/admin` (the way
// `uploads` does, for the same reason), and at that moment the only thing between a signed-in Spark
// baker and our vendor bill is whether somebody remembered this. A guard that is correct in a file
// nobody has written yet is worth nothing; this is what carries the decision across that gap.
//
// Pure text + pure function, no database. Run: npm run check:generate-3d

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generate3dVerdict, maySeeOwnGenerations, GENERATE_3D_ENTITLEMENT } from '../src/lib/generate3d.js';
import { ENTITLEMENTS } from '../src/constants/entitlements.js';

const ROOT   = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES = join(ROOT, 'src', 'routes');

let failed = 0;
const fail = (label, extra = '') => { failed++; console.error(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`); };
const eq = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) return;
  fail(label, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};
const ok = (cond, label, extra = '') => { if (!cond) fail(label, extra); };

// ── 1. The key is registered, and locked shut by default ────────────────────────────────────────
// fallback false is doing two jobs: a lapsed Blaze baker stops generating, and an environment that
// has not run migration 156 grants this to nobody rather than to everybody. For a flag with money
// behind it, "fails closed" is the only acceptable direction.
const def = ENTITLEMENTS[GENERATE_3D_ENTITLEMENT];
ok(def, `${GENERATE_3D_ENTITLEMENT} is in the entitlement registry`);
ok(def?.type === 'bool', `${GENERATE_3D_ENTITLEMENT} is a boolean`, `got ${def?.type}`);
ok(def?.fallback === false, `${GENERATE_3D_ENTITLEMENT} falls back to FALSE (fails closed)`,
   'a truthy fallback hands free generation to every lapsed and un-migrated plan');

// ── 2. The rule itself ──────────────────────────────────────────────────────────────────────────
const BLAZE  = { [GENERATE_3D_ENTITLEMENT]: true  };
const FLAME  = { [GENERATE_3D_ENTITLEMENT]: false };

eq('an active Blaze baker may generate',
   generate3dVerdict({ active: true, ent: BLAZE }), { ok: true, as: 'baker' });

eq('an active Flame baker may NOT — 403, naming the entitlement',
   generate3dVerdict({ active: true, ent: FLAME }),
   { ok: false, status: 403, code: 'ENTITLEMENT_REQUIRED', entitlement: GENERATE_3D_ENTITLEMENT,
     error: 'Generating 3D decorations is available on Blaze and above.' });

// A lapsed subscription collapses every key to its fallback, so this is also what an expired Blaze
// baker resolves to. 402 rather than 403: the plan is not the problem, the subscription is.
eq('a lapsed subscription may NOT — 402',
   generate3dVerdict({ active: false, ent: BLAZE }),
   { ok: false, status: 402, code: 'SUBSCRIPTION_INACTIVE', error: 'Your subscription is not active.' });

// ── 3. Absent and malformed data must never open the door ───────────────────────────────────────
// The realistic ways `ent` arrives wrong: the plan row has no such key (156 unrun), the caller
// passed the getEntitlements WRAPPER instead of `.ent` (undefined — the bug behind
// check:entitlement-shape, twice in production), or a hand-edit in Admin → Plans typed a string.
for (const [label, ent] of [
  ['no key on the plan row', {}],
  ['null entitlements',      null],
  ['undefined entitlements', undefined],
  ['the string "true"',      { [GENERATE_3D_ENTITLEMENT]: 'true' }],
  ['the string "false"',     { [GENERATE_3D_ENTITLEMENT]: 'false' }],
  ['the number 1',           { [GENERATE_3D_ENTITLEMENT]: 1 }],
]) {
  ok(generate3dVerdict({ active: true, ent }).ok === false,
     `${label} → refused`,
     'a non-boolean must not be read as a grant; "false" is a truthy string');
}
ok(generate3dVerdict({}).ok === false, 'an empty principal is refused');

// ── 4. Staff are not asked about a subscription they cannot have ─────────────────────────────────
// An admin is a row in `admins`, never in `baker_appusers`, so ctxEntitlements resolves them to
// status 'no_baker' / active false. Under plain requireEntitlement the catalogue team gets "your
// subscription is not active", which is both wrong and unactionable.
eq('internal staff may generate with no plan at all',
   generate3dVerdict({ isAdmin: true, active: false, ent: null }), { ok: true, as: 'staff' });
eq('and are reported AS staff, not as a baker',
   generate3dVerdict({ isAdmin: true, active: true, ent: BLAZE }).as, 'staff');

// ── 5. Generating is gated; SEEING what you already made is not ─────────────────────────────────
// Same split as premium_themes, which gates choosing a theme and never rendering one a live shop
// already runs. A downgrade stops new spending; it does not confiscate finished work.
ok(maySeeOwnGenerations() === true, 'a baker can always open their own past generations');

// ── 6. A baker-facing generate route must consult the rule ──────────────────────────────────────
// Span-based, matching check-admin-routes' house style: split at each `router.<method>(` so a
// multi-line declaration still reads as one span.
const declRe     = /router\.(?:get|post|patch|put|delete)\(/g;
const firstStrRe = /['"]([^'"]+)['"]/;
// A path that starts a generation. `/mine`, `/:id` and the segment/split routes are not spending
// routes and are deliberately not matched.
const GENERATES  = /(ai3d|3d)[^'"]*generat|generat[^'"]*(ai3d|3d)/i;

for (const file of readdirSync(ROUTES).filter(f => f.endsWith('.js'))) {
  const text   = readFileSync(join(ROUTES, file), 'utf8');
  const starts = [...text.matchAll(declRe)].map(m => m.index);
  starts.forEach((start, k) => {
    const span = text.slice(start, starts[k + 1] ?? text.length);
    const path = span.match(firstStrRe)?.[1] ?? '';
    if (!GENERATES.test(path)) return;
    // Under /admin the mount-time requireAdmin boundary in server.js already excludes every baker,
    // and staff spend is not plan-gated. Anywhere else, the route is reachable by a baker session.
    if (path.startsWith('/admin')) return;
    const lineNo = text.slice(0, start).split('\n').length;
    ok(/generate3dVerdict|GENERATE_3D_ENTITLEMENT|requireGenerate3d/.test(span),
       `${file}:${lineNo} — "${path}" starts a generation outside /admin without asking lib/generate3d.js`,
       'a baker session reaches this; every call spends real money at the vendor and nothing meters it');
  });
}

if (failed) {
  console.error(`\n✗ check:generate-3d — ${failed} rule(s) broken\n`);
  process.exit(1);
}
console.log('✓ check:generate-3d — 3D generation is Blaze+, fails closed, and staff are exempt');
