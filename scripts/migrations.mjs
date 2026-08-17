#!/usr/bin/env node
//
// ── Which migrations has this database actually had? ─────────────────────────────────────────────
//
// There are 65 files in migrations/ and, until this script, nothing anywhere recorded which of them
// had been run against which environment. The record was memory.
//
// That has already failed. `supabase/baker_dietary_options.sql` turned out never to have been
// applied to EITHER environment — discovered on 2026-08-15 when saving flavours died with "Could
// not find the table 'public.baker_dietary_exclusions'", weeks after the file was written. Nothing
// was wrong with the SQL. Somebody just did not run it, and nothing could tell.
//
// Prod makes it worse rather than better. It was built from `supabase/schema.sql` — a dump of dev at
// a point in time — so it starts life with most of these migrations baked in but none of them
// *recorded*, and the ones written since have to be tracked by hand across two environments.
//
// So: a table the database keeps about itself.
//
// ── Commands ─────────────────────────────────────────────────────────────────────────────────────
//
//   node scripts/migrations.mjs status                 what is applied, pending, or CHANGED
//   node scripts/migrations.mjs baseline --through=061  record as applied WITHOUT running
//   node scripts/migrations.mjs emit                   write the pending ones to one paste-able file
//
// Target database comes from SUPABASE_DB_URL, or --url=... to point at prod without putting a prod
// connection string in .env. Uses `psql` for the same reason dump-schema.mjs does: no driver
// dependency, and it is already required for the schema baseline.
//
// ── Why `emit` exists ────────────────────────────────────────────────────────────────────────────
// Prod SQL is run by pasting into the Supabase editor, deliberately — Sandeep does not keep prod
// credentials in the environment. So this never applies anything itself. It tells you what is
// outstanding and hands you one file to paste, with the bookkeeping INSERTs already in it, so the
// database records what happened without anyone having to remember to say so.

import { execFileSync } from 'child_process';
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import 'dotenv/config';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'migrations');
const PSQL = process.env.PSQL || (process.env.PG_DUMP || '').replace(/pg_dump$/, 'psql') || 'psql';

const argv = process.argv.slice(2);
const cmd = argv.find(a => !a.startsWith('-')) ?? 'status';
const flag = (n, d = null) => argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;

const DB_URL = flag('url', process.env.SUPABASE_DB_URL);

const die = (msg) => { console.error(`\n✗ ${msg}\n`); process.exit(1); };

// The migration files, in the order their numeric prefix says. NOT readdir order and NOT
// lexicographic — those agree today only because every file is zero-padded to three digits, and the
// day one is not, a migration silently runs before the one that created the table it alters.
//
// Four files predate the numbering convention entirely (cake_textures, materials,
// materials_decoration_surface, text_styles). They sort FIRST, as number 0, because that is what
// they are: the oldest. They still need a ledger row — an untracked migration is exactly the
// problem this script exists for, and being old is not being applied. `--through` picks them up for
// any cutoff, since 0 is below every real number.
function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => ({ file: f, num: /^\d/.test(f) ? parseInt(f, 10) : 0 }))
    .sort((a, b) => a.num - b.num || a.file.localeCompare(b.file))
    .map(m => ({
      ...m,
      body: readFileSync(path.join(MIGRATIONS_DIR, m.file), 'utf8'),
    }))
    // Checksum so an EDITED migration is visible. A file changed after it ran is the quietest
    // failure available: dev has the new behaviour because someone re-ran it by hand, prod has the
    // old, and the filename says both are up to date.
    .map(m => ({ ...m, sum: createHash('sha256').update(m.body).digest('hex').slice(0, 12) }));
}

