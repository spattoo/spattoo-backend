#!/usr/bin/env node
// ── Credits given away are still money, and the email must not read like a receipt ───────────────
//
// An admin can hand a baker message credits on the house (migration 100). Three ways that goes
// wrong, and every one of them is silent — nothing throws, no test fails, and the first sign is a
// baker or an accountant asking a question nobody can answer:
//
//   1. THE EMAIL CLAIMS A PAYMENT. This template sits directly beside `credits_purchased`, which
//      thanks the baker for a payment, names an amount, quotes a payment reference and promises a
//      GST invoice "sent separately". Every one of those sentences is false here — nothing was
//      charged, so there is no invoice and no reference — and the next person adding a line is one
//      copy-paste away from all four. A baker told they paid for a gift will look for the charge.
//   2. THE GRANT IS NOT ATTRIBUTABLE. A purchase names its pack and a debit names its recipient; a
//      gift's only record of WHY is the note, so an optional one means "40 credits, no reason" six
//      weeks later, which is unanswerable for the baker who asks and for us.
//   3. ANYBODY WITH A SUPPORT LOGIN CAN GIVE MONEY AWAY. `baker:support` opens a baker's data for a
//      support question and `admin_staff` holds it. `billing:discount` is seeded sensitive and
//      platform-scoped and admin_staff does NOT hold it — the difference between reading about
//      somebody's money and spending ours.
//
// Source assertions for the wiring, a rendered email for the copy. Run via
// `npm run check:complimentary-credits` (in `npm run check`).

for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'OPENAI_API_KEY', 'REMOVE_BG_API_KEY',
                 'REDIS_URL', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
                 'R2_BUCKET', 'R2_PUBLIC_URL']) {
  process.env[k] ||= /URL|ENDPOINT/.test(k) ? 'http://stub' : 'stub';
}
process.env.SMTP_FROM ||= 'Spattoo <hello@stub>';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// Comments say these rules out loud as often as the code does, so they are stripped before asking —
// otherwise the documentation satisfies the check for the thing it documents.
const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
                     .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

let failed = 0;
const ok  = (m) => console.log(`  ✓ ${m}`);
const bad = (m, extra = '') => { console.error(`  ✗ ${m}${extra ? `  — ${extra}` : ''}`); failed++; };
const want = (cond, m, extra) => cond ? ok(m) : bad(m, extra);

// ── 1. The email says nothing about a payment ────────────────────────────────────────────────────
const { buildEmail } = await import('../src/jobs/processors/sendNotification.js');
const SLUG = 'message_credits_complimentary';
const mail = buildEmail(SLUG, 'baker@stub.test', { bakerName: 'Asha', messages: 40, balance: 65 });
const text = mail.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// The word forms that only make sense when money changed hands. "credits" is fine; "charged",
// "invoice", "payment", "receipt", "refund" and a rupee amount are not.
const MONEY = /\b(payment|paid|charge[ds]?|receipt|invoice|refund(ed)?|purchase[ds]?|billed)\b|₹|Rs\.?\s*\d/i;
const hit = text.match(MONEY);
want(!hit, 'the email never claims money changed hands',
     hit ? `says "${hit[0]}" — …${text.slice(Math.max(0, hit.index - 70), hit.index + 70)}…` : '');
want(/\bon us\b|\bcomplimentary\b|\bnothing to pay\b/i.test(text),
     'the email says out loud that these are free',
     'a balance that grew with no explanation is a balance nobody trusts or spends');

// ⚠️ The gift only does something if the baker knows what it BUYS. A baker who has switched no paid
// update on will never spend a credit — maySpendMessage refuses — so an email that congratulates
// them and stops is an expense with no effect.
want(/Customer updates/i.test(text), 'the email points at the setting that turns credits into sends',
     'only the update types a baker switches on ever use a credit');
want(/WhatsApp/i.test(text), 'the email names the channel credits pay for');

/* ⚠️ AND IT MAY NOT NAME SMS. The ledger's `channel` column allows 'sms', `message_packs` is priced
   on the SMS rate, and `messageBalance.js` says "SMS/WhatsApp" throughout — three good reasons to
   write it into baker-facing copy, and all three are about our plumbing rather than about what a
   customer can receive. Checked against dev, 2026-09-21: `notification_channels` holds NO sms row
   for any customer type. The only three are baker-facing (trial_ending, trial_ended,
   subscription_renewing) and all three are OFF, waiting on DLT template approval.
   So an email naming SMS sells a channel that cannot spend the credit it is describing. When SMS
   does go live for customers, delete this block — deliberately, not by discovering it fails. */
