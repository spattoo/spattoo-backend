// ── An enquiry email may not claim a design that does not exist ─────────────────────────────────
// The order emails were written when the ONLY way to reach a baker was an invite into the 3D
// designer. Every order had a design, so the copy said so — "thanks for designing your cake",
// "review the design" — and nobody was wrong.
//
// The storefront changed the premise. An enquiry can now be a flavour and a date, or a reference
// photo, with nothing designed at all. Those sentences went quietly false on the majority of
// enquiries, and stayed false for weeks, because an email nobody on the team receives is the
// easiest copy in the product to be wrong about. A customer who picked Black Forest and a Saturday
// was thanked for designing a cake they had never opened a designer for.
//
// So: render both order_placed templates BOTH ways and assert what they say. The thumbnail is the
// signal — it exists only when a design snapshot produced one.
//
// ── WHY THE SECOND HALF MATTERS AS MUCH AS THE FIRST ────────────────────────────────────────────
// It would be trivial to satisfy "never mentions a design" by deleting the word everywhere. That
// passes and makes the product worse: a customer who DID spend twenty minutes in the designer
// should be thanked for it. So the with-design variant must still say so, which keeps the branch
// alive and stops the fix collapsing into blandness.
//
// Run via `npm run check:email-design-claims` (in `npm run check`).

for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'OPENAI_API_KEY', 'REMOVE_BG_API_KEY',
                 'REDIS_URL', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
                 'R2_BUCKET', 'R2_PUBLIC_URL']) {
  process.env[k] ||= /URL|ENDPOINT/.test(k) ? 'http://stub' : 'stub';
}
process.env.SMTP_FROM ||= 'Spattoo <hello@stub>';

const { buildEmail } = await import('../src/jobs/processors/sendNotification.js');

let failed = 0;
const ok  = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.error(`  ✗ ${m}`); failed++; };

// The templates an ENQUIRY sends. Not design_updated_customer, which is about a design by
// definition and may say so freely.
const TYPES = ['order_placed_customer', 'order_placed_baker'];

const base = {
  customerName: 'Aarti Rao', customerFirstName: 'Aarti', bakerName: 'Super&bake',
  deliveryDate: '2026-08-20', deliveryMode: 'pickup', weightKg: 1,
  flavours: [{ name: 'Black Forest' }],
};

// The word in any form, as a WORD — so "designer" and "redesign" are caught too, while the
// `alt="Cake design"` on the thumbnail image is not, because tags are stripped first.
const DESIGN = /\bdesign(s|ed|ing|er|ers)?\b/i;
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

for (const type of TYPES) {
  // ── No design: the flavour-and-a-date enquiry, which is now the common case ──
  const without = text(buildEmail(type, 'a@b.test', base).html);
  const hit = without.match(DESIGN);
  if (hit) {
    bad(`${type} mentions "${hit[0]}" on an enquiry with no design`);
    console.error(`      …${without.slice(Math.max(0, hit.index - 60), hit.index + 60)}…`);
  } else {
    ok(`${type} claims no design when there is none`);
  }

  // ── With a design: it must still say so, or the fix was just deletion ──
  const withDesign = text(buildEmail(type, 'a@b.test', { ...base, thumbnailUrl: 'http://stub/c.webp' }).html);
  if (DESIGN.test(withDesign)) ok(`${type} still credits the design when there is one`);
  else bad(`${type} never mentions the design even when one exists — the branch is dead copy`);
}

if (failed) {
  console.error(`\n✗ check:email-design-claims — ${failed} problem(s).`);
  console.error('  An enquiry can be a flavour and a date. Branch on the thumbnail, and let the');
  console.error('  fallback wording be true either way — a designed cake with no thumbnail should');
  console.error('  get a vaguer email, never a wrong one.\n');
  process.exit(1);
}
console.log('✓ check:email-design-claims — no enquiry email claims a design that is not there');
