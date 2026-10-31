#!/usr/bin/env node
/* ── Compose one cake idea from a brief, and print the spec ──────────────────────────────────────
 *
 * ⚠️ A SCRIPT, NOT A ROUTE, AND DELIBERATELY SO AT THIS STAGE. The question that decides whether
 * this feature is worth building is "are the ideas any good", and that is answered by looking at
 * twenty of them — not by wiring metering, entitlements and a screen first and discovering the
 * answer afterwards. A route is step six.
 *
 *   node scripts/compose-idea.mjs "krishna theme cake for a 5 year old boy"
 *   node scripts/compose-idea.mjs "mermaid cake for an 8 year old girl" --out /tmp/spec.json
 *   node scripts/compose-idea.mjs "..." --pool 80 --verbose
 *
 * `--out` writes a BUNDLE — the spec AND the rows it names — where the designer harness can read
 * it: dev server in spattoo-core, then /cake-idea.html?bundle=<url to that file>
 *
 * ⚠️ THE ROWS TRAVEL WITH THE SPEC, and without them the harness is useless for a real idea. A
 * spec carries element IDS; the harness has no API, no session and no catalogue, so on its own it
 * would drop every id as "not in this baker's library". We have already fetched those rows to
 * build the prompt, so emitting both costs nothing and makes the output self-contained.
 *
 * ⚠️ IT SPENDS REAL MONEY — one embedding and one gpt-4o call per run. Pennies, but not free, and
 * it is not metered because nothing here is a baker-facing path yet.
 */
import 'dotenv/config';
/* `config.js` refuses to load without every runtime secret. This script needs OpenAI and Supabase
   and nothing else, so the three it will never use are filled in — the same shape
   `backfill-help-index.mjs` already uses, and for the same reason. */
for (const [k, v] of Object.entries({
  REDIS_URL: 'redis://unused.compose.invalid:6379',
  R2_ACCESS_KEY_ID: 'unused-by-compose', R2_SECRET_ACCESS_KEY: 'unused-by-compose',
})) if (!process.env[k]) process.env[k] = v;

import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const KNOWN = new Set(['--out', '--pool', '--verbose']);
const unknown = args.filter(a => a.startsWith('-') && !KNOWN.has(a));
if (unknown.length) {
  console.error(`unknown option(s): ${unknown.join(', ')} — known: ${[...KNOWN].join(' ')}`);
  process.exit(2);
}
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const brief = args.filter(a => !a.startsWith('-') && args[args.indexOf(a) - 1] !== '--out'
                                                  && args[args.indexOf(a) - 1] !== '--pool').join(' ');
if (!brief) { console.error('say what the cake is for, e.g. "krishna theme cake for a 5 year old boy"'); process.exit(2); }

const { composeIdea, COMPOSE_POOL } = await import('../src/services/ideaCompose.js');

const pool = Number(flag('--pool')) || COMPOSE_POOL;
console.log(`→ "${brief}"  (shortlist ${pool})\n`);

const out = await composeIdea(brief, { k: pool });

if (!out.spec) {
  console.error(`✗ ${out.reason}`);
  if (out.raw) console.error(out.raw);
  process.exit(1);
}

const byId = new Map(out.shortlist.map(r => [r.id, r]));
const s = out.spec;

console.log(`subject   ${s.brief.subject}   ages ${JSON.stringify(s.brief.ages)}   ${s.brief.gender ?? ''}`);
console.log(`cake      ${s.cake.shape}, ${s.cake.tiers.length} tier(s)  ${s.cake.tiers.map(t => t.color ?? '—').join(' ')}`);
if (s.message) console.log(`message   "${s.message.text}"  ${s.message.look} on the ${s.message.surface}`);
if (s.age)     console.log(`age       ${s.age.number}`);
console.log(`\nplaced (${s.elements.length})`);
for (const e of s.elements) {
  console.log(`   ${String(e.count).padStart(2)}× ${(byId.get(e.elementId)?.name ?? e.elementId).padEnd(42)} ${e.zone.padEnd(12)} ${e.prominence}`);
}
/* ⚠️ THE TWO ABSENCES, SHOWN APART — `wanted` commissions an element, `rejected` fixes a prompt.
   The second is the one that tells you the prompt is drifting, so it is never hidden on success. */
console.log(`\nwanted, not in the catalogue (${s.wanted.length})`);
for (const w of s.wanted) console.log(`   ${w}`);
if (out.rejected.length) {
  console.log(`\nthe model said these and they were refused (${out.rejected.length})`);
  for (const r of out.rejected) console.log(`   ${r.name ?? `index ${r.i}`} — ${r.why}`);
}
console.log(`\nwhy       ${s.why}`);
console.log(`\ntokens    ${out.usage?.prompt_tokens ?? '?'} in / ${out.usage?.completion_tokens ?? '?'} out   prompt ${out.promptChars} chars`);

if (args.includes('--verbose')) {
  console.log('\nshortlist');
  out.shortlist.forEach((r, i) => console.log(`   ${String(i).padStart(3)} ${(r.similarity ?? 0).toFixed(3)} ${r.name}`));
}

const dest = flag('--out');
if (dest) {
  /* Only the rows the spec actually names — the other ~155 are prompt material, not part of the
     cake, and a bundle carrying them would be mostly noise to read and to load. */
  const used = new Set(s.elements.map(e => e.elementId));
  const bundle = { spec: s, elements: out.shortlist.filter(r => used.has(r.id)) };
  writeFileSync(dest, JSON.stringify(bundle, null, 2));
  console.log(`\n✓ bundle (spec + ${bundle.elements.length} rows) → ${dest}`);
}
