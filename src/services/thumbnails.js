import sharp from 'sharp';
import { getObjectBuffer, putObject } from './r2.js';

// Picker thumbnail spec (ASSET_OPTIMIZATION_PLAN.md §3): a small WebP served
// direct. The dimension cap is what bounds decoded GPU/CPU memory (format only
// affects download size), so ≤256px is the real lever.
const THUMB_MAX_DIM = 256;
const THUMB_QUALITY = 80;

// ── The copy the CAKE is textured from (migration 132) ──────────────────────────────────────────
// The same lever, one step up. A 1024² sticker decodes to ~5.3 MB of RGBA on the GPU; at 512² it is
// ~1.3 MB, because the memory follows the AREA. A busy cake is twenty of these on a 3 GB phone
// (§3, Floor B), and a decoration occupies a few hundred screen pixels — so the quarter is free.
//
// ⚠️ NOT THE PRINT SIZE. An edible sheet is made from the MASTER at 300 dpi (1024 px ≈ 87 mm), and
// nothing in this file is allowed anywhere near that path. See chefsdesk/a4/cutoutSource.js.
const RENDER_MAX_DIM = 512;

// Generates a smaller WebP copy of a source image key
// (elements/thumbnails/<uid>.{webp,png,jpg}, elements/files/2D/<uid>.{webp,png,jpg})
// and stores it under a size-suffixed key (<uid>-<maxDim>.webp). Returns the new
// webp key, or null if there's nothing to convert. The size suffix keeps the derived
// key distinct from the source — the master is now itself a WebP, so a plain `.webp`
// swap would collide with and overwrite it. The master is retained as the fallback
// (thumb_key ?? thumbnail_url, render_key ?? image_url) and as the re-processing
// source. Shared by element ingest (create/update) — the same transform the
// back-catalog sweeps use.
//
// ⚠️ ONE TRANSFORM, TWO JOBS, AND THAT IS DELIBERATE. The picker thumbnail (≤256) and the cake's
// render copy (≤512) differ only in `maxDim`: both are "the same picture, smaller, as WebP, with
// its alpha intact". A second function would be a second place for the format, the quality and the
// suffix rule to drift. Which size a caller wants is the caller's decision; how a smaller copy is
// made is this file's.
export async function generateWebpVariant(sourceKey, { maxDim = THUMB_MAX_DIM, quality = THUMB_QUALITY } = {}) {
  if (!sourceKey || !/\.(webp|png|jpe?g)$/i.test(sourceKey)) return null;
  const webpKey = sourceKey.replace(/\.[^./]+$/i, `-${maxDim}.webp`);
  if (webpKey === sourceKey) return null;   // never overwrite the source
  const src = await getObjectBuffer(sourceKey);
  const webp = await sharp(src)
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
  await putObject(webpKey, webp, 'image/webp');
  return webpKey;
}

// The ≤512 copy of a 2D sticker's MASTER artwork, for `cake_elements.render_key`. A one-line
// wrapper so the size lives beside the reasoning above rather than at each call site — and so a
// later device floor changes it in ONE place.
//
// Returns null for anything that has no such copy to make, which is most of the catalogue: a `.glb`
// (3D), an `.svg` (resolution-free), and an element with no artwork at all (a calendar is a recipe).
// Null is the signal to draw the master, so each of those is handled by returning it.
export function generateRenderVariant(imageKey) {
  return generateWebpVariant(imageKey, { maxDim: RENDER_MAX_DIM });
}
