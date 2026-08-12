#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// seed-lookups.mjs — clone the REFERENCE tables from one environment to another.
//
// ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
// deployment/production-rollout.md §5 says reference tables "come from the
// schema/migrations, NOT this script [migrate-master-to-prod]". That cannot be
// true, and believing it is how prod launches broken:
//
//   • the schema arrives as a SCHEMA-ONLY dump, which by definition carries no rows
//   • the migrations that hold the INSERTs are not replayable (see dump-schema.mjs
//     — the first six do not exist, and supabase/ has no apply order)
//
// So nothing seeds them, and a fresh prod comes up with an empty `order_statuses`
// (no order can be created), an empty `element_action_types` (migration 061's
// `move` capability does not exist, so nothing on a cake is draggable), an empty
// `capabilities` (deny-by-default RBAC denies everything), and eleven more.
//
// migrate-master-to-prod.mjs handles the admin-AUTHORED library — elements,
// templates, tags, the things with pictures. This handles the vocabularies the
// CODE speaks: statuses, roles, plans, notification types. Two scripts because
// they fail differently: the library is content and can be topped up later, these
// are contracts and the app does not boot in a useful state without them.
//
// ── WHY NOT ONE SCRIPT ───────────────────────────────────────────────────────
// The other one copies R2 objects, rewrites asset hosts, and topo-sorts self-refs.
// None of that applies to a table of thirteen order statuses. Folding these in
// would mean every row here paying the deep asset walk to be told it has no assets.
//
// Usage:
//   node scripts/seed-lookups.mjs --dry-run        # read dev, write nothing
//   node scripts/seed-lookups.mjs                  # real run
//
// Env — identical convention to migrate-master-to-prod.mjs, so one .env serves both.
//   DEV_SUPABASE_URL / DEV_SUPABASE_SERVICE_KEY   (fall back to SUPABASE_URL / SUPABASE_SERVICE_KEY)
//   PROD_SUPABASE_URL / PROD_SUPABASE_SERVICE_KEY (required for a real run)
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.argv.includes('--dry-run');
const SEQ_SQL_PATH = join(ROOT, 'supabase', 'seed-sequences.sql');

// ── The allowlist ─────────────────────────────────────────────────────────────
// Every conflict target and every `sequence` flag below was derived from supabase/schema.sql — a
// dump of the live database — and NOT from the CREATE TABLE in supabase/*.sql. Those files have
// drifted: order_statuses is keyed on `id` there and on `key` in the file, and subscription_plans
// and billing_periods are `integer` live where the file says `uuid`. Re-derive from a fresh dump
// rather than from a file if this list ever needs revisiting.
//
//   conflict — upsert target. DEFAULTS TO 'id'; text-keyed and composite tables say so.
//   sequence — the PK is serial/identity. Inserting explicit ids does NOT advance the
//              sequence, so the first row prod creates ITSELF collides. See below.
//   review   — print the rows. For tables a human should eyeball before go-live, because
//              dev is where things get poked at and the poking travels.
//
// Ordered so FK targets precede the rows that reference them (roles + capabilities
// before the matrix that joins them). Everything else here is independent.
// Exported so scripts/seed-lookups-sql.mjs emits the SAME sixteen tables in the SAME order with
// the SAME conflict targets. A second copy of this list is exactly how the two paths would come to
// disagree about, say, whether order_statuses keys on `id` or `key`.
export const PLAN = [
  // ── RBAC. Deny-by-default: empty tables mean every admin route 403s. ──
  { table: 'capabilities',            conflict: 'key' },
  { table: 'roles',                   conflict: 'key' },
  { table: 'role_capabilities',       conflict: 'role_key,capability_key' },   // composite PK, no id

  // ── Vocabularies the code speaks by key ──
  // order_statuses conflicts on `id`, NOT `key`, and is identity-backed. supabase/order_statuses.sql
  // says the PK is `key` with no id column at all — that file is stale. The live schema has
  // `order_statuses_pkey PRIMARY KEY (id)` with `key` demoted to a unique constraint, and dev holds
  // 11 rows to the file's 9 (`quote_approved` among them). Trusting the file here would have seeded
  // the wrong shape AND missed two statuses. Taken from supabase/schema.sql, which is the point of it.
  { table: 'order_statuses',          conflict: 'id', sequence: true },
  { table: 'design_session_statuses', conflict: 'id' },
  { table: 'element_action_types',    conflict: 'id' },                        // `move` (migration 061)
  { table: 'dietary_requirements',    conflict: 'id', sequence: true },
  { table: 'notification_types',      conflict: 'id', sequence: true },        // notifications.type_id FKs this

  // ── Billing + commerce. Prices and entitlements: read them before you trust them. ──
  //
  // subscription_statuses and payment_providers exist in NO file in this repo — they were found by
  // diffing supabase/schema.sql against it, along with 12 other tables including `orders` and
  // `bakers`. An empty subscription_statuses is the worst of the set: baker_subscriptions.status_id
  // is a FK to it, so every subscription insert would fail on a constraint, and the first symptom
  // would be a baker unable to pay.
  { table: 'subscription_statuses',   conflict: 'id' },                        // baker_subscriptions.status_id FKs this
  { table: 'payment_providers',       conflict: 'id', review: ['name', 'is_active'] },
  { table: 'billing_periods',         conflict: 'id' },
  { table: 'subscription_plans',      conflict: 'id', review: ['name', 'price_monthly', 'price_yearly', 'is_active'] },
  { table: 'cancellation_reasons',    conflict: 'id' },
  { table: 'credit_costs',            conflict: 'id', sequence: true, review: ['action_key', 'credits', 'is_active'] },
  { table: 'credit_packs',            conflict: 'id', sequence: true, review: ['pack_key', 'credits', 'price_paise', 'is_active'] },

  // ── Storefront ──
  { table: 'storefront_themes',       conflict: 'id', review: ['key', 'name', 'is_premium', 'is_active'] },
];

