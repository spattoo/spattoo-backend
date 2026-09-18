#!/usr/bin/env node
// ── The preview a baker is shown must be the template that is actually sent ──────────────────────
//
// `constants/customerMessages.js` holds the body text Settings → Customer updates previews. The body
// a customer RECEIVES lives at Meta — approved there, uneditable afterwards, and not readable from
// any API we hold. So the constant is a COPY, and the specification it copies is
// `spattoo-docs/plans/whatsapp-templates.md`.
//
// ⚠️ WHY THIS MATTERS MORE THAN IT LOOKS. The preview is the entire reason a baker can be charged for
// these messages: they see the real words, the real sender, and decide. A preview that has drifted
// from the template is not a cosmetic bug — it means a baker paid on the strength of words their
// customer never receives, which is what plans/whose-name-is-on-the-message.md says makes this
// feature fair or unfair.
//
// And drift is the DEFAULT outcome, not an unlucky one: the two files live in different repositories.
// The first edit after the preview shipped already touched both — order_placed_customer stopped
// saying "has started an order for you" and started reading the order back — and it was correct in
// both places only because someone remembered. This is so the next one does not need to.
//
// ⚠️ WHAT IT DOES NOT CHECK: whether either matches what Meta actually approved. Nothing here can —
// Meta is the source of truth and is not machine-readable to us. This keeps our two copies honest
// with each other; keeping THEM honest with Meta is a human step, stated in the doc.
//
// Run via `npm run check:message-previews` (in `npm run check`).

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC  = resolve(ROOT, '..', 'spattoo-docs', 'plans', 'whatsapp-templates.md');

if (!existsSync(DOC)) {
  // A sibling checkout that is not there is not a failure — CI may build the API alone.
  console.log('✓ check:message-previews — skipped (spattoo-docs not checked out beside this repo)');
  process.exit(0);
}

const { CUSTOMER_MESSAGE_EVENTS } = await import('../src/constants/customerMessages.js');
const doc = readFileSync(DOC, 'utf8');

/* Meta's numbered placeholders are what differ between the two files BY DESIGN — the doc shows
   `{{3}}` where the preview shows a sample value — so the comparison is on the SHAPE: the fixed words
   around the gaps, with every gap collapsed to a single marker. */
const GAP = '';
const shape = (text) => text
  .replace(/\{\{\d+\}\}/g, GAP)
  .replace(/\s+/g, ' ')
  .trim();

/* The preview's sample values stand where the doc has placeholders. Listed explicitly rather than
   matched by a "any words" regex, which would collapse the fixed text too and make the check pass on
   anything. */
const SAMPLES = [
  '{bakery}', 'Asha', 'Rs. 1,499',
  'Home delivery: 20 September 2026, 2:30 PM',
  'Pickup: 20 September 2026, 2:30 PM',
  '20 September 2026, 2:30 PM',
  'Chocolate, Vanilla', '1.5 kg', 'Home delivery', 'Pickup',
];
/* ⚠️ COLLAPSE UNTIL STABLE, not once. Three placeholders in a row — the doc's `{{5}}: {{6}}` beside
   the gap on the line above — leave an odd one out after a single pass: the first replacement
   consumes gaps 1 and 2, and gap 3 is no longer adjacent to anything. The result was a "drift"
   between two identical templates, reported as `{}: {}` against `{}`. A gate that reports a
   difference that is not there is worse than no gate. */
const collapse = (t) => {
  const re = new RegExp(`${GAP}[ :]*${GAP}`, 'g');
  let out = t, prev;
  do { prev = out; out = out.replace(re, GAP); } while (out !== prev);
  return out;
};

const previewShape = (text) => {
  let t = text;
  for (const s of SAMPLES) t = t.split(s).join(GAP);
  return collapse(shape(t));
};

let failures = 0;
let checked = 0;

for (const e of CUSTOMER_MESSAGE_EVENTS) {
  /* The doc writes each body in a fenced block under a heading of the form
     `**A3 — \`temp_order_placed_customer\`** (…)`.

     ⚠️ ANCHOR ON THE HEADING, not on the slug anywhere. Two near-misses, both of which made this gate
     compare a template with somebody else's words and report a drift that did not exist:
       · a slug the doc does NOT specify gave indexOf -1, and `indexOf('**A', -1)` searches from 0 —
         so it matched the FIRST block on the page;
       · a slug that IS specified appears in the summary TABLE first, which sits above every block —
         so the next `**A` after it was A1, whichever template it belonged to.
     A gate that cries wolf gets switched off, so being precise here matters more than being short. */
  const head = new RegExp(`^\\*\\*A\\d+ — \`temp_${e.slug}\``, 'm').exec(doc);
  if (!head) continue;                          // not a template the doc specifies
  const fence = /```\n([\s\S]*?)\n```/.exec(doc.slice(head.index));
  if (!fence) continue;

  checked++;
  const want = collapse(shape(fence[1]));
  const got  = previewShape(e.body);
  if (want !== got) {
    failures++;
    console.error(`✗ ${e.slug} — the preview and the specified template have drifted:\n`);
    console.error(`   doc     : ${want.replaceAll(GAP, '{}')}`);
    console.error(`   preview : ${got.replaceAll(GAP, '{}')}\n`);
  }
}

if (failures) {
  console.error('   A baker decides to PAY on the strength of the preview. If it does not match the');
  console.error('   template, they paid for words their customer never receives.\n');
  console.error('   Fix BOTH: src/constants/customerMessages.js and');
  console.error('   spattoo-docs/plans/whatsapp-templates.md — then Meta, which neither file can check.');
  process.exit(1);
}
console.log(`✓ check:message-previews — ${checked} specified template(s) match the preview a baker is shown`);