const sms = text.match(/\bSMS\b/i);
want(!sms, 'the email does not name SMS',
     'no customer notification type has an sms channel row; it cannot spend one of these credits');

// ⚠️ NO PRICE, NO RATE, NO "THIS COVERS N ORDERS". Cost lives in message_packs and what a send
// costs depends on how many paid channels a type has on — both admin-authored, both able to move
// without a deploy. Root CLAUDE.md rule 1: name the dependency, quantify nothing.
const PRICED = /\b\d+(\.\d+)?\s*(paise|rupees?)\b|\bper (message|order|send)\b|\bworth\b/i;
const priced = text.match(PRICED);
want(!priced, 'the email quotes no price and no per-order arithmetic',
     priced ? `says "${priced[0]}"` : '');

// The two numbers it MAY state, because the ledger just produced both.
want(text.includes('40'), 'the email says how many credits landed');
want(text.includes('65'), 'the email says what the balance is now');

// A missing balance must degrade to silence, not to "undefined" or "0" — the lesson TopUpsSection
// wrote down first: an unresolved balance says nothing about a number.
const noBalance = buildEmail(SLUG, 'baker@stub.test', { messages: 40 }).html;
want(!/undefined|NaN|null/.test(noBalance), 'nothing renders undefined when the balance is missing');
want(!/balance is now <b>0/.test(noBalance), 'an unknown balance is not rendered as zero');

// ── 2. The grant is attributable and bounded ─────────────────────────────────────────────────────
const svc = code(read('src/services/messageBalance.js'));
const from = svc.indexOf('export async function grantComplimentaryMessages');
want(from > 0, 'grantComplimentaryMessages exists in the service');
const body = svc.slice(from, svc.indexOf('\n}', from) + 2);

want(/kind: 'complimentary'/.test(body), "the row is its own kind, not 'adjustment' or 'welcome'",
     "'adjustment' tells the baker we made a mistake; 'welcome' is one per bakery, forever");
want(/note/.test(body) && /e\.status = 400/.test(body),
     'a reason is required, and refusing one is a 400 the admin can act on');
want(/Number\.isInteger/.test(body) && /n < 1/.test(body),
     'the amount is a whole positive number',
     'the balance is a SUM, so a negative here is a silent debit with a friendly label');
want(/n > \d+/.test(body), 'the amount has a ceiling',
     'the typo this guards is a trailing zero on a number nobody is invoiced for');
want(/granted_by/.test(body), 'who granted it is recorded');

// ── 3. The route is admin-only, and giving is a higher bar than looking ──────────────────────────
const route = code(read('src/routes/messageBalance.js'));
const post = route.slice(route.indexOf("router.post('/admin/bakers/:id/message-credits'"));
want(post.startsWith("router.post('/admin/bakers/:id/message-credits'"), 'the grant route exists under /admin');
want(/requireCapability\('billing:discount'\)/.test(post.slice(0, 300)),
     "granting requires 'billing:discount'",
     "'baker:support' is held by admin_staff and opens a baker's data for a support question; this spends money");

const getRoute = route.slice(route.indexOf("router.get('/admin/bakers/:id/message-credits'"));
want(/requireCapability\('baker:support'\)/.test(getRoute.slice(0, 300)),
     "reading a balance requires only 'baker:support'",
     'looking and giving are different decisions and must be grantable separately');

// ⚠️ The email must not be able to fail the grant. The credits are in the ledger the moment the
// insert returns; a provider having a bad minute reported as failure invites a retry, and the retry
// is another grant.
want(/catch \(err\) \{[\s\S]{0,200}?complimentary grant landed but the baker was not told/
       .test(read('src/routes/messageBalance.js')),
     'a failed notification cannot fail the grant',
     'the retry for a "failed" grant is a second grant');

console.log(failed
  ? `\n✗ check:complimentary-credits — ${failed} failure(s).`
  : '\n✓ check:complimentary-credits — free credits, said plainly, by somebody allowed to give them');
process.exit(failed ? 1 : 0);
