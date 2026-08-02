import sharp from 'sharp';
import { getObjectBuffer, putObject } from '../../services/r2.js';
import { removeBackground } from '../../services/removebg.js';
// NOT metered, deliberately (see migration 036, which meters the baker-facing cut-out route). This
// fires ONCE, on the logo a baker uploads while setting up their bakery — before they have used the
// product, and quite possibly before they understand what a credit is. Charging for onboarding is
// the wrong first impression for a few rupees of vendor cost, and the volume is bounded by
// definition: one logo per baker.
import { supabase } from '../../services/supabase.js';
import { jobQueue } from '../queue.js';

// Enqueue a background-removal job for a baker's logo. No-op unless both ids are present. Single
// chokepoint so every place that sets a logo (create + profile update) uses the same job name.
export function enqueueLogoBgRemoval(bakerId, logoKey) {
  if (!bakerId || !logoKey) return;
  return jobQueue.add('remove_logo_bg', { bakerId, logoKey });
}

// Fetch the uploaded logo, strip its background via remove.bg, store the transparent PNG in R2, and
// point bakers.logo_transparent_key at it. On ANY failure we leave the column null so the storefront
// simply falls back to the original logo — a bad cutout or a remove.bg outage never breaks the logo.
export async function removeLogoBg({ bakerId, logoKey }) {
  if (!bakerId || !logoKey) return;
  try {
    const input = await getObjectBuffer(logoKey);
    const cutout = await removeBackground(input);   // remove.bg → transparent PNG
    // Re-encode as lossless WebP (smaller than PNG, keeps alpha + crisp logo edges) and bound the
    // size — a logo never needs to be huge (displays ~30px tall, so 640px covers retina).
    const webp = await sharp(cutout)
      .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
      .webp({ lossless: true })
      .toBuffer();
    const transparentKey = `${logoKey.replace(/\.[^./]+$/, '')}-nobg.webp`;
    await putObject(transparentKey, webp, 'image/webp');
    const { error } = await supabase
      .from('bakers')
      .update({ logo_transparent_key: transparentKey })
      .eq('id', bakerId);
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(`remove_logo_bg failed for baker ${bakerId}:`, err.message);
  }
}
