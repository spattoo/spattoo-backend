#!/usr/bin/env node
/**
 * Backfill cake_elements.thumb_key — optimised WebP picker thumbnails.
 *
 * The existing "thumbnails" in R2 (elements/thumbnails/<uid>.png) are full-res
 * PNGs (45 KB – 1 MB). The Decorations picker loads them all at once → heavy on
 * mobile, and each decodes to several MB of RAM. This script generates a small
 * WebP variant per element and records its key in the new thumb_key column.
 *
 * ADDITIVE / non-destructive (safe to re-run, easy to roll back):
 *   - reads  elements/thumbnails/<uid>.png    (kept as the raw source)
 *   - writes elements/thumbnails/<uid>.webp   (new object, <=256px, q80)
 *   - sets   cake_elements.thumb_key = elements/thumbnails/<uid>.webp
 * The original .png objects and the thumbnail_url column are never modified.
 * Roll back by clearing thumb_key (and optionally deleting the .webp objects).
 *
 * NOTE: this makes thumbnails LIGHT, but they won't DISPLAY until core (the
 * designer picker) reads thumb_key and drops the broken /cdn-cgi/image transform.
 *
 * Run supabase/element_thumb_key.sql FIRST so the column exists.
 * Requires:  npm i sharp
 *
 * Usage:
 *   SUPABASE_URL=...  SUPABASE_SERVICE_KEY=... \
 *   R2_ENDPOINT=...  R2_ACCESS_KEY_ID=...  R2_SECRET_ACCESS_KEY=...  R2_BUCKET=... \
 *   node scripts/backfillThumbnails.mjs
 *
 * Options (env vars):
 *   DRY_RUN=1        — list what would be processed, write nothing
 *   FORCE=1          — re-process even elements that already have thumb_key
 *   BACKUP_DIR=path  — also save each original .png locally (optional; originals
 *                      are retained in R2 regardless, so this is belt-and-braces)
 *   MAX_DIM=256      — thumbnail max edge in px (default 256)
 *   QUALITY=80       — WebP quality 1–100 (default 80)
 */

import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DRY_RUN    = process.env.DRY_RUN === '1';
const FORCE      = process.env.FORCE === '1';
const BACKUP_DIR = process.env.BACKUP_DIR || null;
const MAX_DIM    = Number(process.env.MAX_DIM) || 256;
const QUALITY    = Number(process.env.QUALITY) || 80;

// Read an env var, stripping whitespace and any accidental surrounding quotes —
// straight ('") or smart ('' "") — which pasted creds often pick up and which
// break URL parsing / AWS header (ByteString) encoding.
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

// thumbnail_url stores a key like "elements/thumbnails/<uid>.png".
// The WebP variant is the SAME key (same uid) with a .webp extension.
const webpKeyFor = (pngKey) => pngKey.replace(/\.png$/i, '.webp');

async function getBuffer(key) {
  const out = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return Buffer.from(await out.Body.transformToByteArray());
}

async function run() {
  console.log(`Backfilling thumb_key  [dry_run=${DRY_RUN} force=${FORCE} max=${MAX_DIM} q=${QUALITY}]\n`);

  let query = supabase
    .from('cake_elements')
    .select('id, name, thumbnail_url, thumb_key')
    .not('thumbnail_url', 'is', null);
  if (!FORCE) query = query.is('thumb_key', null);

  const { data: elements, error } = await query;
  if (error) { console.error(error.message); process.exit(1); }

  // Only .png originals; anything else (already .webp, unexpected) is left alone.
  const rows = elements.filter((el) => /\.png$/i.test(el.thumbnail_url || ''));
  const skippedNonPng = elements.length - rows.length;
  console.log(`${rows.length} element(s) to process${skippedNonPng ? `  (${skippedNonPng} non-png skipped)` : ''}\n`);

  if (BACKUP_DIR && !DRY_RUN) await mkdir(BACKUP_DIR, { recursive: true });

  let done = 0, errored = 0, savedBytes = 0;
  for (const el of rows) {
    const srcKey = el.thumbnail_url;
    const dstKey = webpKeyFor(srcKey);
    process.stdout.write(`  ${el.name}  →  ${dstKey} … `);

    if (DRY_RUN) { console.log('[DRY]'); done++; continue; }

    try {
      const src = await getBuffer(srcKey);

      if (BACKUP_DIR) {
        await writeFile(join(BACKUP_DIR, srcKey.split('/').pop()), src);
      }

      const webp = await sharp(src)
        .resize(MAX_DIM, MAX_DIM, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: QUALITY })
        .toBuffer();

      await r2.send(new PutObjectCommand({
        Bucket:       BUCKET,
        Key:          dstKey,
        Body:         webp,
        ContentType:  'image/webp',
        CacheControl: 'public, max-age=31536000, immutable',
      }));

      const { error: upErr } = await supabase
        .from('cake_elements')
        .update({ thumb_key: dstKey })
        .eq('id', el.id);
      if (upErr) throw upErr;

      savedBytes += Math.max(0, src.length - webp.length);
      console.log(`${kb(src.length)} → ${kb(webp.length)}`);
      done++;
    } catch (err) {
      console.log(`error: ${err.message}`);
      errored++;
    }
  }

  console.log(
    `\nDone. ${DRY_RUN ? '(dry run) ' : ''}${done} processed, ${errored} errored` +
    `${DRY_RUN ? '' : `, ~${(savedBytes / (1024 * 1024)).toFixed(1)} MB saved`}.`
  );
}

run().catch((err) => { console.error(err); process.exit(1); });
