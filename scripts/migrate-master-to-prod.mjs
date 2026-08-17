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
//     DEV_R2_PUBLIC_URL     (|| R2_PUBLIC_URL)   — the base dev's stored URLs were written with
//   PROD_* required for a real run:
//     PROD_SUPABASE_URL / PROD_SUPABASE_SERVICE_KEY
//     PROD_R2_ENDPOINT / PROD_R2_ACCESS_KEY_ID / PROD_R2_SECRET_ACCESS_KEY / PROD_R2_BUCKET
//     PROD_R2_PUBLIC_URL    — template designs embed absolute URLs; without this they keep dev's host
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
// The admin export's own asset walk. lib/assetKeys.js deliberately imports nothing but the folder
// list, so this stays runnable with only Supabase credentials — importing it via signUpload.js or
// promotionBundle.js would drag in config.js and refuse to start without an OpenAI key.
import { assetKeysIn, rewriteAssetHost, countAssetUrls } from '../src/lib/assetKeys.js';
import { pathToFileURL } from 'node:url';

const DRY_RUN         = process.argv.includes('--dry-run');
const SERVER_SIDE     = process.argv.includes('--server-side');
const SKIP_EMBEDDINGS = process.argv.includes('--skip-embeddings');

// ── Migration allowlist (config-driven — the ONLY tables touched) ─────────────
// Ordered so every FK target is migrated before the rows that reference it.
//   filter   — narrows to GLOBAL rows (exclude tenant/test-owned)
//   conflict — the upsert's conflict target. DEFAULTS TO 'id'; the join tables have
//              COMPOSITE primary keys and no id column at all, so they must say so.
//   selfRef  — a self-referencing FK column → rows are topo-sorted (parents first)
//   strip    — columns nulled on insert because they reference NON-migrated tenant/auth rows
//
// R2 keys are NOT declared per table. Every row is deep-walked with the same `assetKeysIn` the
// admin export uses, so any column or nested jsonb value holding a managed key is copied — see
// "the walk, not a column list" below.
export const PLAN = [
  { table: 'element_types' },
  { table: 'tags' },                                          // vocabulary — before element_tags / template_tags reference it
  { table: 'cake_shapes' },                                   // before cake_templates in case templates.shape references it
  { table: 'flavours' },
  { table: 'nozzles' },
  { table: 'materials' },
  { table: 'cake_textures' },
  { table: 'text_styles' },
  { table: 'cake_elements',
    filter:  q => q.is('baker_id', null).is('customer_id', null),   // GLOBAL library only (drops test uploads)
    selfRef: 'parent_id',
    strip:   ['source_upload_id', 'promoted_by'] },                 // provenance → dev baker_uploads / auth.users (not migrated)
  { table: 'element_tags',
    conflict: 'element_id,tag_id',                                  // composite PK, no id column
    parents:  { element_id: 'cake_elements', tag_id: 'tags' } },
  { table: 'element_craft_guide',
    filter:   q => q.is('baker_id', null),                          // a baker's own guide is tenant data — must not travel
    conflict: 'element_id,guide_type',                              // composite PK: one guide per element PER TYPE
    parents:  { element_id: 'cake_elements' } },
  { table: 'cake_templates',
    filter:  q => q.is('baker_id', null),                           // global templates only
    selfRef: 'parent_template_id' },
  { table: 'template_tags',
    conflict: 'template_id,tag_id',
    parents:  { template_id: 'cake_templates', tag_id: 'tags' } },
  { table: 'cake_template_attrs',
    conflict: 'template_id',                                        // PK is the FK — one attrs row per template
    parents:  { template_id: 'cake_templates' } },
];

// ── Assets referenced by CODE, not by a row ──────────────────────────────────────────────────────
// This migration is row-driven: it deep-walks every migrated row and copies the objects those rows
// name. That is the right design for a catalogue, and structurally blind to an asset the CODE asks
// for by URL — no row mentions it, so the walk cannot find it, and `code/` is not in ALLOWED_FOLDERS
// so `assetKeysIn` would not recognise it even if one did.
//
// Found the hard way on 2026-08-13, after the first prod migration: the HDRI environment map was
// missing and had to be copied by hand.
//
// Missing it is not a broken image. `CakeCanvas.jsx` builds this URL from the host's assets base and
// falls back to a drei preset when it fails — a public CDN the comment there records as something
// that "503s/400s and, on failure, poisoned the shared loader cache → dimmed the studio". So the
// symptom is the whole designer lit wrongly, which reads as a rendering bug rather than a missing
// file.
//
// Keep in step with `ENV_HDR_PATH` in spattoo-core `src/designer/canvas/CakeCanvas.jsx`. If a second
// hardcoded asset path is ever added there, it belongs here too — there is no automatic link
// between the two repos, which is exactly why the first one was missed.
// All four sizes travel, not just the one in use. They are 1.9 MB together, and having them in prod
// means changing the look is a one-line edit to ENV_HDR_PATH rather than a resize, an upload and a
// migration re-run. The 1k stays because it is the original — the only one that can be re-derived
// from, and the fallback if a smaller map ever reads as too soft on gold leaf.
const STATIC_ASSETS = [
  'code/env/lebombo_1k.hdr',      // image-based lighting for the 3D canvas — the original
  'code/env/lebombo_512.hdr',     // 370 KB
  'code/env/lebombo_256.hdr',     //  96 KB — what ENV_HDR_PATH points at today
  'code/env/lebombo_128.hdr',     //  25 KB
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
  // The public base the DEV rows were written with. Needed even for --dry-run: it is how a URL
  // buried in a template's design is recognised as naming one of OUR objects.
  publicUrl: process.env.DEV_R2_PUBLIC_URL || process.env.R2_PUBLIC_URL,
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
  publicUrl: process.env.PROD_R2_PUBLIC_URL,
};