function psql(sql) {
  if (!DB_URL) die('No database URL. Set SUPABASE_DB_URL, or pass --url=<direct connection string>.\n' +
                   '  Supabase → Project Settings → Database → Connection string → URI (port 5432, NOT the pooler).');
  try {
    return execFileSync(PSQL, [DB_URL, '-tAX', '-c', sql], { encoding: 'utf8', timeout: 30_000 });
  } catch (err) {
    if (/ENOENT/.test(err.message)) {
      die(`psql not found (tried: ${PSQL}).\n  PSQL=/Applications/Postgres.app/Contents/Versions/latest/bin/psql npm run db:migrations`);
    }
    die(`psql failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

const LEDGER = `
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  filename   text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.schema_migrations IS
  'Which files in migrations/ this database has had. Written by scripts/migrations.mjs, or by the '
  'INSERT at the foot of an emitted batch. A row here is the only durable answer to "has this run?".';
`;

function applied() {
  psql(LEDGER);
  const out = psql(`SELECT filename || '|' || checksum FROM public.schema_migrations;`);
  return new Map(out.trim().split('\n').filter(Boolean).map(l => l.split('|')));
}

// ── status ───────────────────────────────────────────────────────────────────────────────────────
function status() {
  const files = migrationFiles();
  const have = applied();

  const pending  = files.filter(m => !have.has(m.file));
  const changed  = files.filter(m => have.has(m.file) && have.get(m.file) !== m.sum);

  console.log(`\n  ${files.length} migration files · ${have.size} recorded as applied\n`);

  if (changed.length) {
    console.log(`  ⚠ ${changed.length} CHANGED since they were applied — this database has the OLD version:`);
    changed.forEach(m => console.log(`      ${m.file}`));
    console.log('');
  }

  if (!pending.length) {
    console.log('  ✓ nothing pending\n');
  } else {
    console.log(`  ${pending.length} PENDING:`);
    pending.forEach(m => console.log(`      ${m.file}`));
    console.log(`\n  → node scripts/migrations.mjs emit    (writes them to one file to paste)\n`);
  }

  // Recorded but no longer on disk. Renaming a migration after it ran leaves this behind, and it is
  // worth saying out loud: the ledger is then describing a file nobody can read.
  const orphans = [...have.keys()].filter(f => !files.some(m => m.file === f));
  if (orphans.length) {
    console.log(`  ⚠ recorded but missing from migrations/: ${orphans.join(', ')}\n`);
  }
}

// ── baseline ─────────────────────────────────────────────────────────────────────────────────────
// For a database that already HAS these changes but has never recorded them — which is both of ours
// right now. Records without running. --through is the last migration the database already
// contains: for prod that is whatever `supabase/schema.sql` was dumped from.
function baseline() {
  const through = flag('through');
  if (!through) die('baseline needs --through=<number>, the last migration this database already contains.\n' +
                    '  Everything up to and including it is recorded as applied WITHOUT being run.\n' +
                    '  For a prod built from supabase/schema.sql, that is the highest migration in that dump.');

  const cutoff = parseInt(through, 10);
  const files = migrationFiles().filter(m => m.num <= cutoff);
  const have = applied();
  const todo = files.filter(m => !have.has(m.file));

  if (!todo.length) return console.log(`\n  ✓ nothing to baseline — all ${files.length} up to ${cutoff} already recorded\n`);

  const values = todo.map(m => `('${m.file}', '${m.sum}')`).join(',\n    ');
  psql(`INSERT INTO public.schema_migrations (filename, checksum) VALUES\n    ${values}\n  ON CONFLICT (filename) DO NOTHING;`);
  console.log(`\n  ✓ recorded ${todo.length} migrations (up to ${cutoff}) as already applied\n`);
  console.log(`  Now run: node scripts/migrations.mjs status\n`);
}

// ── emit ─────────────────────────────────────────────────────────────────────────────────────────
// One file, in order, each migration followed by the INSERT that records it. NOT wrapped in a single
// transaction: some migrations do things Postgres refuses inside one, and a batch that fails halfway
// through with everything rolled back is no easier to reason about than one that stops where it
// stopped — the ledger tells you exactly where that was, which is the entire point.
function emit() {
  const out = flag('o', path.join(import.meta.dirname, '..', 'supabase', 'pending-migrations.sql'));
  const files = migrationFiles();
  const have = applied();
  const pending = files.filter(m => !have.has(m.file));

  if (!pending.length) return console.log('\n  ✓ nothing pending — no file written\n');

  const parts = [
    `-- Pending migrations, generated by scripts/migrations.mjs`,
    `-- ${pending.length} file(s). Paste into the target SQL editor and run.`,
    `-- Each is followed by the INSERT that records it, so the database knows what it has had`,
    `-- without anyone having to remember to say so. Safe to re-run: recorded ones are skipped by`,
    `-- ON CONFLICT, though the migration bodies themselves are only as idempotent as they were written.`,
    ``,
    LEDGER.trim(),
    ``,
  ];

  for (const m of pending) {
    parts.push(
      `-- ─────────────────────────────────────────────────────────────────────────────`,
      `-- ${m.file}`,
      `-- ─────────────────────────────────────────────────────────────────────────────`,
      m.body.trimEnd(),
      ``,
      `INSERT INTO public.schema_migrations (filename, checksum)`,
      `VALUES ('${m.file}', '${m.sum}') ON CONFLICT (filename) DO NOTHING;`,
      ``,
    );
  }

  writeFileSync(out, parts.join('\n'));
  console.log(`\n  ✓ ${pending.length} pending migration(s) → ${path.relative(process.cwd(), out)}`);
  pending.forEach(m => console.log(`      ${m.file}`));
  console.log('');
}

const COMMANDS = { status, baseline, emit };
(COMMANDS[cmd] ?? (() => die(`unknown command "${cmd}". Try: status | baseline | emit`)))();