// ── Deliberately NOT here ─────────────────────────────────────────────────────
//
// `admins` — its PK is a FK to auth.users, and a new Supabase project has no users.
// Copying dev's rows would insert admins pointing at user ids that do not exist, which
// the FK rejects; and if it somehow did not, it would grant platform access to accounts
// nobody can log into. Bootstrapping the first admin is a MANUAL step, in this order:
//
//   1. create the auth user in the prod project (Authentication → Users → Add user)
//   2. insert into admins (auth_user_id, role, email) values ('<that uuid>', 'admin', '<email>');
//   3. verify: the admin app should load rather than 403
//
// Until step 2 nobody can administer prod — including to fix step 2. Do it early.
//
// `legal_document_versions` — published, not copied. Publishing is what flips the consent
// gate on for every user; it wants its own decision. See scripts/publish-legal-version.mjs.

const DEV = {
  url: process.env.DEV_SUPABASE_URL         || process.env.SUPABASE_URL,
  key: process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY,
};
const PROD = {
  url: process.env.PROD_SUPABASE_URL,
  key: process.env.PROD_SUPABASE_SERVICE_KEY,
};

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

// setval via pg_get_serial_sequence, which resolves BOTH `serial` (notification_types) and
// `GENERATED BY DEFAULT AS IDENTITY` (dietary_requirements, credit_costs, credit_packs).
//
// This is emitted as SQL rather than executed because supabase-js speaks PostgREST, which has
// no way to run it — there is no RPC for setval and adding one to prod purely so this script
// can call it would be a worse trade than pasting four lines into the SQL editor.
//
// Skipping it is not cosmetic. Seeding notification_types with explicit ids 1..14 leaves its
// sequence at 1, so the fifteenth notification type anyone adds tries to be id 1 and hits the
// primary key. Months later, from the admin UI, for no visible reason.
function sequenceSql(steps) {
  const lines = [
    '-- ─────────────────────────────────────────────────────────────────────────────',
    '-- Sequence resync after seed-lookups.mjs.  GENERATED — run once, in the SQL editor.',
    '--',
    '-- These tables have serial/identity primary keys and were seeded with EXPLICIT ids to',
    '-- keep both environments consistent. An explicit id does not advance the sequence, so',
    '-- without this the next row the app inserts collides on the primary key.',
    '-- ─────────────────────────────────────────────────────────────────────────────',
    '',
  ];
  for (const s of steps) {
    lines.push(
      `select setval(pg_get_serial_sequence('public.${s.table}', 'id'),`,
      `              coalesce((select max(id) from public.${s.table}), 1));`,
      '');
  }
  return lines.join('\n');
}

