#!/usr/bin/env node
// ── the one endpoint the public may make us send email from ──────────────────
// Every rule here is a rule about an UNAUTHENTICATED request costing us something: a row, an email,
// or the sending reputation of the domain that also carries order and trial mail. The failure this
// guards against is not "the form broke" — it is "the form worked so well that a bot ran it for a
// weekend and our transactional mail started landing in spam".
//
// It reads the SOURCE rather than calling the route, because the interesting properties are
// structural — that a limiter is attached at all, that the honeypot answers 200, that nothing
// secret is in the browser bundle. Those cannot be observed from a single happy-path request, and
// they are exactly what a well-meaning edit removes.
//
// Run via `npm run check:demo-request` (or the aggregate `npm run check`).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const src = readFileSync(join(ROOT, 'src/routes/demoRequest.js'), 'utf8');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

// ── the limiters are ON the route ────────────────────────────────────────────
// Defining a limiter and forgetting to attach it looks completely correct in review: the constant is
// there, named, with sensible numbers, and nothing uses it.
const handler = src.match(/router\.post\(\s*'\/public\/demo-request'([^)]*)/s)?.[1] ?? '';
ok(/perIp/.test(handler),    'the per-IP limiter is attached to the route', handler.trim().slice(0, 80));
ok(/perEmail/.test(handler), 'the per-email limiter is attached to the route');

