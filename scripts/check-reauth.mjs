#!/usr/bin/env node
// ── the gate that decides whether a borrowed session can change a phone number ────────────────────
//
// Step-up auth reads ONE claim off an already-validated token and answers one question: did this
// person type their password recently. Everything expensive about that question is in the details,
// and the details are the kind that look fine while being wrong — an `otp` entry read as proof, a
// window shorter than the flow it guards, a refreshed token mistaken for a fresh password.
//
// Pure — middleware/reauth.js exports its two decisions as functions, so this needs no network, no
// config, no Express and no real token. Run via `npm run check:reauth` (or `npm run check`).
import { methodProvedAt, REAUTH_MAX_AGE_SEC } from '../src/middleware/reauth.js';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

const now = Math.floor(Date.now() / 1000);

// ── what counts as proof ─────────────────────────────────────────────────────
// Supabase's own shape, measured off a live dev token on 2026-10-02.
ok(methodProvedAt({ amr: [{ method: 'password', timestamp: 1790963165 }] }) === 1790963165,
   'a password entry is read, and its timestamp comes back');

// ⚠️ THE ONE THAT MATTERS. The live token that settled this design carried exactly this and nothing
// else — a magic-link sign-in from August. Reading "any recent amr entry" as proof would have let a
// session the user never typed a password for through the gate.
ok(methodProvedAt({ amr: [{ method: 'otp', timestamp: now }] }) === null,
   'an OTP sign-in is NOT a password, however recent');

ok(methodProvedAt({ amr: [{ method: 'otp', timestamp: now }, { method: 'password', timestamp: 1234 }] }) === 1234,
   'a password entry is found beside other methods');

// Several sign-ins over a session's life: the LATEST is the one freshness is judged on. Taking the
// first would make a long-lived session permanently stale no matter how recently it re-authed.
ok(methodProvedAt({ amr: [{ method: 'password', timestamp: 100 }, { method: 'password', timestamp: 900 }] }) === 900,
   'the most recent password entry wins');

// ── what is not proof ────────────────────────────────────────────────────────
ok(methodProvedAt(null) === null,              'no claims at all');
ok(methodProvedAt({}) === null,                'no amr claim');
ok(methodProvedAt({ amr: [] }) === null,       'an empty amr');
ok(methodProvedAt({ amr: 'password' }) === null, 'a string where an array belongs');

// RFC-8176 allows a plain string[], which a custom access-token hook may emit. It carries NO time,
// so it cannot answer a freshness question. Read as "no proof" rather than "proved at an unknown
// moment" — the alternative is a gate that opens on a token that never said when.
ok(methodProvedAt({ amr: ['password'] }) === null,
   'the RFC string form carries no timestamp, so it is not proof of recency');

ok(methodProvedAt({ amr: [{ method: 'password' }] }) === null,
   'a password entry with no timestamp proves nothing');
ok(methodProvedAt({ amr: [{ method: 'password', timestamp: 'now' }] }) === null,
   'a non-numeric timestamp is refused rather than coerced');

// ── the window ───────────────────────────────────────────────────────────────
// routes/account.js sends a code good for PHONE_CODE_TTL_SEC = 600s and the baker then waits for an
// SMS. A window at or below that rejects the confirm step of a change the same person legitimately
// started — a gate that fires on honest use is a gate people learn to work around.
const PHONE_CODE_TTL_SEC = 600;
ok(REAUTH_MAX_AGE_SEC > PHONE_CODE_TTL_SEC,
   'the re-auth window outlasts the OTP it guards, so an honest confirm never fails',
   `${REAUTH_MAX_AGE_SEC}s vs ${PHONE_CODE_TTL_SEC}s`);

// And it is not so long that it stops meaning "recently".
ok(REAUTH_MAX_AGE_SEC <= 30 * 60,
   'but it still means RECENTLY', `${REAUTH_MAX_AGE_SEC}s`);

if (failures) {
  console.error(`\n✗ check:reauth — ${failures} failing`);
  process.exit(1);
}
console.log('✓ check:reauth — only a password proves it, the newest one counts, and the window outlasts the OTP');
