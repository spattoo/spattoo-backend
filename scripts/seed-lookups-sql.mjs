#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// seed-lookups-sql.mjs — emit the reference tables as a SQL file.
//
// Same sixteen tables, same rows, same order as seed-lookups.mjs. The difference
// is where the credential lives:
//
//   seed-lookups.mjs      needs a PROD SERVICE KEY on the machine running it
//   seed-lookups-sql.mjs  needs only DEV's, and produces a file you paste into
//                         the prod SQL editor — signed in as yourself, in a
//                         browser, with no prod secret leaving the dashboard
//
// That is the whole reason this exists. A service_role key is full read/write on
// every table with RLS bypassed; not having to put prod's on a laptop (or in a
// shell history, or a chat log) to seed 128 rows is worth a second entry point.
//
// It also means the seed arrives the same way the schema did — paste, run, read
// the result — instead of a second mechanism with its own failure modes.
//
// The ALLOWLIST IS IMPORTED, not restated. One list, one order, one set of
// conflict targets, so the two paths cannot come to disagree.
//
// Usage:
//   node scripts/seed-lookups-sql.mjs           # → supabase/seed-lookups.sql
//   node scripts/seed-lookups-sql.mjs --out /tmp/seed.sql
//
// Env: DEV_SUPABASE_URL / DEV_SUPABASE_SERVICE_KEY (|| SUPABASE_URL / SUPABASE_SERVICE_KEY)
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAN } from './seed-lookups.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = join(ROOT, 'supabase', 'schema.sql');
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? process.argv[outArg + 1] : join(ROOT, 'supabase', 'seed-lookups.sql');

const URL_ = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const KEY  = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

