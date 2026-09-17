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

/* ── And no notify function may DECIDE on the email alone ────────────────────────────────────────
 *
 * ⚠️ THE SECOND SHAPE, added after it got through. The 097 pass fixed five functions spelled
 * `if (!customer?.email) return` and walked straight past `notifyOrderPlaced`, which is the same
 * mistake written inside-out — `if (customer.email) { insert… }`. A grep for one shape does not find
 * the other, and neither does the projection rule above: the select was fine, the decision was not.
 * A customer who gave a phone and no email simply got no "we have your order".
 *
 * So the rule is on the QUESTION, not the spelling: in the notify service, a customer's email may be
 * PASSED as the delivery address, never ASKED as the test for whether to notify. `reachable()` is
 * the one test.
 */
const SERVICE = join(ROOT, 'src/services/notifications.js');
/* ⚠️ Block comments are BLANKED, line count preserved — not skipped by how a line starts. The note
   above this very rule quotes `if (!customer?.email) return` as the thing it forbids, on a
   continuation line with no leading `*`, and the first cut of this check flagged its own
   documentation. Prose about a rule must never be able to trip the rule. */
const blanked = readFileSync(SERVICE, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
blanked.split('\n').forEach((line, i) => {
  const t = line.trim();
  if (!t || t.startsWith('//')) return;
  // A condition that tests a customer's email. Passing it (`customer.email ?? null`) is fine.
  if (!/\b(if|\?|&&|\|\|)\b[^\n]*customer\??\.email\b/.test(line)) return;
  if (/reachable\s*\(/.test(line)) return;
  if (/\?\?\s*null/.test(line)) return;          // `customer.email ?? null` — an address, not a test
  problems.push({ file: 'services/notifications.js', line: i + 1, cols: t,
                  why: 'decides whether to notify from the email alone' });
});

if (problems.length) {
  console.error('✗ check:notify-contact — a customer is reachable only by email:\n');
  for (const p of problems) {
    console.error(`   src/${p.file.startsWith('services') ? '' : 'routes/'}${p.file}:${p.line}`);
    console.error(`      ${p.cols}`);
    if (p.why) {
      console.error(`      → ${p.why}. Use \`reachable(customer)\` — email OR phone — and pass`);
      console.error('        `customer.email ?? null` as the address. A phone-only customer is the');
      console.error('        normal shape on POST /orders/manual, not an edge case.');
    } else {
      console.error('      → add `phone`. Without it the row has NO phone key, `reachable()` in');
      console.error('        services/notifications.js reads undefined, and a customer who has only a');
      console.error('        phone number silently receives nothing at all — no row, no bell, no SMS.');
    }
  }
  console.error('\n   Customer email is optional; POST /orders/manual takes phone OR email.');
  process.exit(1);
}

console.log('✓ check:notify-contact — customers are selected by phone as well as email, '
  + 'and no notify function decides from the email alone');
