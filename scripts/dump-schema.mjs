#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// dump-schema.mjs — capture the live schema into `supabase/schema.sql`.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The schema in this repo CANNOT be replayed. `bakers`, `orders`, `customers`,
// `cake_elements`, `cake_templates` and `element_types` have no CREATE TABLE in
// any file — not in migrations/, not in supabase/. The numbered migrations start
// at 007; whatever made 001–006 was typed into the dashboard and never captured.
// The 72 files in supabase/ are unnumbered and have no defined apply order.
//
// So the honest answer to "what is the schema" is currently "ask the database".
// That is fine until you need a SECOND database — a prod project, a staging
// project, a restore — and then it is the whole problem. This script makes the
// database's own answer a file, so standing up an environment stops being an
// act of archaeology.
//
// It is NOT a migration tool and does not replace migrations/. New changes still
// ship as numbered migrations; this captures the RESULT so a fresh environment
// can start from today instead of from 007.
//
// ── WHAT A public-ONLY DUMP LEAVES BEHIND ────────────────────────────────────
// Two things, both silent, both fatal in a different way:
//
//   1. EXTENSIONS. Supabase installs them into the `extensions` schema, which a
//      --schema=public dump never visits. The restore then dies on the first
//      `vector(1536)` column — loudly, at least.
//
//   2. THE pg_cron SCHEDULE. `cron.schedule('purge-old-notifications', …)` lives
//      in the `cron` schema. A public dump drops it and says nothing. Everything
//      works; notifications simply grow forever, and you find out in a year.
//
// Both are re-emitted here, around the pg_dump body, marked as ours.
//
// Usage:
//   node scripts/dump-schema.mjs                # write supabase/schema.sql
//   node scripts/dump-schema.mjs --check        # fail if the committed file is stale
//   node scripts/dump-schema.mjs --out /tmp/s.sql
//
// Env:
//   SUPABASE_DB_URL — the DIRECT Postgres connection string, NOT the REST URL.
//                     Supabase → Project Settings → Database → Connection string
//                     → URI. Use the direct (5432) string, not the pooler: the
//                     transaction pooler cannot serve pg_dump.
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : join(ROOT, 'supabase', 'schema.sql');

const DB_URL = process.env.SUPABASE_DB_URL;

// Which pg_dump to run. Overridable because the macOS routes to a Postgres client all put it
// somewhere different — Postgres.app buries it inside the bundle, Homebrew's libpq is keg-only and
// unlinked by default — and none of them is worth a PATH edit to run a script once a release.
//   PG_DUMP=/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump npm run db:schema
const PG_DUMP = process.env.PG_DUMP || 'pg_dump';

// Extensions this schema genuinely depends on. Kept as a list rather than detected, because
// detection needs a live connection we would only make to ask a question whose answer is two
// items long and changes about once a year.
//   vector  — cake_elements.description_embedding
//   pg_cron — the nightly notification purge below
const EXTENSIONS = ['vector', 'pg_cron'];

// Anything scheduled outside `public`. Re-running cron.schedule with an existing job NAME
// updates it in place, so this stays idempotent.
const CRON_JOBS = [
  { name: 'purge-old-notifications', schedule: '17 3 * * *', command: 'SELECT purge_old_notifications(90);' },
];

function fail(msg, hint) {
  console.error(`\n✖ ${msg}`);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(1);
}

