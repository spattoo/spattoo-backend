#!/usr/bin/env node
// ── One home for "what is this made of" ─────────────────────────────────────────────────────────
//
// The vocabulary of decoration materials lived in THREE places that drifted apart in silence:
//
//   · a CHECK constraint on `cake_elements.medium`  (fondant | edible_print | piped | acrylic | other)
//   · a `switch` in services/decorationPolicy.js    (fondant | chocolate  | edible_paper | acrylic)
//   · a hardcoded <select> in spattoo-admin         (fondant | chocolate  | edible_paper | acrylic | other)
//
// Nothing compared them, so nothing failed. What actually happened: 'chocolate' and 'edible_paper'
// became DEAD BRANCHES the database could not reach; 'edible_print' — the real stored value for a
// printed sheet — matched no branch and fell to the permissive default, offering a hand-modelling
// guide for something nobody hand-makes; and an admin choosing "Modelling chocolate" got a failed
// save for an option we put in front of them. `check:decoration-policy` was green the whole time,
// because its fixtures used the impossible values too.
//
// Migration 101 makes the list a TABLE and the API serves it, so admin can no longer hold its own
// copy. This guards what remains: that the policy reads DATA rather than string literals, and that
// the only two hand-written copies left — the migration's seed and the policy gate's fixtures —
// still agree.
//
// Pure text reading: no network, no database. Run via `npm run check:medium-vocab`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

// ── 1. The seeded vocabulary ────────────────────────────────────────────────────────────────────
/* ⚠️ EVERY MIGRATION THAT SEEDS ONE, not just 101. The first version read 101 alone, which was
   true for about a day: 102 added tempered chocolate and ganache, and a gate that knows only the
   founding migration starts calling every later material an unknown value. The whole point of
   making this a table was that materials arrive as rows over time. */
import { readdirSync } from 'node:fs';
const seeded = readdirSync(join(ROOT, 'migrations'))
  .filter(f => /^\d+_.*\.sql$/.test(f))
  .map(f => read(join('migrations', f)))
  .filter(sql => sql.includes('insert into decoration_mediums'))
  .flatMap((sql) => {
    const out = [];
    // A file may seed more than once; take every insert's value rows.
    let from = 0;
    for (;;) {
      const start = sql.indexOf('insert into decoration_mediums', from);
      if (start < 0) break;
      const end = sql.indexOf('on conflict (key)', start);
      out.push(...[...sql.slice(start, end < 0 ? undefined : end).matchAll(/^\s*\('([a-z_]+)',/gm)].map(m => m[1]));
      from = end < 0 ? sql.length : end + 1;
    }
    return out;
  });
ok(seeded.length >= 8, 'the migrations seed a material list', `${seeded.length} found`);
/* ⚠️ BOTH CHOCOLATES. They are different crafts — one is tempered, spread and curled, the other is
   a paste kneaded like fondant — and with only `modelling_chocolate` present the vision model
   returned it for five cakes of tempered work, because it was the only chocolate on offer. */
for (const must of ['fondant', 'edible_print', 'acrylic', 'isomalt', 'wafer_paper',
                    'chocolate', 'modelling_chocolate']) {
  ok(seeded.includes(must), `"${must}" is seeded`, seeded.join(', '));
}

// ⚠️ Every value the column could already hold must be seeded, or the foreign key orphans a row the
// moment it is added. These are the values probed off the live database on 2026-09-21.
for (const legacy of ['fondant', 'edible_print', 'piped', 'acrylic', 'other']) {
  ok(seeded.includes(legacy), `legacy stored value "${legacy}" survives the FK`, seeded.join(', '));
}

// ── 2. The policy reads data, not literals ──────────────────────────────────────────────────────
// The regression is a helpful `case 'isomalt':` added beside the data read — at which point one
// material behaves differently from every other and the table stops being the answer.
const policy = read('src/services/decorationPolicy.js')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

ok(!/switch\s*\(\s*el\??\.?\??medium/.test(policy),
   'the policy no longer switches on el.medium',
   'a material is a row in decoration_mediums, never a branch here');
ok(/can_model/.test(policy) && /can_print/.test(policy),
   'the policy reads can_model / can_print off the material row');
for (const dead of ['edible_paper', 'chocolate']) {
  ok(!new RegExp(`['"]${dead}['"]`).test(policy),
     `no literal "${dead}" left in the policy`,
     'the database cannot store it; it was a dead branch');
}

// ⚠️ An unresolved medium must NOT fall back to the permissive answer. That specific default is
// what turned a lookup failure into "offer everything", and it is the shape of the original bug.
ok(/not resolved/.test(policy),
   'an unresolved medium has its own reason',
   'falling back to "not stated" hides a missed join behind the most generous outcome');

// ── 3. The policy gate's fixtures are real keys ─────────────────────────────────────────────────
// This is the assertion that would have caught the whole thing: a fixture naming a medium the
// database cannot store proves nothing about production behaviour.
// ⚠️ COMMENTS STRIPPED FIRST. The gate's own prose names the dead values in order to explain them —
// `medium: 'edible_paper'` appears in a paragraph about why it is gone — and scanning raw text
// reports the documentation as a violation of the thing it documents.
const gate = read('scripts/check-decoration-policy.mjs')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
const fixtures = [...gate.matchAll(/medium:\s*'([a-z_]+)'/g)].map(m => m[1]);
ok(fixtures.length > 0, 'the policy gate exercises real mediums');
for (const f of [...new Set(fixtures)]) {
  // 'something_new' is deliberate — the unresolved-medium case.
  if (f === 'something_new') continue;
  ok(seeded.includes(f), `fixture medium "${f}" is a real seeded value`,
     'a fixture the database would reject asserts nothing about production');
}

// ── 4. Admin holds no copy of the list ──────────────────────────────────────────────────────────
// Skipped rather than failed when the sibling checkout is absent — CI may build the API alone.
try {
  const admin = read('../spattoo-admin/src/admin/ManageElements.jsx');
  ok(/fetchDecorationMediums/.test(admin),
     'admin fetches the material list from the API');
  ok(!/<option value="fondant"/.test(admin),
     'admin holds no hardcoded material options',
     'two of the hardcoded ones were values the database rejected on save');
} catch {
  console.log('  · spattoo-admin not checked out beside this repo — skipped its half');
}

console.log(failures
  ? `\n✗ check:medium-vocab — ${failures} failure(s).`
  : `\n✓ check:medium-vocab — one vocabulary (${seeded.length} materials), read as data in every place that uses it`);
process.exit(failures ? 1 : 0);
