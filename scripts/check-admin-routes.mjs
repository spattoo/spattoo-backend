// SEC-0b — Admin-boundary regression guard.
// Privilege is a BOUNDARY, not a per-route decision: every `/api/admin/*` route is gated once at the
// mount in server.js (requireAuth + requireAdmin). For that backstop to actually cover a privileged
// route, the route must LIVE under /api/admin. This check fails if:
//   1. any route guarded by an admin-only capability sits outside /admin (→ boundary can't cover it), or
//   2. the boundary middleware is missing from server.js.
// Run in CI / pre-deploy: `npm run check:admin-routes`.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTES = join(ROOT, 'src', 'routes');

// Capabilities only INTERNAL admins should hold. A route guarded by one is a privileged/admin route.
const ADMIN_CAPS = new Set(['catalog:admin', 'subscription:override', 'baker:onboard', 'legal:manage']);
// Documented exceptions: privileged routes not under /admin. Currently NONE — every admin-capability
// route lives under /api/admin. (SEC-15 relocated the last straggler, the old /jobs/extract; that
// route has since been superseded by /admin/element-extract/*.) Kept as the
// escape-hatch so a deliberate future exception is explicit and any accidental stray still fails.
const EXEMPT = new Set([]);

// Span-based: split the file at each `router.<method>(` so each route's args (path + guards) are one
// span — robust to multi-line declarations where the path sits on its own line.
const declRe = /router\.(?:get|post|patch|put|delete)\(/g;
const capRe = /requireCapability\(\s*['"]([^'"]+)['"]\s*\)/g;
const firstStrRe = /['"]([^'"]+)['"]/;

const violations = [];
for (const file of readdirSync(ROUTES).filter(f => f.endsWith('.js'))) {
  const text = readFileSync(join(ROUTES, file), 'utf8');
  const starts = [...text.matchAll(declRe)].map(m => m.index);
  starts.forEach((start, k) => {
    const span = text.slice(start, starts[k + 1] ?? text.length);
    const path = span.match(firstStrRe)?.[1] ?? null;                       // first string after router.method( = the route path
    const caps = [...span.matchAll(capRe)].map(m => m[1]);
    const adminCap = caps.find(c => ADMIN_CAPS.has(c));
    if (adminCap && path && !path.startsWith('/admin') && !EXEMPT.has(path)) {
      const lineNo = text.slice(0, start).split('\n').length;
      violations.push(`${file}:${lineNo} — "${path}" uses admin capability '${adminCap}' but is not under /admin (the /api/admin boundary can't cover it)`);
    }
  });
}

const server = readFileSync(join(ROOT, 'src', 'server.js'), 'utf8');
if (!/app\.use\(\s*['"]\/api\/admin['"]\s*,\s*requireAuth\s*,\s*requireAdmin\s*\)/.test(server)) {
  violations.push("src/server.js — missing admin boundary guard: app.use('/api/admin', requireAuth, requireAdmin)");
}

if (violations.length) {
  console.error('✗ check:admin-routes — privileged routes not covered by the /api/admin boundary:');
  for (const v of violations) console.error('   - ' + v);
  process.exit(1);
}
console.log('✓ check:admin-routes — all admin-capability routes live under /api/admin (or are exempt); boundary present');
