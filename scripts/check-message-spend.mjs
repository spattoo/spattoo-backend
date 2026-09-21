#!/usr/bin/env node
// ── A message is charged for once, after it was actually sent ────────────────────────────────────
//
// A baker buys messages in packs and a customer notification spends one. Three ways that goes wrong,
// and all three are silent — nothing throws, nothing logs, and the first sign is a baker counting
// their balance against their orders:
//
//   1. CHARGED FOR A MESSAGE THAT NEVER WENT. Debiting before the provider call, or on any status
//      other than 'sent', bills for a send the customer did not get. This is the worst of the three:
//      the baker cannot prove it, and the outbox says the send was skipped while the ledger says it
//      was paid for.
//   2. SENT FREE. No gate before the send, or a debit that only runs on some paths.
//   3. A REFUSAL TREATED AS A FAILURE. "No messages left" is not an error — the notification still
//      goes by email, which is free and always on. Returning `failed` would retry it forever and
//      mark the whole notification failed on a channel that was never going to work.
//
// Source assertions, because what is being pinned is the WIRING — which line runs before which — and
// the arithmetic itself is exercised against the real database when the ledger changes.
//
// Run via `npm run check:message-spend` (in `npm run check`).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sender  = readFileSync(join(ROOT, 'src/jobs/processors/sendNotification.js'), 'utf8');
const service = readFileSync(join(ROOT, 'src/services/messageBalance.js'), 'utf8');

// Comments describe these rules as often as the code does — the service says "CALLED AFTER A
// SUCCESSFUL SEND, NEVER BEFORE" in prose — so they are stripped before asking, or the documentation
// would satisfy the check for the thing it documents.
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
                     .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const s = code(sender);

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

// ── 1. The debit is after the send, and only on 'sent' ───────────────────────────────────────────
const sendAt  = s.indexOf('await sendTemplateMessage(');
const debitAt = s.indexOf('await spendMessage(');
ok(sendAt > 0, 'the sender still calls sendTemplateMessage');
ok(debitAt > 0, 'the sender still calls spendMessage');
ok(debitAt > sendAt, 'the debit runs AFTER the send, never before',
   'debiting first bills for a message the customer may never get');

// The guard on that line, read exactly: a debit that ran on any status would charge for a skip.
ok(/if \(payer && result\.status === 'sent'\)/.test(s),
   "the debit is guarded on result.status === 'sent'",
   "'skipped' means it never reached the provider; 'failed' means the provider refused it");

// ── 2. Nothing sends before the gate ─────────────────────────────────────────────────────────────
const gateAt = s.indexOf('await maySpendMessage(');
ok(gateAt > 0, 'the sender asks maySpendMessage before sending');
ok(gateAt < sendAt, 'the spend gate is checked BEFORE the provider call',
   'otherwise the message is sent and only then found to be unpayable');

// ── 3. A refusal is a skip, and only a customer message is billed ────────────────────────────────
ok(/if \(!may\.ok\) return skipped\(may\.reason/.test(s),
   'a refusal returns skipped(reason), never failed',
   'a failed status retries forever a send that will never be payable');

ok(/if \(forCustomer\) \{[\s\S]{0,200}?maySpendMessage/.test(s),
   'only a CUSTOMER notification is billed',
   "a baker paying to be told about their own bakery is absurd, and it is their own phone");

// ── 4. The service keeps its own half of the bargain ─────────────────────────────────────────────
const svc = code(service);
ok(/kind: 'debit', messages: -1/.test(svc),
   'a debit is exactly one message, and negative',
   'the balance is a SUM, so the sign is the arithmetic');
/* ⚠️ SCOPED TO spendMessage's OWN BODY, not "everything after it". This used to slice to the end of
   the file, which was the same thing only while spendMessage happened to be the LAST function in it
   — and that is a property of the file's layout, not of the rule. The first function appended after
   it (grantComplimentaryMessages, 2026-09-20, which throws on purpose because an admin is watching
   for the answer) failed this line without touching spendMessage at all.
   The first `}` at column 0 after the declaration closes the function: everything nested is
   indented, so this is exact rather than a guess. */
const spendFrom = svc.indexOf('export async function spendMessage');
const spendBody = svc.slice(spendFrom, svc.indexOf('\n}', spendFrom) + 2);
ok(spendFrom > 0 && spendBody.length > 0, 'spendMessage is findable in the service');
ok(!/throw/.test(spendBody),
   'spendMessage never throws',
   'the message has already gone; failing here retries a send that already happened');

// The gate must consult BOTH the baker's choice and their balance — one without the other either
// spends on a message they switched off, or sends one they have not paid for.
const gate = svc.slice(svc.indexOf('export async function maySpendMessage'));
ok(/enabledTypes\.includes\(typeSlug\)/.test(gate), 'the gate honours the baker\'s choice of messages');
ok(/getMessageBalance\(bakerId\)/.test(gate) && /balance <= 0/.test(gate),
   'the gate refuses at a zero balance');
ok(/payingBakerId\(payload\)/.test(gate), 'the gate resolves whose balance pays');

if (failures) {
  console.error(`\n✗ check:message-spend — ${failures} failure(s). This is money: a baker is charged`);
  console.error('   per message, and every one of these fails silently.');
  process.exit(1);
}
console.log('✓ check:message-spend — one message charged, after it was sent, only to the bakery that owes it');
