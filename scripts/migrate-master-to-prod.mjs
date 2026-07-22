// ─────────────────────────────────────────────────────────────────────────────
// migrate-master-to-prod.mjs
//
// One-shot, idempotent, DB-DRIVEN migration of GLOBAL master data (and only the
// R2 objects those rows reference) from one environment to another — built for
// cloning dev's admin-authored library into a fresh PROD Supabase + R2 bucket.
//
// It NEVER touches tenant/transactional data (bakers, orders, subscriptions,
// designs, uploads, …) — the allowlist below is the whole surface it migrates.
//
// Because R2 keys are stored BARE (bucket-relative, e.g. `elements/files/2D/x.webp`),
// each object is copied to the SAME key in the prod bucket, so the DB rows need
// ZERO rewriting.
//
// Usage:
//   node scripts/migrate-master-to-prod.mjs --dry-run          # report only (safe)
//   node scripts/migrate-master-to-prod.mjs                    # do the migration
//   node scripts/migrate-master-to-prod.mjs --server-side      # R2 copy via CopyObject (needs one token w/ read on dev + write on prod)
//   node scripts/migrate-master-to-prod.mjs --skip-embeddings  # null description_embedding (regenerate in prod later)
//
// Env (put in spattoo-api/.env or the shell):
//   DEV_*  fall back to the plain names, so --dry-run works against the current .env with no extra setup:
//     DEV_SUPABASE_URL      (|| SUPABASE_URL)
//     DEV_SUPABASE_SERVICE_KEY (|| SUPABASE_SERVICE_KEY)
//     DEV_R2_ENDPOINT / DEV_R2_ACCESS_KEY_ID / DEV_R2_SECRET_ACCESS_KEY / DEV_R2_BUCKET  (|| R2_*)
//   PROD_* required for a real run:
//     PROD_SUPABASE_URL / PROD_SUPABASE_SERVICE_KEY
//     PROD_R2_ENDPOINT / PROD_R2_ACCESS_KEY_ID / PROD_R2_SECRET_ACCESS_KEY / PROD_R2_BUCKET
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';

const DRY_RUN         = process.argv.includes('--dry-run');
const SERVER_SIDE     = process.argv.includes('--server-side');
const SKIP_EMBEDDINGS = process.argv.includes('--skip-embeddings');

// ── Migration allowlist (config-driven — the ONLY tables touched) ─────────────
// Ordered so every FK target is migrated before the rows that reference it.
//   filter  — narrows to GLOBAL rows (exclude tenant/test-owned)
//   keyCols — columns holding R2 object keys to copy (element/template assets)
//   selfRef — a self-referencing FK column → rows are topo-sorted (parents first)
//   strip   — columns nulled on insert because they reference NON-migrated tenant/auth rows
const PLAN = [
  { table: 'element_types' },
  { table: 'cake_shapes' },                                   // before cake_templates in case templates.shape references it
  { table: 'flavours' },
  { table: 'nozzles' },
  { table: 'materials' },
  { table: 'cake_textures' },
  { table: 'text_styles' },
  { table: 'cake_elements',
    filter:  q => q.is('baker_id', null).is('customer_id', null),   // GLOBAL library only (drops test uploads)
    keyCols: ['image_url', 'thumbnail_url', 'thumb_key'],
    selfRef: 'parent_id',
    strip:   ['source_upload_id', 'promoted_by'] },                 // provenance → dev baker_uploads / auth.users (not migrated)
  { table: 'cake_templates',
    filter:  q => q.is('baker_id', null),                           // global templates only
    keyCols: ['thumbnail_url'],
    selfRef: 'parent_template_id' },
];

// ── Env resolution ────────────────────────────────────────────────────────────
const DEV = {
  supaUrl: process.env.DEV_SUPABASE_URL         || process.env.SUPABASE_URL,
  supaKey: process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY,
  r2: {
    endpoint: process.env.DEV_R2_ENDPOINT        || process.env.R2_ENDPOINT,
    keyId:    process.env.DEV_R2_ACCESS_KEY_ID    || process.env.R2_ACCESS_KEY_ID,
    secret:   process.env.DEV_R2_SECRET_ACCESS_KEY|| process.env.R2_SECRET_ACCESS_KEY,
    bucket:   process.env.DEV_R2_BUCKET           || process.env.R2_BUCKET,
  },
};
const PROD = {
  supaUrl: process.env.PROD_SUPABASE_URL,
  supaKey: process.env.PROD_SUPABASE_SERVICE_KEY,
  r2: {
    endpoint: process.env.PROD_R2_ENDPOINT,
    keyId:    process.env.PROD_R2_ACCESS_KEY_ID,
    secret:   process.env.PROD_R2_SECRET_ACCESS_KEY,
    bucket:   process.env.PROD_R2_BUCKET,
  },
};

const CHECKSUM = { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }; // R2 compat
const mkS3 = (r2) => new S3Client({ region: 'auto', endpoint: r2.endpoint, credentials: { accessKeyId: r2.keyId, secretAccessKey: r2.secret }, ...CHECKSUM });

function requireProd() {
  const missing = [];
  if (!PROD.supaUrl) missing.push('PROD_SUPABASE_URL');
  if (!PROD.supaKey) missing.push('PROD_SUPABASE_SERVICE_KEY');
  for (const [k, v] of Object.entries(PROD.r2)) if (!v) missing.push('PROD_R2_' + k.toUpperCase());
  if (missing.length) { console.error(`\n✖ Real run needs prod env vars: ${missing.join(', ')}\n  (run with --dry-run to preview against dev only)\n`); process.exit(1); }
}

