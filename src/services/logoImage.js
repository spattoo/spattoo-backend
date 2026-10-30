import sharp from 'sharp';

// ── How a baker's logo is encoded ────────────────────────────────────────────────────────────────
// Its own module, not a function inside the background-removal job, because the BACKFILL needs the
// same encoder and importing the job drags in the queue and a Redis connection with it. One
// definition, so a re-encoded logo and a freshly uploaded one can never disagree.
//
// 640px is NOT the problem and never was. The biggest box any surface draws a logo in is 312x52 —
// the settings preview tile (SettingsPanel) and the storefront header (CustomerStorefront
// `logoImg`), both measured — so 640 covers a wide wordmark at 2x and a square mark many times
// over. Shrinking it would risk a soft wordmark on a 3x phone for no useful saving.
//
// The ENCODER was the problem. This used to be `webp({ lossless: true })` unconditionally, which is
// the right choice for a flat wordmark — crisp edges, and small anyway because there is little tone
// to carry — and the wrong one for a rendered emblem. A real baker logo on dev ("Velvet & Vanilla
// Bake House": a 3D-style cake illustration with gradients, soft shadows and a gold rim) is
// continuous tone, which lossless cannot compress: it shipped at 237,718 bytes for a mark that
// draws 52px tall. Measured on a throttled phone, that single file was 23% of a cold template load
// — second only to the decoration GLB, and ahead of the HDRI.
//
// So encode BOTH ways and keep the smaller, rather than guessing what a baker uploaded. A wordmark
// stays lossless; an emblem goes lossy and drops about 4x. This runs once per baker in a background
// job, so the second encode costs nothing anyone waits for.
const LOGO_MAX_EDGE = 640;

// Lossy only wins if it wins CLEARLY. A marginal saving is not worth any edge artefact at all, so a
// logo where the two encoders land close together keeps the lossless one.
const LOSSY_MARGIN = 0.75;

// `alphaQuality: 100` keeps the alpha channel lossless whichever path is taken: this image is a
// background CUTOUT, and a soft or ringing alpha edge is exactly the artefact a baker would notice
// against their storefront colour.
export async function encodeLogoWebp(input) {
  const fitted = sharp(input)
    .resize({ width: LOGO_MAX_EDGE, height: LOGO_MAX_EDGE, fit: 'inside', withoutEnlargement: true });
  const [lossless, lossy] = await Promise.all([
    fitted.clone().webp({ lossless: true }).toBuffer(),
    fitted.clone().webp({ quality: 90, alphaQuality: 100, effort: 6 }).toBuffer(),
  ]);
  return lossy.length <= lossless.length * LOSSY_MARGIN ? lossy : lossless;
}
