#!/usr/bin/env node
// ── who Spattoo is blind-copied on ────────────────────────────────────────────
// A new bakery should tell somebody here, so signups are noticed the day they happen rather than
// the next time anyone reads the table. That is done as a BCC on the welcome mail the baker already
// gets — everything worth knowing is in it, and a second internal message would restate all of it
// and become a template to keep in step with the first.
//
// The failure this guards is silent and one-directional: a bcc applied too BROADLY. Put it in
// mailer.js, or add a high-volume type to the list, and a real person is copied on every quote,
// order update and reminder any customer ever receives. Nothing breaks, no test fails, and the
// mailbox is useless within a week — by which time we have also been copying third parties on mail
// that was not addressed to us.
//
// Pure text + config reading: no network, no provider, no database. Run via
// `npm run check:internal-bcc` (or the aggregate `npm run check`).
import { readFileSync } from 'node:fs';

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const proc   = read('../src/jobs/processors/sendNotification.js');
const mailer = read('../src/services/mailer.js');
const conf   = read('../src/config.js');

// ── the list is short, and it is a list ──────────────────────────────────────
{
  const m = proc.match(/BCC_TYPES\s*=\s*new Set\(\[([^\]]*)\]\)/s);
  ok(!!m, 'BCC_TYPES exists and is an explicit Set');
  if (m) {
    const types = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
    ok(types.includes('baker_welcome'), 'a new bakery is copied to us', types.join(', '));
    ok(types.includes('subscription_activated'), 'a plan starting being paid for is copied to us', types.join(', '));

    // The number is the point. Every entry is a mail a person reads; this failing is the prompt to
    // ask whether the new one is really worth an inbox, not to raise the number.
    ok(types.length <= 3, 'the copied list is still short', `${types.length} types: ${types.join(', ')}`);

    // ⚠️ THE REAL SLUGS, read off notification_types, not plausible-looking ones. The first draft
    // of this list was invented — 'order_placed', 'quote_ready', 'design_shared' — and not one of
    // them exists. Every assertion passed, and the guard would have waved through the actual
    // dangerous entries because it was comparing against names nothing uses.
    //
    // These are the per-order, per-customer and recurring types: a signup happens once per bakery,
    // an order happens all day, and a renewal happens to every customer every month for ever.
    const HIGH_VOLUME = [
      'order_placed_customer', 'design_updated_customer', 'quote_issued_customer',
      'order_confirmed_customer', 'order_completed_customer', 'order_ready_customer',
      'order_placed_baker', 'quote_accepted_baker', 'quote_question_baker', 'delivery_digest_baker',
      'subscription_renewed', 'credits_low', 'credits_exhausted', 'credits_purchased',
      'customer_invite', 'trial_ending', 'trial_ended',
    ];
    for (const t of types) {
      ok(!HIGH_VOLUME.includes(t), `"${t}" is too high-volume to copy a person on`);
    }
  }
}

// ── the decision is made where the message is known ──────────────────────────
{
  ok(/const bcc = BCC_TYPES\.has\(typeSlug\)/.test(proc),
     'the copy is decided per notification type');
  ok(/config\.smtp\.internalBcc \|\| null/.test(proc),
     'an empty address switches the copies off rather than sending to ""');
}

// ── and NOT in the mailer, which sends everything ────────────────────────────
// mailer.js is the one place every app email passes through, including every customer's. A default
// bcc there is the flood; it must only forward what a caller explicitly asked for.
{
  ok(/sendEmail\(\{[^)]*\bbcc\b/s.test(mailer), 'sendEmail accepts a bcc from its caller');
  ok(/\.\.\.\(bcc \? \{ bcc \} : \{\}\)/.test(mailer), 'the bcc is forwarded only when supplied');
  ok(!/bcc[^\n]*config\.smtp\.internalBcc/.test(mailer),
     'mailer.js does NOT reach for the internal address itself',
     'a default there copies somebody on every customer email');
}

// ── configurable, and off when blank ─────────────────────────────────────────
{
  ok(/internalBcc:\s*process\.env\.INTERNAL_NOTIFY_EMAIL/.test(conf),
     'the address is an env var, not a literal in the send path');
  // `??` and not `||`: an operator slip here would make INTERNAL_NOTIFY_EMAIL='' fall back to the
  // default, so switching the copies off in an environment would silently keep sending them.
  ok(/INTERNAL_NOTIFY_EMAIL \?\? '/.test(conf),
     'an empty env var means OFF, not "use the default"');
}

if (failures) {
  console.error(`\n✗ check:internal-bcc — ${failures} failed`);
  process.exit(1);
}
console.log('✓ check:internal-bcc — signups are copied to us, and nothing high-volume is');