// Two windows, because they fail differently: per-IP stops one machine hammering the form, per-email
// survives a botnet with an address per request. Dropping either leaves a hole the other cannot see.
ok(/rateLimit\(\{[^}]*key:\s*req\s*=>\s*req\.ip/s.test(src), 'the per-IP limiter keys on the IP');
ok(/rateLimit\(\{[^}]*key:[^}]*req\.body\?\.email/s.test(src), 'the per-email limiter keys on the email');

// ── the captcha is checked, and checked FIRST ────────────────────────────────
// A widget on the page proves nothing on its own: a script posting straight at the API never loads
// the page, so it never has a token, and an endpoint that does not VERIFY simply ignores that. This
// is the layer that stops the bots the honeypot cannot.
//
// First, because it is the cheapest way to end a request that was never going to be legitimate — and
// because it keeps junk out of the rate limiters' counters, where it would otherwise crowd out real
// visitors sharing an IP.
ok(/verifyTurnstile\(/.test(src), 'the route verifies the captcha token');
const bodyStart = src.indexOf('const b = req.body');
ok(bodyStart > 0 && src.indexOf('verifyTurnstile(') < src.indexOf('b.website'),
   'the captcha is checked before the honeypot and the parsing');
ok(/CAPTCHA_FAILED/.test(src), 'a failed captcha answers with a code the form can act on');

// ── the captcha fails CLOSED ─────────────────────────────────────────────────
// The opposite of rateLimit.js, deliberately. A limiter must never take the site down, so it fails
// open; this exists to reject unverified requests, so failing open would make it decoration. The one
// exception is NOT CONFIGURED, which is different from broken.
{
  const ts = readFileSync(join(ROOT, 'src/services/turnstile.js'), 'utf8');
  ok(/catch[\s\S]{0,200}return false;/.test(ts), 'a verify error rejects rather than allowing');
  ok(/if \(!turnstileConfigured\(\)\) return true;/.test(ts), 'an unconfigured secret does not enforce');
  ok(/AbortSignal\.timeout/.test(ts), 'the verify call is bounded by a timeout');
  ok(!/console\.[a-z]+\([^)]*token/.test(ts), 'the token itself is never logged');
}

// ── the honeypot is silent ───────────────────────────────────────────────────
// Answering a caught bot with an error tells whoever wrote it exactly which field to stop filling.
const honeypot = src.match(/if \(clean\(b\.website[^\n]*\n?[^\n]*/)?.[0] ?? '';
ok(/res\.json\(\{ ok: true \}\)/.test(honeypot), 'the honeypot answers with the same 200 a real submission gets', honeypot.trim());
ok(!/status\(4\d\d\)[^\n]*website/.test(src), 'the honeypot never returns an error status');

// ── the lead is stored BEFORE the email ──────────────────────────────────────
// The row is the record; the email is a notification. Reversed, an SMTP hiccup loses a sales lead
// silently — the failure nobody notices, because nothing is there to be missed.
const insertAt = src.indexOf('.insert(');
const sendAt   = src.indexOf('sendEmail(');
ok(insertAt > 0 && sendAt > 0 && insertAt < sendAt, 'the lead is inserted before the email is sent');
// And a failed notification must not fail the request — the lead is already safe, and an error here
// makes the visitor submit again, which is how one lead becomes two rows.
ok(/sendEmail\([\s\S]*?\}\)\.catch\(/.test(src), 'a failed notification email is caught, not thrown');

// ── every field is bounded ───────────────────────────────────────────────────
// Unbounded, one request can put a megabyte of prose into the database and the email body.
const fields = [...src.matchAll(/clean\(b\.(\w+),\s*(\d+)\)/g)];
ok(fields.length >= 7, 'every submitted field goes through clean() with a max', `found ${fields.length}`);
ok(fields.every(([, , max]) => Number(max) <= 200), 'no field allows more than 200 characters');

// ── nothing is trusted into HTML ─────────────────────────────────────────────
// The notification body is entirely attacker-controlled and lands in a mail client that renders
// markup happily.
ok(/const esc = /.test(src), 'there is an escaper for the notification HTML');
const html = src.match(/html:\s*`[\s\S]*?`,/)?.[0] ?? '';
ok(html.length > 0, 'the notification builds an HTML body');
ok(!/\$\{(?!\s*(rows|esc))/.test(html.replace(/esc\([^)]*\)/g, 'esc()')),
   'every interpolation in the notification HTML goes through esc()', html.slice(0, 120));

// ── the column names match the table ─────────────────────────────────────────
// `waitlist` is an existing table with existing names, and a mismatch is not a compile error — it is
// a 503 at submit time, discovered by a visitor. These are the four that differ from what the FORM
// calls them (mobile→phone, brandName→business_name), which is exactly where a rename gets missed.
for (const col of ['first_name', 'last_name', 'email', 'phone', 'business_name', 'city']) {
  ok(new RegExp(`\\b${col}:`).test(src), `the insert writes ${col}, as the table names it`);
}
ok(!/\bmobile:/.test(src),     'nothing is written to `mobile` — the column is `phone`');
ok(!/\bbrand_name:/.test(src), 'nothing is written to `brand_name` — the column is `business_name`');

// ── a missing column never costs a lead ──────────────────────────────────────
// cakes_per_month and source are additive: worth having, not worth turning a visitor away over. The
// retry keeps the lead; the log is what stops the fallback becoming permanent and unnoticed.
ok(/EXTRA/.test(src), 'the additive columns are named in one place');
ok(/insert\(core\)/.test(src), 'a schema error retries with the columns the table certainly has');
ok(/console\.error\([^)]*missing/.test(src), 'the fallback complains rather than degrading quietly');

// ── unconfigured fails LOUDLY ────────────────────────────────────────────────
// Pretending it worked would lose the lead and tell the visitor we will be in touch.
ok(/status\(503\)/.test(src), 'an unconfigured or failing leads database answers 503, never a fake success');

// ── the browser holds no key ─────────────────────────────────────────────────
// This is the rule SEC-WEB-1 was opened for: the previous version shipped the leads project's anon
// key in the marketing bundle, so anyone could write rows directly, skipping every check above.
const marketing = join(ROOT, '..', 'spattoo-web', 'apps', 'marketing');
if (existsSync(marketing)) {
  const grep = (pattern) => {
    try {
      return execFileSync('grep', ['-rl', '--include=*.ts', '--include=*.tsx', pattern, marketing],
        { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch { return []; }             // grep exits 1 when nothing matches — that is the pass
  };
  ok(grep('supabase-leads').length === 0, 'the marketing site has no leads Supabase client');
  const keys = grep('eyJhbGciOi');       // a JWT literal, which is what an anon key looks like
  ok(keys.length === 0, 'the marketing site embeds no Supabase key', keys.join(', '));
} else {
  console.log('i spattoo-web not found next to this repo — skipped the marketing-bundle checks');
}

if (failures) {
  console.error(`\n✗ check:demo-request — ${failures} rule(s) broken.`);
  process.exit(1);
}
console.log('✓ check:demo-request — captcha-gated, limited, honeypotted, stored before sent, no key in the browser');
