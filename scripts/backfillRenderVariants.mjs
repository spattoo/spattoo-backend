#!/usr/bin/env node
/**
 * Backfill cake_elements.render_key — the ≤512 WebP copy the 3D cake is TEXTURED from.
 *
 * ⚠️ WITHOUT THIS, THE FEATURE REACHES ALMOST NOTHING. The API generates a render copy at ingest
 * (routes/elements.js → ensureRenderKey), so every element created or re-saved from migration 132
 * onwards gets one. Every element that already exists does not, and the renderer's fallback is to
 * draw the master — correct, and four times the GPU memory. The whole catalogue is "already
 * exists", which is exactly the position thumb_key was in (see backfillThumbnails.mjs).
 *
 * Why it is worth running: a 1024² sticker decodes to ~5.3 MB of RGBA on the GPU; at 512² it is
 * ~1.3 MB, because the memory follows the AREA. A busy cake is twenty of these, and the device we
 * are sized for is a 3 GB phone (docs/ASSET_OPTIMIZATION_PLAN.md §3, Floor B).
 *
 * ADDITIVE / non-destructive (safe to re-run, easy to roll back):
 *   - reads  elements/files/2D/<uid>.{png,jpg,webp}       (the master — never modified)
 *   - writes elements/files/2D/<uid>-512.webp             (a new object)
 *   - sets   cake_elements.render_key = <that key>
 * `image_url` is never touched, which is the point: an edible print is made from the master at
 * 300 dpi (1024 px ≈ 87 mm), and nothing here is allowed near that path. Roll back by clearing
 * render_key — the renderer falls straight back to the master.
 *
 * ⚠️ 2D ONLY. A `.glb` is a 3D model (its own texture budget, see §3), an `.svg` has no resolution
 * to reduce, and an element with no image_url carries no artwork at all (a calendar is a recipe).
 * Each of those is skipped and reported, not errored.
 *
 * Run migrations/132_element_render_key.sql FIRST so the column exists.
 *
 * Usage:
 *   SUPABASE_URL=...  SUPABASE_SERVICE_KEY=... \
 *   R2_ENDPOINT=...  R2_ACCESS_KEY_ID=...  R2_SECRET_ACCESS_KEY=...  R2_BUCKET=... \
 *   node scripts/backfillRenderVariants.mjs
 *
 * Options (env vars):
 *   DRY_RUN=1        — list what would be processed, write nothing
 *   FORCE=1          — re-process even elements that already have render_key
 *   GLOBAL_ONLY=1    — catalogue only (baker_id is null); default does bakers' libraries too
 *   MAX_DIM=512      — render copy max edge in px (default 512; keep in step with
 *                      services/thumbnails.js RENDER_MAX_DIM)
 *   QUALITY=80       — WebP quality 1–100 (default 80)
 */

import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

const DRY_RUN     = process.env.DRY_RUN === '1';
const FORCE       = process.env.FORCE === '1';
const GLOBAL_ONLY = process.env.GLOBAL_ONLY === '1';
const MAX_DIM     = Number(process.env.MAX_DIM) || 512;
const QUALITY     = Number(process.env.QUALITY) || 80;

// Read an env var, stripping whitespace and any accidental surrounding quotes — straight ('") or
// smart ('' "") — which pasted creds often pick up and which break URL parsing / AWS header
// (ByteString) encoding. Same helper as backfillThumbnails.mjs, same reason.
const env = (name) => (process.env[name] || '').trim().replace(/^['"‘’“”]+|['"‘’“”]+$/g, '');

const REQUIRED = [
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
  'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET',
];
for (const v of REQUIRED) {
  if (!env(v)) { console.error(`Missing ${v}`); process.exit(1); }
}

const supabase = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_KEY'));
const BUCKET = env('R2_BUCKET');
const r2 = new S3Client({
  region: 'auto',
  endpoint: env('R2_ENDPOINT'),
  credentials: {
    accessKeyId:     env('R2_ACCESS_KEY_ID'),
    secretAccessKey: env('R2_SECRET_ACCESS_KEY'),
  },
});

const kb = (n) => (n == null ? '—' : `${(n / 1024).toFixed(1)} KB`);

// The SAME derivation services/thumbnails.js uses: swap the extension for `-<maxDim>.webp`. Kept as
// one line so the two can be compared by eye — a sweep that writes a key the API would not derive
// produces a column pointing at an object nothing else will ever regenerate.
const renderKeyFor = (key) => key.replace(/\.[^./]+$/i, `-${MAX_DIM}.webp`);

const RASTER = /\.(webp|png|jpe?g)$/i;

async function getBuffer(key) {
  const out = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await out.Body.transformToByteArray());
}

async function run() {
  console.log(`Backfilling render_key  [dry_run=${DRY_RUN} force=${FORCE} global_only=${GLOBAL_ONLY} max=${MAX_DIM} q=${QUALITY}]\n`);

  let query = supabase
    .from('cake_elements')
    .select('id, name, image_url, render_key, baker_id')
    .not('image_url', 'is', null);
  if (!FORCE)     query = query.is('render_key', null);
  if (GLOBAL_ONLY) query = query.is('baker_id', null);

  const { data: elements, error } = await query;
  if (error) { console.error(error.message); process.exit(1); }

  // 2D raster masters only — a .glb/.svg has nothing to resize here (see the header).
  const rows = elements.filter((el) => RASTER.test(el.image_url || ''));
  const skipped = elements.length - rows.length;
  console.log(`${rows.length} element(s) to process${skipped ? `  (${skipped} non-raster skipped — 3D models, SVG)` : ''}\n`);

  let done = 0, errored = 0, savedPixels = 0;
  for (const el of rows) {
    const srcKey = el.image_url;
    const dstKey = renderKeyFor(srcKey);
    process.stdout.write(`  ${el.name}  →  ${dstKey} … `);

    if (dstKey === srcKey) { console.log('skip (would overwrite the master)'); continue; }
    if (DRY_RUN) { console.log('[DRY]'); done++; continue; }

    try {
      const src = await getBuffer(srcKey);
      const img = sharp(src);
      const meta = await img.metadata();
      const webp = await img
        .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: QUALITY })
        .toBuffer();
      const out = await sharp(webp).metadata();

      await r2.send(new PutObjectCommand({
        Bucket:       BUCKET,
        Key:          dstKey,
        Body:         webp,
        ContentType:  'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      }));

      const { error: upErr } = await supabase
        .from('cake_elements')
        .update({ render_key: dstKey })
        .eq('id', el.id);
      if (upErr) throw upErr;

      // The number that matters is DECODED bytes, not file size — that is what sits on the GPU.
      // w·h·4·1.33 (RGBA + mips), which is the same arithmetic the plan's §3 table uses.
      const mem = (w, h) => (w || 0) * (h || 0) * 4 * 1.33;
      savedPixels += Math.max(0, mem(meta.width, meta.height) - mem(out.width, out.height));
      console.log(`${meta.width}×${meta.height} ${kb(src.length)}  →  ${out.width}×${out.height} ${kb(webp.length)}`);
      done++;
    } catch (err) {
      console.log(`error: ${err.message}`);
      errored++;
    }
  }

  console.log(
    `\nDone. ${DRY_RUN ? '(dry run) ' : ''}${done} processed, ${errored} errored` +
    `${DRY_RUN ? '' : `, ~${(savedPixels / (1024 * 1024)).toFixed(0)} MB of decoded texture saved across the catalogue`}.`
  );
}

run().catch((err) => { console.error(err); process.exit(1); });
