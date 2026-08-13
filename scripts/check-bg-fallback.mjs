#!/usr/bin/env node
// ── when our outage becomes remove.bg's bill ──────────────────────────────────
// Every rule here is a rule about spending money automatically, in the one situation where nobody is
// watching: our own service is down. The failure this guards against is not "the fallback didn't
// work" — it is "the fallback worked so well that it ran for three days and nobody noticed".
//
// Pure — bgFallbackPolicy.js imports nothing at all, so this needs no network, no config and no
// real clock. Run via `npm run check:bg-fallback` (or the aggregate `npm run check`).
import {
  failureKind, freshBreaker, breakerOpen, afterFailure, afterSuccess,
  freshCap, capReached, afterFallback, istDayKey,
  BREAKER_TRIP_AFTER, BREAKER_COOLDOWN_MS, DEFAULT_DAILY_CAP,
} from '../src/services/bgFallbackPolicy.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

// ── whose fault was it ───────────────────────────────────────────────────────
// The expensive mistake is calling a metered vendor for a failure the vendor will also have.
ok(failureKind(null) === 'outage',  'no response at all is our outage', String(failureKind(null)));
ok(failureKind(500) === 'outage',   '500 is our outage');
ok(failureKind(502) === 'outage',   '502 (a dead Render service) is our outage');
ok(failureKind(503) === 'outage',   '503 is our outage');
ok(failureKind(408) === 'outage',   '408 is transient, not a verdict on the bytes');
ok(failureKind(429) === 'outage',   '429 from an edge is transient too');

ok(failureKind(400) === 'request',  'a 400 is the BYTES — the vendor would fail too, for money');
ok(failureKind(401) === 'request',  'a 401 is our own misconfiguration, and paying will not fix it');
ok(failureKind(413) === 'request',  'too large stays too large at remove.bg');
ok(failureKind(415) === 'request',  'not-an-image stays not-an-image');

// ── the breaker ──────────────────────────────────────────────────────────────
// Consecutive, not a rate: one failure among successes is a bad image or a blip, and tripping on
// that would route healthy traffic to a paid vendor.
let b = freshBreaker();
ok(!breakerOpen(b, 1000), 'a fresh breaker is closed');

b = afterFailure(b, 1000);
ok(!breakerOpen(b, 1000), 'one failure does not trip it');
b = afterFailure(b, 1001);
ok(!breakerOpen(b, 1001), 'two failures do not trip it', `tripAfter=${BREAKER_TRIP_AFTER}`);
b = afterFailure(b, 1002);
ok(breakerOpen(b, 1002), 'the third consecutive failure trips it');

ok(breakerOpen(b, 1002 + BREAKER_COOLDOWN_MS - 1), 'it stays open through the cooldown');
ok(!breakerOpen(b, 1002 + BREAKER_COOLDOWN_MS), 'it closes once the cooldown elapses — we retry our own service');

// A success anywhere resets the count completely, so an unrelated blip later cannot inherit it.
let c = afterFailure(afterFailure(freshBreaker(), 1), 2);
c = afterSuccess(c);
ok(c.consecutiveFailures === 0, 'a success clears the failure count', String(c.consecutiveFailures));
c = afterFailure(c, 3);
ok(!breakerOpen(c, 3), 'so the next single failure does not trip a breaker that had 2 old ones');

// ── the daily ceiling ────────────────────────────────────────────────────────
// An outage lasts as long as it takes us to notice. Uncapped, that is our downtime converted into a
// vendor invoice at ~₹15 an image.
const noon = Date.parse('2026-08-03T06:30:00Z');        // 12:00 IST
let cap = freshCap();
ok(!capReached(cap, noon, 3), 'a fresh day is under the cap');

cap = afterFallback(cap, noon);
cap = afterFallback(cap, noon);
ok(!capReached(cap, noon, 3), 'two of three is still under');
cap = afterFallback(cap, noon);
ok(capReached(cap, noon, 3), 'the third reaches it and we stop paying');

// Past the ceiling the cut-out fails rather than costing money — the upload studio already lets the
// baker save the image as-is, which is a worse decoration but not a worse day than a surprise bill.
ok(capReached(cap, noon, 0), 'a cap of 0 disables the fallback outright');
ok(capReached(freshCap(), noon, 0), 'even with nothing spent yet');

// ── the day boundary is IST, not UTC ─────────────────────────────────────────
// The cap is a decision about money, so it should roll over at midnight where the business is.
// 18:45 UTC is already the NEXT day in IST (00:15), and a UTC-keyed counter would keep charging
// against yesterday's exhausted budget for five and a half hours.
const lateUtc = Date.parse('2026-08-03T18:45:00Z');
ok(istDayKey(lateUtc) === '2026-08-04', '18:45 UTC is already tomorrow in IST', istDayKey(lateUtc));
ok(!capReached(cap, lateUtc, 3), 'so a spent cap resets there, not 5.5 hours later');

const sameDay = Date.parse('2026-08-03T17:00:00Z');     // 22:30 IST — still today
ok(istDayKey(sameDay) === '2026-08-03', '17:00 UTC is still today in IST', istDayKey(sameDay));
ok(capReached(cap, sameDay, 3), 'and the cap still holds at 22:30 IST');

const rolled = afterFallback(cap, lateUtc);
ok(rolled.used === 1, 'the counter restarts at 1 on the new IST day, not 4', String(rolled.used));

ok(DEFAULT_DAILY_CAP > 0, 'the shipped default actually allows a fallback', String(DEFAULT_DAILY_CAP));

if (failures) {
  console.error(`\n✗ check:bg-fallback — ${failures} failing`);
  process.exit(1);
}
console.log('✓ check:bg-fallback — fallback fires on our outages, never on bad bytes, and is capped');
