import { optimizeImageToWebp } from '../../services/imageOptimize.js';
import { supabase } from '../../services/supabase.js';
import { jobQueue } from '../queue.js';

// Enqueue a WebP-optimisation job for a just-uploaded gallery photo. No-op without both ids.
export function enqueueOptimizePhoto(photoId, key) {
  if (!photoId || !key) return;
  return jobQueue.add('optimize_photo', { photoId, key });
}

// Re-encode an uploaded gallery photo to a web-optimised WebP and point the row at it. On ANY
// failure we leave the original in place — a conversion error never breaks the photo.
export async function optimizePhoto({ photoId, key }) {
  if (!photoId || !key) return;
  try {
    const newKey = await optimizeImageToWebp(key);
    if (newKey === key) return;   // already WebP / nothing changed
    const { error } = await supabase
      .from('baker_storefront_photos')
      .update({ storage_key: newKey })
      .eq('id', photoId);
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(`optimize_photo failed for photo ${photoId}:`, err.message);
  }
}