function requirePgDump() {
  let version;
  try {
    version = execFileSync(PG_DUMP, ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    fail(`pg_dump not found (tried: ${PG_DUMP}).`,
      `  You need the Postgres CLIENT tools. You do NOT need a database server —\n` +
      `  this only ever talks to a remote one.\n\n` +
      `  Easiest on macOS — Postgres.app (no package manager, no sudo):\n` +
      `    1. download from https://postgresapp.com  →  drag to /Applications\n` +
      `    2. run with an explicit path, no PATH edit needed:\n` +
      `       PG_DUMP=/Applications/Postgres.app/Contents/Versions/latest/bin/pg_dump \\\n` +
      `         npm run db:schema\n\n` +
      `  Or via Homebrew, if you have it:\n` +
      `    brew install libpq && brew link --force libpq\n\n` +
      `  Supabase runs Postgres 15+, and pg_dump refuses to dump a server NEWER than\n` +
      `  itself — so an old client fails with a version-mismatch error, not a bad dump.`);
  }
  const major = Number(version.match(/(\d+)\./)?.[1] ?? 0);
  if (major < 15) {
    fail(`pg_dump is too old (${version}).`,
      `  Supabase runs Postgres 15 or later and pg_dump will not dump a newer server.\n` +
      `  Upgrade: brew install libpq && brew link --force libpq`);
  }
  return version;
}

// pg_dump stamps its own version and the server's into a header comment. Both are real
// information, but they make every dump differ from every other dump taken across an upgrade,
// which would make --check fire on a schema that has not changed. Strip them for comparison
// only — the written file keeps its provenance.
const stripVolatile = (sql) => sql.replace(/^-- Dumped (from|by).*$/gm, '').trim();

function banner(title) {
  const bar = '─'.repeat(Math.max(0, 92 - title.length));
  return `-- ══ ${title} ${bar}`;
}

// ── Event triggers ───────────────────────────────────────────────────────────────────────────────
// Cluster-level objects, not schema-scoped, so `--schema=public` never sees them — the same blind
// spot as the pg_cron schedule, and with the same consequence: the restore succeeds and something
// stops happening.
//
// This project has ONE of its own: `ensure_rls`, which fires on CREATE TABLE and enables RLS on the
// new table. Its FUNCTION lives in public and so travels with the main dump; the trigger that fires
// it does not. Restoring without it gives you a database that has the machinery and never starts it
// — new tables land with RLS off and become anon-readable, which is precisely the hole the trigger
// exists to close, in the environment where it matters most.
//
// Supabase's own six (pgrst_ddl_watch, issue_pg_cron_access, …) call functions in `extensions` and
// are provisioned with every project. Emitting those would fail on a fresh restore or, worse,
// duplicate platform behaviour — so ONLY triggers calling a `public.` function are carried.
//
// Read from the catalog with psql rather than a second pg_dump. pg_dump has no flag that says "just
// the event triggers" — you would have to dump the WHOLE database unfiltered and grep, and on
// Supabase that means auth, storage, realtime and vault as well: minutes, for seven lines. psql sits
// next to pg_dump in whatever install provided it, so this costs one round trip.
//
// There is no pg_get_eventtriggerdef(), so the statement is rebuilt from the catalog. Joining
// pg_proc → pg_namespace (rather than casting to regproc) is what makes the `public` filter exact:
// a regproc cast omits the schema whenever it is on the search_path, which is precisely when we
// most need to know it.
function eventTriggers(pgDump, dbUrl) {
  const psql = pgDump.replace(/pg_dump$/, 'psql');
  const sql = `
    select format('CREATE EVENT TRIGGER %I ON %s%s EXECUTE FUNCTION %I.%I();',
      e.evtname, e.evtevent,
      case when e.evttags is null then ''
           else ' WHEN TAG IN (' ||
                (select string_agg(quote_literal(t), ', ') from unnest(e.evttags) t) || ')' end,
      n.nspname, p.proname)
    from pg_event_trigger e
    join pg_proc p      on p.oid = e.evtfoid
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
    order by e.evtname;`;
  try {
    const out = execSync(`"$PSQL" "$SUPABASE_DB_URL" -At -c "$SQL"`, {
      encoding: 'utf8',
      env: { ...process.env, PSQL: psql, SUPABASE_DB_URL: dbUrl, SQL: sql },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return null;                       // non-fatal: the main dump is what matters
  }
}

// Which schema each extension must live in — DETECTED from the dump, never assumed.
//
// pg_dump schema-qualifies every type it references, so `description_embedding public.vector(1536)`
// is the database telling us where its vector extension actually is. On this project that is
// `public`, not the `extensions` schema Supabase's dashboard toggle uses by default.
//
// That mismatch cost a restore: enabling vector from the prod dashboard put it in `extensions`, the
// preamble's `create extension if not exists vector` then found one already present and did
// nothing, and the restore died 1000 lines later on
//   ERROR 42704: type "public.vector" does not exist
// A hardcoded schema here would be a second copy of a fact only the source database owns.
function extensionSchema(body, ext) {
  const m = body.match(new RegExp(`\\b([a-z_]+)\\.${ext}(?:\\(|_)`));
  return m ? m[1] : null;
}

function build(body, pgDumpVersion, evtTriggers) {
  const pre = [
    banner('PREAMBLE — added by scripts/dump-schema.mjs, NOT from pg_dump'),
    '--',
    '-- Extensions live outside `public`, which a --schema=public dump does not visit. Without',
    '-- these the restore fails on the first vector column.',
    '--',
    '-- THE SCHEMA MATTERS, and it is detected from this dump rather than assumed. pg_dump writes',
    '-- `public.vector(1536)`, so the type must resolve in `public` — enabling vector from the',
    '-- Supabase dashboard puts it in `extensions` instead, and then a restore dies ~1000 lines in',
    '-- with: ERROR 42704: type "public.vector" does not exist.',
    '--',
    '-- If an extension is already installed in the WRONG schema, `if not exists` will not move it.',
    '-- Drop and recreate it: drop extension vector; create extension vector with schema public;',
    '',
    ...EXTENSIONS.map(e => {
      const schema = extensionSchema(body, e);
      return schema
        ? `create extension if not exists ${e} with schema ${schema};`
        : `create extension if not exists ${e};`;   // nothing in public references it — cron
    }),
    '',
    banner('pg_dump output begins'),
    '',
  ].join('\n');

  const post = [
    '',
    banner('POSTAMBLE — added by scripts/dump-schema.mjs, NOT from pg_dump'),
    '--',
    '-- Scheduled jobs live in the `cron` schema, so a public-only dump silently drops them.',
    '-- This is the failure that does not announce itself: the restore succeeds, the app works,',
    '-- and notifications grow without bound until someone goes looking.',
    '--',
    '-- Re-running cron.schedule with an existing job name UPDATES it, so this is idempotent.',
    '',
    ...CRON_JOBS.map(j =>
      `select cron.schedule(${q(j.name)}, ${q(j.schedule)}, ${q(j.command)});`),
    '',
    ...(evtTriggers === null ? [
      '-- ⚠️ Event triggers could NOT be read (the second pg_dump pass failed). If this project has',
      '--    any of its own, they are MISSING from this file. Check with:',
      "--      select evtname, evtevent, evttags from pg_event_trigger where evtname not like 'issue_%';",
      '',
    ] : evtTriggers.length ? [
      '-- ── Event triggers ──',
      '-- Cluster-level, so a --schema=public dump never sees them. `ensure_rls` fires on CREATE',
      '-- TABLE and enables RLS on the new table: its FUNCTION travels with the dump, the trigger',
      '-- that fires it does not. Without this the database has the machinery and never starts it,',
      '-- and every table added later is anon-readable.',
      '--',
      "-- Supabase's own six (pgrst_ddl_watch, issue_pg_cron_access, …) call functions in",
      '-- `extensions` and come with every project — deliberately not carried.',
      '',
      ...evtTriggers.flatMap(t => {
        const name = t.match(/CREATE EVENT TRIGGER (\w+)/)?.[1];
        // Not idempotent otherwise — CREATE EVENT TRIGGER errors if the name is taken, which would
        // abort the whole restore on a re-run.
        return [name ? `drop event trigger if exists ${name};` : '', t, ''];
      }),
    ] : []),
    banner('end'),
    '',
  ].join('\n');

  const header = [
    '-- ─────────────────────────────────────────────────────────────────────────────',
    '-- spattoo — schema baseline.  GENERATED FILE — do not hand-edit.',
    '--',
    '-- Regenerate:  node scripts/dump-schema.mjs',
    '-- Verify:      node scripts/dump-schema.mjs --check',
    '--',
    '-- This is a SNAPSHOT of the live schema, not a migration. Schema changes still ship as',
    '-- numbered files in migrations/; this captures the result so a fresh environment can be',
    '-- built from today rather than replayed from 007 (which is impossible — the tables the',
    '-- first six migrations made were never captured in this repo).',
    `--`,
    `-- Captured with: ${pgDumpVersion}`,
    '-- ─────────────────────────────────────────────────────────────────────────────',
    '',
  ].join('\n');

  return `${header}${pre}${body}\n${post}`;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function main() {
  const pgDumpVersion = requirePgDump();
  if (!DB_URL) {
    fail('SUPABASE_DB_URL is not set.',
      `  Supabase → Project Settings → Database → Connection string → URI.\n` +
      `  Use the DIRECT connection (port 5432). The transaction pooler (6543) cannot\n` +
      `  serve pg_dump — it will connect and then fail partway through.\n\n` +
      `  This is a superuser-grade credential. Pass it on the command line rather than\n` +
      `  committing it:\n` +
      `    SUPABASE_DB_URL='postgresql://…' node scripts/dump-schema.mjs`);
  }

  console.log(`\n▶ dump-schema  (${pgDumpVersion})`);

  let body;
  try {
    body = execSync(
      `"$PG_DUMP" "$SUPABASE_DB_URL" --schema-only --no-owner --no-privileges --schema=public`,
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SUPABASE_DB_URL: DB_URL, PG_DUMP }, stdio: ['ignore', 'pipe', 'inherit'] },
    );
  } catch (e) {
    fail(`pg_dump failed (exit ${e.status}). Its stderr is above.`,
      `  Most common causes:\n` +
      `    • pooler URL instead of the direct one (use port 5432)\n` +
      `    • pg_dump older than the server\n` +
      `    • the password in the URI needs percent-encoding`);
  }

  // ── Strip pg_dump 18's psql meta-commands ───────────────────────────────────────────────────
  // pg_dump 18 wraps its output in a matched pair:
  //
  //   \restrict   <random token>
  //   …
  //   \unrestrict <random token>
  //
  // They are psql DIRECTIVES, not SQL — hardening added so that a hostile object name cannot
  // smuggle psql meta-commands into a restore that is being piped through psql. Any other client
  // sees a bare backslash and stops: the Supabase SQL editor fails the whole script on
  //   ERROR: 42601: syntax error at or near "\"
  // at line 31, having executed nothing.
  //
  // Safe to remove HERE specifically, because the protection is meaningless where it lands. It
  // guards psql's interpretation of meta-commands; a client that does not interpret meta-commands
  // has nothing to guard. This file's whole purpose is to be pasted into a SQL editor.
  //
  // Only matters with pg_dump ≥ 18. Harmless on older clients — the lines simply are not there.
  const restrictLines = (body.match(/^\\(un)?restrict\b.*$/gm) || []).length;
  body = body.replace(/^\\(un)?restrict\b.*$\n?/gm, '');

  // ── Fixups for a MANAGED platform ───────────────────────────────────────────────────────────
  // pg_dump assumes it is restoring into a bare Postgres it has full rights over. Supabase hands
  // you a database that already exists, with a `public` schema it owns. Two statements collide:
  //
  //   CREATE SCHEMA public;
  //     Emitted since PG 15, when public stopped being treated as always-present. Every Supabase
  //     project already has one → ERROR 42P06, and because the editor runs the file as one
  //     implicit transaction, the whole 700-statement restore rolls back on line 51.
  //     → made IF NOT EXISTS: still correct against a bare Postgres, a no-op here.
  //
  //   COMMENT ON SCHEMA public IS 'standard public schema';
  //     Requires ownership of the schema, which the `postgres` role may not have on a managed
  //     platform. And the string is Postgres's OWN default comment — carrying it across restores
  //     nothing and describes nothing.
  //     → dropped. This is the one place the baseline deliberately differs from the source.
  const fixups = [];
  if (/^CREATE SCHEMA public;$/m.test(body)) {
    body = body.replace(/^CREATE SCHEMA public;$/m, 'CREATE SCHEMA IF NOT EXISTS public;');
    fixups.push('CREATE SCHEMA public → IF NOT EXISTS');
  }
  if (/^COMMENT ON SCHEMA public IS 'standard public schema';$/m.test(body)) {
    body = body.replace(/^COMMENT ON SCHEMA public IS 'standard public schema';$\n?/m, '');
    fixups.push("dropped COMMENT ON SCHEMA public (Postgres's own default)");
  }

  // A dump that "succeeded" with nothing in it is the outcome worth catching: an empty file
  // committed as the baseline looks exactly like a schema that has not drifted.
  const tables   = (body.match(/^CREATE TABLE /gm)   || []).length;
  const funcs    = (body.match(/^CREATE FUNCTION /gm) || []).length;
  const policies = (body.match(/^CREATE POLICY /gm)  || []).length;
  const indexes  = (body.match(/^CREATE (UNIQUE )?INDEX /gm) || []).length;
  if (!tables) fail('pg_dump returned no tables — refusing to write an empty baseline.');

  const evtTriggers = eventTriggers(PG_DUMP, DB_URL);
  const out = build(body, pgDumpVersion, evtTriggers);

  if (CHECK) {
    if (!existsSync(OUT)) fail(`No baseline at ${OUT}. Run without --check to create it.`);
    const committed = readFileSync(OUT, 'utf8');
    if (stripVolatile(committed) === stripVolatile(out)) {
      console.log(`✓ baseline is current  (${tables} tables, ${funcs} functions, ${policies} policies)\n`);
      return;
    }
    fail('The committed baseline no longer matches the live schema.',
      `  Someone applied a change without recapturing. Regenerate and commit:\n` +
      `    node scripts/dump-schema.mjs`);
  }

  writeFileSync(OUT, out);
  console.log(`\n  tables    ${tables}`);
  console.log(`  functions ${funcs}`);
  console.log(`  policies  ${policies}`);
  console.log(`  indexes   ${indexes}`);
  console.log(`  extensions re-emitted: ${EXTENSIONS.join(', ')}`);
  if (restrictLines) console.log(`  psql meta-commands stripped: ${restrictLines} (\\restrict — pg_dump 18+)`);
  for (const f of fixups) console.log(`  managed-platform fixup: ${f}`);
  console.log(`  cron jobs re-emitted:  ${CRON_JOBS.map(j => j.name).join(', ')}`);
  console.log(`  event triggers:        ${evtTriggers === null ? '⚠ COULD NOT READ' : evtTriggers.length ? evtTriggers.map(t => t.match(/CREATE EVENT TRIGGER (\w+)/)?.[1]).join(', ') : 'none of our own'}`);
  console.log(`\n✓ wrote ${OUT.replace(ROOT + '/', '')}`);
  console.log(`\nNext: commit it. Then to build a fresh project —`);
  console.log(`  1. enable the extensions in the dashboard (Database → Extensions)`);
  console.log(`  2. run this file in the SQL editor`);
  console.log(`  3. node scripts/seed-lookups.mjs      (reference data)`);
  console.log(`  4. node scripts/migrate-master-to-prod.mjs   (the library)\n`);
}

main();
