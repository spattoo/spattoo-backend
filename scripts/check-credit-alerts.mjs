#!/usr/bin/env node
// ── when we warn a baker, and when we keep quiet ──────────────────────────────
// An alert nobody wants is worse than no alert: the first one a baker ignores is the one that
// teaches them to ignore the next, including the one that mattered. Most of the rules here are
// therefore about staying SILENT, and every one of them is a case that would otherwise send mail
// to someone who is perfectly fine.
//
// Pure — creditAlerts.js imports nothing at all, so this needs no database, queue or clock.
// Run via `npm run check:credit-alerts` (or the aggregate `npm run check`).
import { creditWarningLevel, istMonthStart, LOW_WATERMARK } from '../src/services/creditAlerts.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

// A plan with 800 monthly credits and nothing bought.
const at = (usedPct, extra = {}) => creditWarningLevel({
  active: true, unlimited: false, allowance: 800,
  allowanceUsed: Math.round(800 * usedPct), walletBalance: 0, ...extra,
});

// ── the thresholds ───────────────────────────────────────────────────────────
ok(at(0.00) === null,        'a fresh month says nothing');
ok(at(0.50) === null,        'half used says nothing');
ok(at(0.79) === null,        'just under the watermark says nothing', String(at(0.79)));
ok(at(0.80) === 'low',       'exactly at the watermark warns', String(at(0.80)));
ok(at(0.95) === 'low',       'still "low" at 95%', String(at(0.95)));
ok(at(1.00) === 'exhausted', 'all used is a DIFFERENT message', String(at(1.00)));
ok(at(1.40) === 'exhausted', 'over-spent (a straddle) is still exhausted', String(at(1.40)));
ok(LOW_WATERMARK === 0.8,    'the watermark is 80%', String(LOW_WATERMARK));

// ── the suppressions, which are most of the value ────────────────────────────
// Bought credits change the situation completely: the monthly allowance running out is a
// bookkeeping event for someone holding a wallet, and the tools keep working. These bakers are
// also the ones who top up — so without this rule, the people who have paid us MORE would be the
// ones getting the most "you are running out" mail.
ok(at(1.00, { walletBalance: 800 }) === null,
   'a full month of bought credits suppresses it entirely');
ok(at(1.00, { walletBalance: 801 }) === null,
   'more than a month of bought credits suppresses it');
ok(at(1.00, { walletBalance: 799 }) === 'exhausted',
   'just under a month of bought credits still warns', String(at(1.00, { walletBalance: 799 })));
ok(at(0.85, { walletBalance: 50 }) === 'low',
   'a small wallet does not suppress the low warning');

// Unlimited has no line to cross; a countdown that never moves cannot run out.
ok(at(1.00, { unlimited: true }) === null, 'unlimited never warns');

// A lapsed plan resolves to allowance 0, which without this guard reads as "100% used" — every
// lapsed baker would get an exhausted email, forever, on any code path that checked.
ok(creditWarningLevel({ active: false, allowance: 0, allowanceUsed: 0 }) === null,
   'a lapsed baker is not warned about credits');
ok(creditWarningLevel({ active: true, allowance: 0, allowanceUsed: 0 }) === null,
   'a zero allowance warns about nothing');
ok(creditWarningLevel({}) === null, 'an empty balance says nothing rather than throwing');

// ── the month boundary ───────────────────────────────────────────────────────
// The dedupe key. It must agree with the ledger's IST month start (migration 022) or a baker
// could be warned twice across a boundary, or not at all.
const IST = 5.5 * 3600 * 1000;
// 31 Aug 2026, 23:00 IST — still August.
ok(istMonthStart(Date.UTC(2026, 7, 31, 23, 0) - IST) === '2026-08-01',
   'late on the last day is still this month', istMonthStart(Date.UTC(2026, 7, 31, 23, 0) - IST));
// 1 Sep 2026, 00:30 IST — a new month, and the previous claim must stop matching.
ok(istMonthStart(Date.UTC(2026, 8, 1, 0, 30) - IST) === '2026-09-01',
   'just after midnight IST is the new month', istMonthStart(Date.UTC(2026, 8, 1, 0, 30) - IST));
// The trap: 1 Sep 2026, 02:00 IST is still 31 AUGUST in UTC. A naive UTC month start would keep
// the August claim alive and swallow September's first warning.
ok(istMonthStart(Date.UTC(2026, 7, 31, 20, 30)) === '2026-09-01',
   'an instant that is still August in UTC is September in IST',
   istMonthStart(Date.UTC(2026, 7, 31, 20, 30)));

if (failures) {
  console.error(`\n✗ check:credit-alerts — ${failures} failure(s)`);
  process.exit(1);
}
console.log('✓ check:credit-alerts — thresholds, wallet suppression and the IST month boundary all hold');
