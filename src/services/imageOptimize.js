import sharp from 'sharp';
import { getObjectBuffer, putObject, deleteObject } from './r2.js';

// Download an R2 image, re-encode to a web-optimised WebP (EXIF-oriented, resized, quality-capped,
// metadata stripped), upload it under a .webp key, delete the original, and return the new key.
// Shared by the gallery-photo job and the storefront content-image (Highlight) upload endpoint.
export async function optimizeImageToWebp(key, { maxDim = 1600, quality = 82 } = {}) {
  if (!key || /\.webp$/i.test(key)) return key;   // nothing to do / already WebP
  const input = await getObjectBuffer(key);
  const webp = await sharp(input)
    .rotate()                                                     // honour EXIF orientation (phone photos)
    .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
  const newKey = `${key.replace(/\.[^./]+$/, '')}.webp`;
  await putObject(newKey, webp, 'image/webp');
  if (newKey !== key) await deleteObject(key);                   // drop the original (now replaced)
  return newKey;
}
