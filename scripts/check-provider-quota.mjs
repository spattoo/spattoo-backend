#!/usr/bin/env node
// ── An empty provider balance is an operating condition, not a crash ────────────────────────────
//
// OpenAI returns `insufficient_quota` as HTTP **429** — the same status as a rate limit — and that
// one fact produced two wrongs at once when the account balance reached $0 on 2026-09-22:
//
//   1. Every vision call's 429 backoff retried it up to six times, waiting out a schedule for
//      something no amount of waiting fixes.
//   2. The failure reached an admin as "Internal server error" and paged Sentry as a defect. The
//      remedy was a top-up; nothing on screen pointed there.
//
// ⚠️ THE TWO MEANINGS OF 429 ARE OPPOSITE INSTRUCTIONS. "Wait, the same request will work shortly"
// versus "no request will work until somebody pays". Only the body can tell them apart, so the
// check must happen BEFORE the retry decision — after it, the caller has already paid the delay.
//
// Run via `npm run check:provider-quota` (in `npm run check`).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ProviderQuotaError, isQuotaExhausted } from '../src/lib/providerQuota.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
let failures = 0;
const ok = (c, label, extra = '') => { if (c) return; failures++; console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`); };

// ── 1. The real bodies are recognised ───────────────────────────────────────────────────────────
ok(isQuotaExhausted('{"error":{"code":"insufficient_quota"}}'), 'insufficient_quota is recognised');
ok(isQuotaExhausted('You exceeded your current quota, please check your plan and billing details.'),
   'the prose form is recognised too');
ok(isQuotaExhausted('{"error":{"code":"billing_hard_limit_reached"}}'), 'a configured cap is recognised');
// And a genuine rate limit is NOT — it must keep retrying, which is what that backoff is for.
ok(!isQuotaExhausted('Rate limit reached for gpt-4o. Please try again in 1.2s'),
   'a real rate limit is NOT treated as an empty balance',
   'it would stop retrying the one case the backoff exists to survive');
ok(!isQuotaExhausted(''), 'an empty body is not a quota failure');

// ── 2. The error says what it is ────────────────────────────────────────────────────────────────
const e = new ProviderQuotaError();
ok(e.expected === true, 'it is marked as an EXPECTED condition', 'or the responder reports it to Sentry');
ok(e.status === 503, 'it answers 503, not 500', 'nothing about the request was wrong');
ok(e.code === 'PROVIDER_NO_CREDIT', 'it carries a code a client can branch on');
ok(/top up/i.test(e.message), 'and the message names the remedy');

// ── 3. Every retry loop checks BEFORE it backs off ──────────────────────────────────────────────
const ai = read('src/services/openai.js')
  .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const retries = [...ai.matchAll(/if \(res\.status === 429 && attempt < \d+\) \{/g)];
ok(retries.length > 0, 'the 429 backoff loops are still there', 'they survive a real rate limit');
for (const m of retries) {
  const before = ai.slice(Math.max(0, m.index - 200), m.index);
  ok(/isQuotaExhausted\(text\)/.test(before),
     'each 429 retry is preceded by the quota check',
     'checked after the retry, the caller waits out a backoff that cannot help');
}

// ── 4. The responder answers it rather than reporting it ────────────────────────────────────────
const http = read('src/lib/httpError.js');
ok(/err\?\.expected && err\?\.status/.test(http), 'serverError answers an expected condition directly');
const expectedBranch = http.slice(http.indexOf('if (err?.expected'), http.indexOf('logError'));
ok(!/logError/.test(expectedBranch), 'and does NOT report it to telemetry',
   'an alert that fires on a known recoverable state is one people learn to ignore');

console.log(failures
  ? `\n✗ check:provider-quota — ${failures} failure(s).`
  : '\n✓ check:provider-quota — an empty balance fails fast, reads clearly, and does not page anyone');
process.exit(failures ? 1 : 0);
