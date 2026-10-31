#!/usr/bin/env node
// ── A generation finishes whether or not anybody is watching ─────────────────────────────────────
//
// Until the poller existed, the only thing that moved a 3D generation forward was a browser:
// `Element3DStudio` runs a setInterval against `GET /admin/ai3d/:id`. For staff comparing vendors
// that is fine. For a baker it is a billing fault — their credits are reserved when the run starts
// and settled when it ends, so whether they are CHARGED OR REFUNDED would depend on keeping a tab
// open. Close the laptop and the credits sit in limbo: not spent, not returned.
//
// ── WHY THIS IS A GATE AND NOT A TEST AGAINST THE VENDOR ────────────────────────────────────────
// The property that matters most — one vendor failure must not abandon the rest of the sweep —
// only happens when a vendor misbehaves, which is exactly what cannot be arranged on demand. A
// resilience rule nobody can exercise is a comment, not a rule. So the loop takes its advance
// function as an argument and this drives it with ones that fail on cue.
//
// Pure: no database, no network, no vendor. Run: npm run check:ai3d-poll

process.env.SUPABASE_URL ||= 'http://stub';
process.env.SUPABASE_SERVICE_KEY ||= 'stub';
process.env.OPENAI_API_KEY ||= 'stub';
process.env.REMOVE_BG_API_KEY ||= 'stub';
process.env.REDIS_URL ||= 'redis://stub';
process.env.R2_ENDPOINT ||= 'http://stub';
process.env.R2_ACCESS_KEY_ID ||= 'stub';
process.env.R2_SECRET_ACCESS_KEY ||= 'stub';
process.env.R2_BUCKET ||= 'stub';
process.env.R2_PUBLIC_URL ||= 'http://stub';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/* ⚠️ DYNAMIC IMPORTS, BECAUSE STATIC ONES ARE HOISTED ABOVE THE STUBS ABOVE. `config.js` throws on
   a missing required env var AT IMPORT TIME, and in ESM every `import` declaration is evaluated
   before the first statement of this file — so the assignments above would run too late and the
   gate would die on REDIS_URL. Same reason check-ai-credit-pricing.mjs does it this way. */
const { advanceAll, inFlightQuery } = await import('../src/jobs/processors/pollAi3d.js');
const { TERMINAL } = await import('../src/services/ai3dAdvance.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failed++;
  console.error(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`);
};
const eq = (label, got, want) => ok(JSON.stringify(got) === JSON.stringify(want), label,
  `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

const row = (id, provider = 'tripo') => ({ id, provider });
const done = (r) => ({ row: { ...r, status: 'SUCCEEDED' }, changed: true });
const still = (r) => ({ row: { ...r, status: 'IN_PROGRESS' }, changed: false });

// ── 1. THE RULE THIS EXISTS FOR: one failure must not abandon the sweep ─────────────────────────
{
  const seen = [];
  const advance = async (r) => {
    seen.push(r.id);
    if (r.id === 'b') throw new Error('vendor 503');
    return done(r);
  };
  const out = await advanceAll([row('a'), row('b'), row('c')], advance);
  eq('every row is attempted even though the middle one threw', seen, ['a', 'b', 'c']);
  eq('and the outcome is counted honestly', out, { seen: 3, advanced: 2, finished: 2, failed: 1 });
}

// ── 2. A vendor outage is survivable, not fatal ─────────────────────────────────────────────────
{
  const out = await advanceAll([row('a'), row('b')], async () => { throw new Error('ECONNREFUSED'); });
  eq('every row failing still returns a result rather than throwing',
     out, { seen: 2, advanced: 0, finished: 0, failed: 2 });
}

// ── 3. Counting says what actually happened ─────────────────────────────────────────────────────
// `advanced` and `finished` are different questions: a run can move 20% → 60% without finishing,
// and a log that conflates them would report a stuck vendor as healthy progress.
{
  const out = await advanceAll([row('a'), row('b')], async (r) => (r.id === 'a' ? done(r) : still(r)));
  eq('a run that moved but did not finish counts as advanced, not finished',
     out, { seen: 2, advanced: 1, finished: 1, failed: 0 });
}
{
  const out = await advanceAll([row('a')], async (r) => ({ row: { ...r, status: 'IN_PROGRESS' }, changed: true }));
  eq('progress without completion is advanced but not finished',
     out, { seen: 1, advanced: 1, finished: 0, failed: 0 });
}

// ── 4. A malformed advance must not crash the sweep ─────────────────────────────────────────────
// Defensive because `advance` reaches a vendor: a shape nobody predicted is likelier here than in
// code we fully control.
{
  const out = await advanceAll([row('a'), row('b')], async (r) => (r.id === 'a' ? undefined : null));
  eq('undefined/null from an advance is survived', out, { seen: 2, advanced: 0, finished: 0, failed: 0 });
}
eq('an empty sweep is a no-op, not an error', await advanceAll([], async () => done(row('x'))),
   { seen: 0, advanced: 0, finished: 0, failed: 0 });

// ── 5. Which runs it asks about ─────────────────────────────────────────────────────────────────
{
  const q = inFlightQuery(Date.parse('2026-10-31T12:00:00Z'));
  eq('finished runs are never re-polled', q.notStatuses, TERMINAL);
  eq('the window is 24h', q.since, '2026-10-30T12:00:00.000Z');
  ok(q.limit > 0 && q.limit <= 100, 'the tick is bounded', `limit ${q.limit}`);
  // ⚠️ An unbounded sweep turns a backlog into a thundering herd against someone else's API.
  ok(Number.isFinite(q.limit), 'and the bound is a real number');
}

// ── 6. The job shares the advance; it does not reimplement it ───────────────────────────────────
// Two callers, one behaviour. Copied instead of shared, the job and the screen would answer
// differently about the same run — and the one nobody watches is the one that drifts.
{
  const src = readFileSync(join(ROOT, 'src/jobs/processors/pollAi3d.js'), 'utf8');
  ok(/from '\.\.\/\.\.\/services\/ai3dAdvance\.js'/.test(src),
     'the job imports the shared advance');
  ok(!/putObject|getTask\(|ai3d\/runs\//.test(src),
     'and holds no copy of the store-or-poll logic',
     'a second implementation here is how the job and the screen drift apart');
  const route = readFileSync(join(ROOT, 'src/routes/ai3d.js'), 'utf8');
  ok(/advanceGeneration\(/.test(route), 'and so does the route the studio polls');
}

if (failed) {
  console.error(`\n✗ check:ai3d-poll — ${failed} rule(s) broken\n`);
  process.exit(1);
}
console.log('✓ check:ai3d-poll — the sweep survives a bad vendor, counts honestly, and shares the advance');
