#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Every new table must GRANT to service_role.
//
// Supabase is removing the thing that has silently carried us this whole time.
// From 2026-10-30 it stops automatically granting Data API access to new tables
// in `public` — so a table created after that date is invisible to PostgREST
// until somebody grants it, and our API reaches the database through PostgREST
// with SUPABASE_SERVICE_KEY (config.js), i.e. as `service_role`.
//
// ⚠️ THE FAILURE IS DELAYED AND LANDS SOMEWHERE ELSE. The migration applies
// cleanly — the table is really there, psql can see it, the ledger records it —
// and then every route that touches it returns `permission denied for table`.
// Nothing connects that to a migration written weeks earlier, and the first
// environment to show it is whichever one is built LAST. Ours is production:
// 119–124 are still unrun there, and 119 creates `appuser_contact_changes`,
// which the whole phone/email proof flow reads.
//
// So the rule is: a migration that creates a table grants on it, in the same
// file, in the same breath. Which is the rule Supabase's own advice gives, for
// the reason their email gives: "Add grants to those migrations now."
//
// ── WHAT WE DO NOT DO: paste their anon line ─────────────────────────────────
// Their suggested boilerplate opens with `grant select on public.your_table to
// anon`. For this codebase that is the WRONG default and the gate says so.
// Our browser code reaches Supabase tables directly in exactly two places
// (cake_templates in admin's CreateTemplate, element_categories in
// CakeDesigner); everything else goes through our own API. Granting `anon` on a
// server-only table re-opens precisely the hole migration 119 was rewritten to
// close — RLS on, no policies — where an attacker with the public anon key
// could reach a table holding verification codes.
//
// So `anon` and `authenticated` grants are allowed but must be DELIBERATE: the
// file has to say PUBLIC ON PURPOSE in a comment. One line, and it turns a
// copy-paste into a decision somebody wrote down.
//
// Only migrations numbered >= FIRST_ENFORCED are checked. Everything below it
// was applied while Supabase still granted automatically, and already carries
// its grants in every environment — adding statements to an applied migration
// is the one thing migration discipline here forbids outright.
//
// Zero dependencies (matches check-migrations / check:schema house style).
// ─────────────────────────────────────────────────────────────────────────────

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// MIGRATIONS_DIR is for the self-test below, which needs files it controls. Real runs never set it.
const DIR  = process.env.MIGRATIONS_DIR || join(ROOT, 'migrations');

/* The first migration written AFTER the automatic grants stopped mattering. 124 is the last one
   that predates this; everything from 125 is ours to grant. Raise it never — lowering or raising it
   to dodge a failure means editing applied migrations, which is the forbidden move. */
const FIRST_ENFORCED = 125;
const REQUIRED_ROLE  = 'service_role';
const PUBLIC_MARKER  = 'PUBLIC ON PURPOSE';

// ⚠️ Comments stripped before ANY of this. Seven migrations already "mention grant" and every one
// of them is prose — `-- a complimentary grant names nothing`. A check that reads comments would
// pass a file that grants nothing and explains why at length.
const strip = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const bare = (name) => name.replace(/^public\./i, '').replace(/"/g, '').toLowerCase();

function tablesCreated(code) {
  const out = [];
  const re = /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_".]+)/gi;
  for (const m of code.matchAll(re)) {
    const raw = m[1];
    // A table in another schema is not served by the Data API, so it needs nothing from us.
    const schema = raw.includes('.') ? raw.split('.')[0].replace(/"/g, '').toLowerCase() : 'public';
    if (schema !== 'public') continue;
    out.push(bare(raw));
  }
  return [...new Set(out)];
}

/* Which roles a file grants on which table. Deliberately tolerant about the privilege list and
   about `table` being spelled or not — the question here is only "did a grant reach this table,
   naming this role", not whether it granted exactly the right verbs. */
function grantsByTable(code) {
  const map = new Map();
  const re = /\bgrant\b([\s\S]*?)\bon\b\s+(?:table\s+)?([a-z0-9_".,\s]+?)\bto\b\s+([a-z0-9_",\s]+?)(?:;|$)/gi;
  for (const m of code.matchAll(re)) {
    const tables = m[2].split(',').map(t => bare(t.trim())).filter(Boolean);
    const roles  = m[3].split(',').map(r => r.trim().replace(/"/g, '').toLowerCase()).filter(Boolean);
    for (const t of tables) map.set(t, new Set([...(map.get(t) ?? []), ...roles]));
  }
  return map;
}

const files = readdirSync(DIR)
  .filter(f => /^\d{3}_.*\.sql$/.test(f))
  .filter(f => parseInt(f.slice(0, 3), 10) >= FIRST_ENFORCED)
  .sort();

const problems = [];
let checked = 0, tablesSeen = 0;

for (const file of files) {
  const sql  = readFileSync(join(DIR, file), 'utf8');
  const code = strip(sql);
  const made = tablesCreated(code);
  if (!made.length) continue;
  checked++;
  const grants = grantsByTable(code);

  for (const t of made) {
    tablesSeen++;
    const roles = grants.get(t) ?? new Set();
    if (!roles.has(REQUIRED_ROLE)) {
      problems.push({
        file, table: t, kind: 'missing',
        msg: `creates public.${t} and never grants it to ${REQUIRED_ROLE}.\n`
           + `     After 2026-10-30 the migration applies fine and every route that reads this\n`
           + `     table answers "permission denied". Add, in this same file:\n\n`
           + `       grant select, insert, update, delete on public.${t} to service_role;`,
      });
    }
    const open = [...roles].filter(r => r === 'anon' || r === 'authenticated');
    if (open.length && !sql.includes(PUBLIC_MARKER)) {
      problems.push({
        file, table: t, kind: 'open',
        msg: `grants public.${t} to ${open.join(' and ')} with no stated reason.\n`
           + `     Our browser code reads Supabase tables directly in TWO places; everything else\n`
           + `     goes through our API. Granting anon on a server-only table reopens what\n`
           + `     migration 119 was rewritten to close. If it is genuinely public, say so —\n`
           + `     put "${PUBLIC_MARKER}" in a comment in this file with the reason.`,
      });
    }
  }
}

if (problems.length) {
  console.error(`✗ check:migration-grants — ${problems.length} problem(s):\n`);
  for (const p of problems) console.error(`   • ${p.file}\n     ${p.msg}\n`);
  console.error('   Why this is a gate: the migration SUCCEEDS and the failure arrives later,');
  console.error('   in a different environment, as a permission error nobody traces back here.');
  process.exit(1);
}

console.log(`✓ check:migration-grants — ${tablesSeen} table(s) in ${checked} migration(s) from `
          + `${FIRST_ENFORCED} grant to ${REQUIRED_ROLE} (${files.length} file(s) in range)`);