// Order rows so a parent always precedes its children (self-referencing FK).
function topoSort(rows, idKey, parentKey) {
  const byId = new Map(rows.map(r => [r[idKey], r]));
  const out = [], seen = new Set();
  const visit = (r) => {
    if (seen.has(r[idKey])) return;
    const parent = r[parentKey] != null ? byId.get(r[parentKey]) : null;
    if (parent) visit(parent);                     // parent inside our set → emit it first
    seen.add(r[idKey]); out.push(r);
  };
  rows.forEach(visit);
  return out;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function bodyToBytes(body) { return Buffer.from(await body.transformToByteArray()); }

async function objectExists(s3, bucket, key) {
  try { await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })); return true; }
  catch (e) { if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return false; throw e; }
}

async function copyObject(devS3, prodS3, key, stats) {
  if (await objectExists(prodS3, PROD.r2.bucket, key)) { stats.skipped++; return; }
  if (SERVER_SIDE) {
    await prodS3.send(new CopyObjectCommand({ Bucket: PROD.r2.bucket, Key: key, CopySource: `${DEV.r2.bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}` }));
  } else {
    const got = await devS3.send(new GetObjectCommand({ Bucket: DEV.r2.bucket, Key: key }));
    const bytes = await bodyToBytes(got.Body);
    await prodS3.send(new PutObjectCommand({ Bucket: PROD.r2.bucket, Key: key, Body: bytes, ContentType: got.ContentType || 'application/octet-stream' }));
  }
  stats.copied++;
}

async function main() {
  console.log(`\n▶ migrate-master-to-prod  ${DRY_RUN ? '(DRY RUN — no writes)' : '(LIVE)'}${SERVER_SIDE ? '  [server-side copy]' : ''}${SKIP_EMBEDDINGS ? '  [skip embeddings]' : ''}`);
  if (!DEV.supaUrl || !DEV.supaKey) { console.error('✖ Missing DEV Supabase creds (DEV_SUPABASE_URL/KEY or SUPABASE_URL/KEY)'); process.exit(1); }
  if (!DRY_RUN) requireProd();

  const devSb  = createClient(DEV.supaUrl, DEV.supaKey);
  const prodSb = (!DRY_RUN || PROD.supaKey) && PROD.supaUrl ? createClient(PROD.supaUrl, PROD.supaKey) : null;
  const devS3  = mkS3(DEV.r2);
  const prodS3 = (!DRY_RUN || PROD.r2.endpoint) && PROD.r2.endpoint ? mkS3(PROD.r2) : null;

  const allKeys = new Set();
  const objStats = { copied: 0, skipped: 0 };
  let totalRows = 0;

  for (const step of PLAN) {
    // 1. Read GLOBAL rows from dev
    let q = devSb.from(step.table).select('*');
    if (step.filter) q = step.filter(q);
    const { data: rows, error } = await q;
    if (error) { console.error(`  ✖ ${step.table}: read failed — ${error.message}`); process.exit(1); }

    // 2. Collect R2 keys this step references
    const keys = [];
    if (step.keyCols) for (const r of rows) for (const c of step.keyCols) if (r[c]) { keys.push(r[c]); allKeys.add(r[c]); }

    console.log(`\n• ${step.table}: ${rows.length} rows${step.keyCols ? `, ${keys.length} object refs` : ''}`);
    totalRows += rows.length;

    // 3. Copy the referenced R2 objects (dev → prod)
    if (keys.length && !DRY_RUN) {
      for (const batch of chunk(keys, 12)) await Promise.all(batch.map(k => copyObject(devS3, prodS3, k, objStats)));
    }

    // 4. Prepare + upsert rows into prod (preserve id; strip tenant/auth FKs; topo-sort self-refs)
    let toInsert = rows.map(r => {
      const row = { ...r };
      if (step.strip) for (const c of step.strip) row[c] = null;
      if (SKIP_EMBEDDINGS && 'description_embedding' in row) row.description_embedding = null;
      return row;
    });
    if (step.selfRef) toInsert = topoSort(toInsert, 'id', step.selfRef);

    if (!DRY_RUN) {
      for (const batch of chunk(toInsert, 500)) {
        const { error: upErr } = await prodSb.from(step.table).upsert(batch, { onConflict: 'id' });
        if (upErr) { console.error(`  ✖ ${step.table}: upsert failed — ${upErr.message}`); process.exit(1); }
      }
      console.log(`  ✔ upserted ${toInsert.length}`);
    }
  }

  console.log(`\n── summary ──`);
  console.log(`rows planned:    ${totalRows}`);
  console.log(`R2 objects refd: ${allKeys.size}`);
  if (!DRY_RUN) {
    console.log(`R2 copied:       ${objStats.copied}   (already-present skipped: ${objStats.skipped})`);
    // Verify row-count parity per table
    console.log(`\n── verify (prod counts) ──`);
    for (const step of PLAN) {
      let dq = devSb.from(step.table).select('*', { count: 'exact', head: true }); if (step.filter) dq = step.filter(dq);
      const { count: devN } = await dq;
      const { count: prodN } = await prodSb.from(step.table).select('*', { count: 'exact', head: true });
      console.log(`  ${step.table.padEnd(16)} dev(global)=${devN}  prod(total)=${prodN}  ${prodN >= devN ? '✔' : '✖ MISMATCH'}`);
    }
    console.log(`\nNext: HEAD a few prod objects and fetch a couple via https://spattoocdn.com/<key> to confirm CDN serving.`);
  } else {
    console.log(`\n(DRY RUN) Would copy ${allKeys.size} objects and upsert ${totalRows} rows into prod. No changes made.`);
  }
}

main().catch(e => { console.error('FATAL:', e?.message || e); process.exit(1); });
