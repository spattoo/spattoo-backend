// ── Tenant-scope guard for print_sheets ─────────────────────────────────────────────────────────
// A saved print sheet belongs to ONE bakery. Every read, write and delete must therefore be filtered
// by `baker_id`, and every route must be behind auth + capability + the plan entitlement.
//
// WHY A GATE AND NOT TRUST. This codebase has already paid for a scoping mistake once: uploads used
// to be `cake_elements` rows scoped by a single `customer_id` that meant two things at once, and a
// baker uploading a customer's photo got `customer_id = NULL` — "shared with the tenant" — so a
// child's photograph appeared in every other customer's decoration picker. The scoping CODE was
// correct; nothing checked that it was applied everywhere. (supabase/baker_uploads.sql)
//
// A missing `.eq('baker_id', …)` here fails exactly that way: silently, correctly-looking, and only
// visible once one bakery is reading another's work. Tests would not catch it either — a single-
// tenant fixture passes whether or not the filter is there.
//
// Run via `npm run check:print-sheets` (in `npm run check`).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'src', 'routes', 'printSheets.js');

const text = readFileSync(FILE, 'utf8');
const violations = [];

// ── 1. Every route carries all three guards ──────────────────────────────────────────────────────
// Split at each `router.<method>(` so one route's args are one span, the same technique
// check-admin-routes uses for multi-line declarations.
const spans = text.split(/router\.(?:get|post|patch|put|delete)\(/).slice(1);
if (!spans.length) violations.push('no routes found — did the file move?');

for (const span of spans) {
  const head = span.slice(0, span.indexOf('async (req'));
  const path = span.match(/['"]([^'"]+)['"]/)?.[1] ?? '(unknown)';
  for (const guard of ['requireAuth', 'requireCapability', 'requireEntitlement']) {
    if (!head.includes(guard)) violations.push(`${path} — missing ${guard}`);
  }
  if (!head.includes("requireEntitlement('edible_print_studio')")) {
    violations.push(`${path} — entitlement must be 'edible_print_studio'`);
  }
}

// ── 2. Every print_sheets query filters by baker_id ──────────────────────────────────────────────
// Each `.from('print_sheets')` opens a chain that ends at the await. Checking the text between this
// one and the next (or the end) keeps a filter belonging to one query from vouching for another.
const froms = [...text.matchAll(/\.from\(\s*['"]print_sheets['"]\s*\)/g)].map(m => m.index);
if (!froms.length) violations.push("no .from('print_sheets') calls found — did the table name change?");

// Two ways to be scoped, because an INSERT has nothing to filter: a read/update/delete NARROWS by
// baker_id, an insert SETS it. Both must name `req.bakerId` — the session's bakery — and neither is
// satisfied by the other, so the check accepts either form and nothing else.
const NARROWS = /\.eq\(\s*['"]baker_id['"]\s*,\s*req\.bakerId\s*\)/;
const SETS    = /baker_id\s*:\s*req\.bakerId\b/;

froms.forEach((start, i) => {
  const chain = text.slice(start, froms[i + 1] ?? text.length);
  if (!NARROWS.test(chain) && !SETS.test(chain)) {
    const line = text.slice(0, start).split('\n').length;
    violations.push(
      `print_sheets query at line ${line} — neither .eq('baker_id', req.bakerId) nor baker_id: req.bakerId`,
    );
  }
});

// ── 3. baker_id is never taken from the request body ─────────────────────────────────────────────
// It is resolved from the session by attachBakerContext. A sheet that could name its own tenant is
// a cross-tenant write dressed up as a save.
if (/baker_id\s*:\s*req\.body/.test(text)) {
  violations.push('baker_id is being read from req.body — it must come from req.bakerId');
}

if (violations.length) {
  console.error('✗ check:print-sheets — tenant scoping is not guaranteed:\n');
  for (const v of violations) console.error(`   • ${v}`);
  console.error('\n   Every print_sheets route: requireAuth + requireCapability +');
  console.error("   requireEntitlement('edible_print_studio'), and every query .eq('baker_id', req.bakerId).");
  process.exit(1);
}

console.log('✓ check:print-sheets — every route is gated and every query is tenant-scoped');
