import { getObjectBuffer, putObject } from '../../services/r2.js';
import { cutOutSubject } from '../../services/backgroundRemoval.js';
// ONE encoder, shared with scripts/backfill-logo-webp.mjs — see the note in that file for why a
// lossless-only encode made one baker's logo 23% of a cold template load on a phone.
import { encodeLogoWebp } from '../../services/logoImage.js';
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

// Fetch the uploaded logo, strip its background, store the transparent PNG in R2, and point
// bakers.logo_transparent_key at it. On ANY failure we leave the column null so the storefront
// simply falls back to the original logo — a bad cutout or a vendor outage never breaks the logo.
//
// ⚠️ THROUGH cutOutSubject() LIKE EVERYTHING ELSE. This was the THIRD door straight to the vendor
// and the quietest: it runs in a background job and swallows its own errors, so when remove.bg
// stopped answering, every new baker would simply have had no transparent logo and nothing on any
// screen would have said why. Found by the gate below this file, not by reading — the two doors I
// went looking for were both in routes.
export async function removeLogoBg({ bakerId, logoKey }) {
  if (!bakerId || !logoKey) return;
  try {
    const input = await getObjectBuffer(logoKey);
    const { png: cutout } = await cutOutSubject(input);   // whichever provider is configured
    const webp = await encodeLogoWebp(cutout);
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
