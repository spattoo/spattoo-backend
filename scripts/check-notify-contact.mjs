// ── If you select a customer's email to notify them, select their phone too ──────────────────────
//
// Customer email is OPTIONAL. `POST /orders/manual` — a baker typing in a walk-in or a phone call —
// requires `customer.phone` OR `customer.email`, so a customer with only a phone is the normal shape
// on that route, not an edge. Since 097 a notification may carry a null `recipient_email`, and the
// five customer notify functions ask `reachable(customer)` — email OR phone — instead of email alone.
//
// ⚠️ WHICH MOVES THE FAILURE INTO THE SELECT, WHERE NOTHING WOULD HAVE CAUGHT IT. `reachable` reads
// `customer.phone`. A PostgREST projection that names `customers(email, first_name)` returns a row
// with no `phone` key at all — not null, absent — so `reachable` says false, the notify function
// returns early, and a phone-only customer gets nothing. Exactly the old bug, with the fix in place
// and looking correct.
//
// It is not hypothetical: all five call sites were written that way, and all five were found by
// reading them rather than by running anything. No test fails. The notification is simply never
// created, so there is no row to assert about and no error to see.
//
// THE RULE: in a route that notifies, a `customers(...)` projection naming `email` must also name
// `phone`. Selecting the email says "I am going to contact this person", and contacting them now
// means either address.
//
// Run via `npm run check:notify-contact` (in `npm run check`).

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'src/routes');

// An embedded projection: customers( … ) inside a .select(). Not `from('customers')`, which is a
// table read with its own column list and no notification behind it.
const PROJECTION = /customers\(([^()]*)\)/g;

const problems = [];
for (const file of readdirSync(DIR).filter(f => f.endsWith('.js'))) {
  const path = join(DIR, file);
  const lines = readFileSync(path, 'utf8').split('\n');

  lines.forEach((line, i) => {
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
    for (const m of line.matchAll(PROJECTION)) {
      const cols = m[1].split(',').map(c => c.trim().split(':').pop().trim());
      if (!cols.includes('email') || cols.includes('phone')) continue;
      problems.push({ file, line: i + 1, cols: m[0] });
    }
  });
}

if (problems.length) {
  console.error('✗ check:notify-contact — a customer is selected by email alone:\n');
  for (const p of problems) {
    console.error(`   ${relative(ROOT, join(DIR, p.file))}:${p.line}`);
    console.error(`      ${p.cols}`);
    console.error('      → add `phone`. Without it the row has NO phone key, `reachable()` in');
    console.error('        services/notifications.js reads undefined, and a customer who has only a');
    console.error('        phone number silently receives nothing at all — no row, no bell, no SMS.');
  }
  console.error('\n   Customer email is optional; POST /orders/manual takes phone OR email.');
  process.exit(1);
}

console.log('✓ check:notify-contact — every customer selected by email is selected by phone too');
