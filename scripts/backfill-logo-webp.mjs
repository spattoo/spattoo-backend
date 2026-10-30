#!/usr/bin/env node
/**
 * Re-encode every baker's transparent logo (bakers.logo_transparent_key).
 *
 * WHY: the cut-out used to be written as LOSSLESS WebP unconditionally. That is correct for a flat
 * wordmark and badly wrong for a rendered emblem — lossless cannot compress continuous tone. One
 * real logo on dev ("Velvet & Vanilla Bake House") was 237,718 bytes for a mark that draws 52px
 * tall, which measured as 23% of a cold template load on a throttled phone. services/logoImage.js
 * now encodes both ways and keeps the smaller; this brings existing logos onto that encoder.
 *
 * ⚠️ IT DOES NOT RE-RUN THE BACKGROUND REMOVAL. It reads the EXISTING -nobg.webp out of R2 and
 * re-encodes that. Going back through removeLogoBg would spend a remove.bg credit per baker to
 * reproduce a cutout we already have, and the cutout was never the thing that was wrong.
 *
 * Non-destructive in the sense that matters: the ORIGINAL upload (bakers.logo_url) is never
 * touched, so a bad result is recoverable by re-running the removal job for that baker. The -nobg
 * object IS overwritten in place, which is what keeps the URL — and every cached reference to it —
 * valid. Pass BACKUP_DIR to keep a local copy of each object before it is replaced.
 *
 * Safe to re-run: a logo already on the new encoder comes back the same size and is skipped.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-logo-webp.mjs            # dry run, writes nothing
 *   node --env-file=.env scripts/backfill-logo-webp.mjs --apply    # actually write
 *
 * Options (env vars):
 *   BACKUP_DIR=path  — save each original object locally before overwriting
 *   MIN_SAVING=0.10  — skip a logo unless the new encode is at least this much smaller (default 10%)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { supabase } from '../src/services/supabase.js';
import { getObjectBuffer, putObject } from '../src/services/r2.js';
import { encodeLogoWebp } from '../src/services/logoImage.js';

const APPLY      = process.argv.includes('--apply');
const BACKUP_DIR = process.env.BACKUP_DIR || null;
const MIN_SAVING = Number(process.env.MIN_SAVING ?? 0.10);

const kb = n => (n / 1024).toFixed(1).padStart(7) + ' KB';

async function main() {
  const { data: bakers, error } = await supabase
    .from('bakers')
    .select('id, name, logo_transparent_key')
    .not('logo_transparent_key', 'is', null);
  if (error) throw new Error(error.message);

  if (!bakers.length) { console.log('No bakers have a transparent logo. Nothing to do.'); return; }
  if (BACKUP_DIR) await mkdir(BACKUP_DIR, { recursive: true });

  console.log(`${bakers.length} logo${bakers.length === 1 ? '' : 's'} to check` +
              `${APPLY ? '' : '   (DRY RUN — pass --apply to write)'}\n`);

  let before = 0, after = 0, written = 0, skipped = 0, failed = 0;

  for (const b of bakers) {
    const label = `${(b.name || b.id).slice(0, 28).padEnd(28)}`;
    try {
      const current = await getObjectBuffer(b.logo_transparent_key);
      const next    = await encodeLogoWebp(current);
      const saving  = 1 - next.length / current.length;

      before += current.length;
      after  += saving >= MIN_SAVING ? next.length : current.length;

      if (saving < MIN_SAVING) {
        skipped++;
        console.log(`  skip   ${label} ${kb(current.length)}  (already ${(saving * 100).toFixed(0)}% from best)`);
        continue;
      }

      console.log(`  ${APPLY ? 'write ' : 'would '} ${label} ${kb(current.length)} -> ${kb(next.length)}  (-${(saving * 100).toFixed(0)}%)`);
      if (!APPLY) continue;

      if (BACKUP_DIR) {
        await writeFile(join(BACKUP_DIR, b.logo_transparent_key.replace(/\//g, '_')), current);
      }
      // Same key, so every stored URL and every cached reference stays valid. putObject sets the
      // immutable cache-control header, which is why this object already had one when 17 of its 18
      // neighbours on the cold-load trace did not.
      await putObject(b.logo_transparent_key, next, 'image/webp');
      written++;
    } catch (err) {
      failed++;
      console.error(`  FAIL   ${label} ${b.logo_transparent_key}: ${err.message}`);
    }
  }

  console.log(`\n  ${kb(before)} -> ${kb(after)}   (-${(100 * (1 - after / before)).toFixed(0)}%)`);
  console.log(`  ${written} written, ${skipped} already optimal, ${failed} failed`);
  if (!APPLY) console.log('\n  Nothing was written. Re-run with --apply.');
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