const CHECKSUM = { requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }; // R2 compat
const mkS3 = (r2) => new S3Client({ region: 'auto', endpoint: r2.endpoint, credentials: { accessKeyId: r2.keyId, secretAccessKey: r2.secret }, ...CHECKSUM });

function requireProd() {
  const missing = [];
  if (!PROD.supaUrl) missing.push('PROD_SUPABASE_URL');
  if (!PROD.supaKey) missing.push('PROD_SUPABASE_SERVICE_KEY');
  for (const [k, v] of Object.entries(PROD.r2)) if (!v) missing.push('PROD_R2_' + k.toUpperCase());
  // Not optional. Template designs embed fully-qualified URLs, so without the destination base every
  // global template would land in prod still pointing at the dev bucket — rendering perfectly, and
  // silently coupled to the environment it was migrated out of.
  if (!PROD.publicUrl) missing.push('PROD_R2_PUBLIC_URL');

  // The SOURCE base is required for the same reason, and was not checked until 2026-08-12.
  //
  // Rewriting needs both ends. Without the dev base, `assetKeysIn` cannot recognise a URL as naming
  // one of OUR objects, so `rewriteAssetHost` matches nothing — the 49 absolute URLs inside
  // cake_templates.design travel verbatim and prod's templates fetch their textures and GLBs from
  // the DEV bucket. Identical outcome to a missing PROD_R2_PUBLIC_URL, reached from the other side.
  //
  // It also loses objects: 2 of the assets named inside designs are referenced by no element row,
  // so with the base unknown nothing collects them (298 copied instead of 300) and those two
  // templates render broken in prod.
  //
  // The dry run says `(dev base unknown)` in its summary, but a dry run that prints a plausible
  // number is exactly what someone reads as "fine" before doing the real one.
  if (!DEV.publicUrl) missing.push('DEV_R2_PUBLIC_URL (or R2_PUBLIC_URL) — the base dev\'s rows were written with');
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

  // What each step actually carried, so a child table can filter itself to parents that exist.
  const migrated = new Map();
  const allKeys = new Set();
  const objStats = { copied: 0, skipped: 0 };
  let totalRows = 0, insertedRows = 0, urlsRewritten = 0;

  // Code-referenced assets first — they belong to no table, so there is no step that would carry
  // them, and doing them up front means a credentials problem surfaces on one small file rather
  // than 300 rows in.
  if (STATIC_ASSETS.length) {
    console.log(`\n• static assets (referenced by CODE, not by any row): ${STATIC_ASSETS.length}`);
    for (const k of STATIC_ASSETS) {
      allKeys.add(k);
      console.log(`    ${k}`);
      if (!DRY_RUN) await copyObject(devS3, prodS3, k, objStats);
    }
  }

  for (const step of PLAN) {
    // 1. Read GLOBAL rows from dev
    let q = devSb.from(step.table).select('*');
    if (step.filter) q = step.filter(q);
    const { data: rows, error } = await q;
    if (error) { console.error(`  ✖ ${step.table}: read failed — ${error.message}`); process.exit(1); }

    // 2. Collect the R2 keys this step references — THE WALK, NOT A COLUMN LIST.
    //
    // This used to be `keyCols: ['image_url', …]`, named per table. Two things were wrong with it,
    // one of them live: cake_shapes declared no keyCols at all, so 10 shape thumbnails (the column
    // is `thumbnail_key`, not `thumbnail_url` — a copy-paste from cake_elements would have missed it
    // too) were never copied, and prod's New-cake picker would have launched as broken <img> tiles.
    // The latent one: nothing declared reached inside `placement_config` or a template's `design`,
    // so a photo frame's mask or a sticker's texture could promote with the row and without the
    // object. Zero instances today — checked — but nothing prevented the first one.
    //
    // Walking every row with the export tool's own `assetKeysIn` ends both. A key is recognised by
    // its folder, so a new column, a new nested field, or a new folder needs no edit here.
    const keys = [];
    for (const r of rows) for (const k of assetKeysIn(r, new Set(), DEV.publicUrl)) { keys.push(k); allKeys.add(k); }

    console.log(`\n• ${step.table}: ${rows.length} rows${keys.length ? `, ${keys.length} object refs` : ''}`);
    totalRows += rows.length;

    // 3. Copy the referenced R2 objects (dev → prod)
    if (keys.length && !DRY_RUN) {
      for (const batch of chunk(keys, 12)) await Promise.all(batch.map(k => copyObject(devS3, prodS3, k, objStats)));
    }

    // 4. Prepare + upsert rows into prod (preserve id; strip tenant/auth FKs; topo-sort self-refs)
    // Absolute URLs → the DESTINATION host. cake_templates.design stores fully-qualified URLs (49 of
    // them across the 15 global templates, and no bare keys at all) because nothing expands a design
    // on the way out — toPublicUrl is applied to thumbnail_url only. Inserted verbatim, every global
    // template in prod would fetch its textures and GLBs from the DEV bucket. The key is untouched;
    // only the host in front of it moves, because the object was copied to the same key.
    urlsRewritten += rows.reduce((n, r) => n + countAssetUrls(r, DEV.publicUrl), 0);
    let toInsert = rows.map(r => {
      const row = rewriteAssetHost({ ...r }, DEV.publicUrl, PROD.publicUrl);
      if (step.strip) for (const c of step.strip) row[c] = null;
      if (SKIP_EMBEDDINGS && 'description_embedding' in row) row.description_embedding = null;
      return row;
    });
    // ── Drop rows whose PARENT was filtered out ─────────────────────────────────────────────────
    // A join table inherits nothing from the table it points at. cake_templates is filtered to
    // `baker_id IS NULL`, but template_tags had no filter at all — so it tried to carry tag links
    // for BAKER templates that were deliberately never migrated, and prod rejected the lot:
    //
    //   violates foreign key constraint "template_tags_template_id_fkey"
    //
    // The FK caught it, which is the good outcome. The bad one was available: cake_template_attrs
    // has the same defect and 1 of its 4 rows IS global, so a run that hit it first would have
    // written the valid row and failed on an invalid one, leaving the table half-migrated.
    //
    // Declaring the parent per FK column makes the join table's filter FOLLOW its parent's, so a
    // change to `filter` above cannot leave a child table behind again.
    if (step.parents) {
      const before = toInsert.length;
      toInsert = toInsert.filter(r => Object.entries(step.parents).every(([col, parentTable]) => {
        const ids = migrated.get(parentTable);
        return r[col] == null || !ids || ids.has(r[col]);
      }));
      const dropped = before - toInsert.length;
      if (dropped) console.log(`  ⊘ ${dropped} row(s) dropped — parent not in the migrated set`);
    }

    // Same hazard one level in: a global row whose self-reference points at a row that was filtered
    // out. Nulling is the truthful answer — in prod that parent genuinely does not exist — and it
    // matches what `strip` already does for FKs into tables we never migrate.
    if (step.selfRef) {
      const own = new Set(toInsert.map(r => r.id));
      let orphaned = 0;
      for (const r of toInsert) {
        if (r[step.selfRef] != null && !own.has(r[step.selfRef])) { r[step.selfRef] = null; orphaned++; }
      }
      if (orphaned) console.log(`  ⊘ ${orphaned} ${step.selfRef} reference(s) nulled — parent not in the migrated set`);
      toInsert = topoSort(toInsert, 'id', step.selfRef);
    }

    // Record what this step actually carries, for the children that point at it. Taken from
    // toInsert (post-filter), never from the unfiltered dev read.
    if (toInsert.length && toInsert[0]?.id !== undefined) {
      migrated.set(step.table, new Set(toInsert.map(r => r.id)));
    }

    insertedRows += toInsert.length;

    if (!DRY_RUN) {
      for (const batch of chunk(toInsert, 500)) {
        const { error: upErr } = await prodSb.from(step.table).upsert(batch, { onConflict: step.conflict ?? 'id' });
        if (upErr) { console.error(`  ✖ ${step.table}: upsert failed — ${upErr.message}`); process.exit(1); }
      }
      console.log(`  ✔ upserted ${toInsert.length}`);
    }
  }

  console.log(`\n── summary ──`);
  console.log(`rows read:       ${totalRows}${insertedRows !== totalRows ? `  (${totalRows - insertedRows} dropped — parent not migrated)` : ''}`);
  console.log(`rows to write:   ${insertedRows}`);
  console.log(`R2 objects refd: ${allKeys.size}`);
  console.log(`asset URLs:      ${urlsRewritten} rewritten ${DEV.publicUrl || '(dev base unknown)'} → ${PROD.publicUrl || '(PROD_R2_PUBLIC_URL not set — rows would keep dev URLs)'}`);
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
    console.log(`\n(DRY RUN) Would copy ${allKeys.size} objects and upsert ${insertedRows} rows into prod. No changes made.`);
  }
}

// Only when invoked directly. verify-prod-library.mjs imports PLAN from here, and an import that
// starts a migration would be a remarkable way to find that out.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('FATAL:', e?.message || e); process.exit(1); });
}
