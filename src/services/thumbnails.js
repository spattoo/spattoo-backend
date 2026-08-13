import sharp from 'sharp';
import { getObjectBuffer, putObject } from './r2.js';

// Picker thumbnail spec (ASSET_OPTIMIZATION_PLAN.md §3): a small WebP served
// direct. The dimension cap is what bounds decoded GPU/CPU memory (format only
// affects download size), so ≤256px is the real lever.
const THUMB_MAX_DIM = 256;
const THUMB_QUALITY = 80;

// Generates the optimised WebP picker thumbnail from a source thumbnail key
// (elements/thumbnails/<uid>.{webp,png,jpg}) and stores it under a size-suffixed
// key (<uid>-<maxDim>.webp). Returns the new webp key, or null if there's nothing
// to convert. The size suffix keeps the picker key distinct from the source — the
// master thumbnail (thumbnail_url) is now itself a WebP, so a plain `.webp` swap
// would collide with and overwrite the source. The master is retained as the
// fallback (thumb_key ?? thumbnail_url) and re-processing source. Shared by element
// ingest (create/update) — same transform the back-catalog sweep uses.
export async function generateWebpThumbnail(thumbnailKey, { maxDim = THUMB_MAX_DIM, quality = THUMB_QUALITY } = {}) {
  if (!thumbnailKey || !/\.(webp|png|jpe?g)$/i.test(thumbnailKey)) return null;
  const webpKey = thumbnailKey.replace(/\.[^./]+$/i, `-${maxDim}.webp`);
  if (webpKey === thumbnailKey) return null;   // never overwrite the source
  const src = await getObjectBuffer(thumbnailKey);
  const webp = await sharp(src)
    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
  await putObject(webpKey, webp, 'image/webp');
  return webpKey;
}