function printReview(table, cols, rows) {
  console.log(`  ┌ review — confirm these are the values you want in PROD:`);
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)));
  console.log(`  │ ${cols.map((c, i) => c.padEnd(widths[i])).join('  ')}`);
  for (const r of rows) {
    console.log(`  │ ${cols.map((c, i) => String(r[c] ?? '').padEnd(widths[i])).join('  ')}`);
  }
  console.log(`  └`);
}

async function main() {
  console.log(`\n▶ seed-lookups  ${DRY_RUN ? '(DRY RUN — no writes)' : '(LIVE)'}`);

  if (!DEV.url || !DEV.key) {
    console.error('✖ Missing DEV Supabase creds (DEV_SUPABASE_URL/KEY, or SUPABASE_URL/KEY)');
    process.exit(1);
  }
  if (!DRY_RUN && (!PROD.url || !PROD.key)) {
    console.error('\n✖ Real run needs PROD_SUPABASE_URL and PROD_SUPABASE_SERVICE_KEY.');
    console.error('  (run with --dry-run to preview against dev only)\n');
    process.exit(1);
  }

  const devSb  = createClient(DEV.url, DEV.key);
  const prodSb = DRY_RUN ? null : createClient(PROD.url, PROD.key);

  let total = 0;
  const empties = [];

  for (const step of PLAN) {
    const { data: rows, error } = await devSb.from(step.table).select('*');
    if (error) {
      console.error(`  ✖ ${step.table}: read failed — ${error.message}`);
      process.exit(1);
    }

    console.log(`\n• ${step.table}: ${rows.length} rows`);
    total += rows.length;

    // An empty source table is almost never intended here — these are vocabularies, and a
    // vocabulary with no words means the seed migration never ran on DEV either. Copying
    // nothing would faithfully reproduce that, so say it instead.
    if (!rows.length) { empties.push(step.table); console.log(`  ⚠ empty in dev — nothing to copy`); continue; }

    if (step.review) printReview(step.table, step.review, rows);

    if (!DRY_RUN) {
      for (const batch of chunk(rows, 500)) {
        const { error: upErr } = await prodSb.from(step.table).upsert(batch, { onConflict: step.conflict ?? 'id' });
        if (upErr) {
          console.error(`  ✖ ${step.table}: upsert failed — ${upErr.message}`);
          process.exit(1);
        }
      }
      console.log(`  ✔ upserted ${rows.length}`);
    }
  }

  const seqSteps = PLAN.filter(s => s.sequence);
  writeFileSync(SEQ_SQL_PATH, sequenceSql(seqSteps));

  console.log(`\n── summary ──`);
  console.log(`tables:  ${PLAN.length}`);
  console.log(`rows:    ${total}`);
  if (empties.length) console.log(`⚠ EMPTY IN DEV: ${empties.join(', ')} — check dev before trusting this run`);

  if (!DRY_RUN) {
    console.log(`\n── verify (row-count parity) ──`);
    let mismatch = 0;
    for (const step of PLAN) {
      const { count: devN }  = await devSb.from(step.table).select('*', { count: 'exact', head: true });
      const { count: prodN } = await prodSb.from(step.table).select('*', { count: 'exact', head: true });
      const ok = prodN >= devN;
      if (!ok) mismatch++;
      console.log(`  ${step.table.padEnd(24)} dev=${String(devN).padStart(3)}  prod=${String(prodN).padStart(3)}  ${ok ? '✔' : '✖ MISMATCH'}`);
    }
    if (mismatch) { console.error(`\n✖ ${mismatch} table(s) short in prod.\n`); process.exit(1); }
  }

  console.log(`\n── REQUIRED next step ──`);
  console.log(`Run this in the prod SQL editor — the seeded ids do not advance their sequences,`);
  console.log(`so without it the next insert on ${seqSteps.map(s => s.table).join(' / ')}`);
  console.log(`collides on the primary key:`);
  console.log(`  ${SEQ_SQL_PATH.replace(ROOT + '/', '')}`);
  console.log(`\nThen bootstrap the first admin (see the "Deliberately NOT here" note in this file) —`);
  console.log(`until that row exists, every admin route in prod returns 403.\n`);
}

// Only run when invoked directly — seed-lookups-sql.mjs imports PLAN from here and must not
// trigger a migration by doing so.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