// ── Column types, read from the schema dump ──────────────────────────────────
// Needed because PostgREST hands back JavaScript, and JavaScript cannot tell you
// whether an array came from `text[]` or from `jsonb`. `feature_bullets` is the
// first and `features` is the second, and they need different literals:
//
//   text[]  →  ARRAY['a','b']::text[]
//   jsonb   →  '["a","b"]'::jsonb
//
// Guessing from the value would render one of them as the other, and Postgres
// would take it — a jsonb column holding a Postgres array literal as a string.
// The declared type is the only thing that actually knows.
function columnTypes(sql) {
  const out = {};
  const re = /^CREATE TABLE public\.([a-z_]+) \(\n([\s\S]*?)^\);$/gm;
  let m;
  while ((m = re.exec(sql))) {
    const cols = {};
    for (const line of m[2].split('\n')) {
      const c = line.match(/^\s{4}([a-z_]+)\s+(.+?)(?:\s+DEFAULT\b|\s+NOT NULL\b|,\s*$|\s*$)/);
      if (c) cols[c[1]] = c[2].trim().replace(/,$/, '');
    }
    out[m[1]] = cols;
  }
  return out;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function literal(v, type) {
  if (v === null || v === undefined) return 'NULL';
  const t = (type || 'text').toLowerCase();

  if (t.endsWith('[]')) {
    if (!Array.isArray(v)) return 'NULL';
    if (!v.length) return `'{}'::${t}`;
    return `ARRAY[${v.map(x => q(x)).join(', ')}]::${t}`;
  }
  if (t === 'jsonb' || t === 'json') return `${q(JSON.stringify(v))}::${t}`;
  if (t === 'boolean') return v ? 'true' : 'false';
  if (/^(smallint|integer|bigint|numeric|real|double)/.test(t)) return String(v);
  return q(v);                                   // text, uuid, timestamptz, …
}

function tableBlock(step, rows, types) {
  const table = step.table;
  const conflict = (step.conflict ?? 'id').split(',').map(s => s.trim());
  const cols = Object.keys(rows[0]);
  const colTypes = types[table] || {};

  // Everything that is not part of the conflict target gets refreshed on re-run. When the conflict
  // target IS every column — role_capabilities is (role_key, capability_key) and has no others —
  // there is nothing to update, and `DO UPDATE SET` with an empty list is a syntax error.
  const updatable = cols.filter(c => !conflict.includes(c));
  const action = updatable.length
    ? `DO UPDATE SET\n    ${updatable.map(c => `${c} = EXCLUDED.${c}`).join(',\n    ')}`
    : 'DO NOTHING';

  const values = rows
    .map(r => `  (${cols.map(c => literal(r[c], colTypes[c])).join(', ')})`)
    .join(',\n');

  return [
    `-- ${table} — ${rows.length} row${rows.length === 1 ? '' : 's'}`,
    `INSERT INTO public.${table} (${cols.join(', ')}) VALUES`,
    values,
    `ON CONFLICT (${conflict.join(', ')}) ${action};`,
    '',
  ].join('\n');
}

async function main() {
  if (!URL_ || !KEY) {
    console.error('✖ Missing DEV Supabase creds (DEV_SUPABASE_URL/KEY, or SUPABASE_URL/KEY)');
    process.exit(1);
  }
  if (!existsSync(SCHEMA)) {
    console.error(`✖ ${SCHEMA} not found — run \`npm run db:schema\` first.`);
    console.error('  Column types come from the dump; without it text[] and jsonb are indistinguishable.');
    process.exit(1);
  }

  console.log(`\n▶ seed-lookups-sql  (reading dev, writing SQL — no prod credential involved)`);

  const sb = createClient(URL_, KEY);
  const types = columnTypes(readFileSync(SCHEMA, 'utf8'));

  const blocks = [];
  const seqTables = [];
  let total = 0;

  for (const step of PLAN) {
    const { data: rows, error } = await sb.from(step.table).select('*');
    if (error) { console.error(`  ✖ ${step.table}: ${error.message}`); process.exit(1); }
    if (!rows.length) { console.log(`  ⚠ ${step.table}: empty in dev — skipped`); continue; }
    if (!types[step.table]) { console.error(`  ✖ ${step.table}: no column types in schema.sql — is the dump stale?`); process.exit(1); }

    blocks.push(tableBlock(step, rows, types));
    if (step.sequence) seqTables.push(step.table);
    total += rows.length;
    console.log(`  ${step.table.padEnd(24)} ${String(rows.length).padStart(3)} rows`);
  }

  const header = [
    '-- ─────────────────────────────────────────────────────────────────────────────',
    '-- spattoo — reference data.  GENERATED FILE — do not hand-edit.',
    '--',
    '-- Regenerate:  node scripts/seed-lookups-sql.mjs',
    '-- Apply:       paste into the target project\'s SQL editor and run.',
    '--',
    '-- The vocabularies the CODE speaks — statuses, roles, plans, notification types. Distinct',
    '-- from the admin-authored library (elements, templates, tags), which has pictures in R2 and',
    '-- travels via scripts/migrate-master-to-prod.mjs.',
    '--',
    '-- Every row is a snapshot of DEV at generation time, not a copy of the seed migrations —',
    '-- those have drifted. Idempotent: re-running refreshes rows rather than duplicating them.',
    '--',
    `-- ${PLAN.length} tables, ${total} rows.`,
    '-- ─────────────────────────────────────────────────────────────────────────────',
    '',
    'BEGIN;',
    '',
  ].join('\n');

  // ── Sequence resync ─────────────────────────────────────────────────────────
  // Inside the same transaction as the inserts, because the two are one operation: rows seeded with
  // explicit ids leave their sequence at 1, and the next insert the APP makes collides on the
  // primary key. Committing the rows without the resync would be committing that bug.
  //
  // pg_get_serial_sequence resolves both `serial` (notification_types) and
  // `GENERATED BY DEFAULT AS IDENTITY` (the other four).
  const seq = seqTables.length ? [
    `-- ── Sequence resync — ${seqTables.length} tables with serial/identity ids ──`,
    '-- Seeded with explicit ids, which does NOT advance the sequence. Without this the next row',
    '-- the app inserts collides on the primary key — months later, from the admin UI, for no',
    '-- visible reason.',
    '',
    ...seqTables.map(t =>
      `select setval(pg_get_serial_sequence('public.${t}', 'id'), coalesce((select max(id) from public.${t}), 1));`),
    '',
  ].join('\n') : '';

  writeFileSync(OUT, `${header}${blocks.join('\n')}\n${seq}\nCOMMIT;\n`);

  console.log(`\n  ${PLAN.length} tables, ${total} rows`);
  console.log(`  sequence resync included for: ${seqTables.join(', ')}`);
  console.log(`\n✓ wrote ${OUT.replace(ROOT + '/', '')}`);
  console.log(`\nWrapped in BEGIN/COMMIT — it applies completely or not at all.`);
  console.log(`Paste it into the prod SQL editor. No prod service key needed.\n`);
}

main();
