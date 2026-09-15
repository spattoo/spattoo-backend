import sharp from 'sharp';
import { config } from '../config.js';
import { getObjectBuffer, putObject, objectExists } from './r2.js';
import { toPublicUrl } from '../lib/publicUrl.js';

// ── A picture WhatsApp will accept in a template header ──────────────────────────────────────────
//
// ⚠️ WHATSAPP TAKES ONLY JPEG OR PNG in a template's image header (up to 5 MB). Our cake pictures are
// WebP — spattoo-core's captureThumbnailBlob encodes every order thumbnail as image/webp. The first
// new-quote WhatsApp showed exactly that: AiSensy rendered the picture (a browser reads WebP) and
// marked the message sent, and WhatsApp refused to deliver it. The text was never the problem.
//
// So a header image that is not already JPEG or PNG is converted — once — and the copy is kept in R2
// beside a key derived from the original, so the second message about the same order costs a HEAD,
// not a download and a re-encode. The original is never touched: the app, the emails and the admin
// screens keep the WebP.
//
// The copies live under a folder deliberately NOT listed in lib/folders.js. That map is the list of
// folders a browser may sign uploads into; a copy only this server writes does not belong on it.
const ACCEPTED = /\.(jpe?g|png)(?:[?#]|$)/i;
const MEDIA_FOLDER = 'notifications/whatsapp-media';
const MAX_EDGE = 1600;   // comfortably under WhatsApp's 5 MB at quality 85, and sharp on a phone

/* The R2 key behind one of our public URLs, or the value itself when it is already a key. null for a
   URL that is not ours — there is nothing we can fetch it from. */
export function r2KeyOf(urlOrKey) {
  if (!urlOrKey) return null;
  const value = String(urlOrKey);
  if (!/^https?:\/\//i.test(value)) return value.split(/[?#]/)[0];
  const base = `${String(config.r2.publicUrl ?? '').replace(/\/+$/, '')}/`;
  return base !== '/' && value.startsWith(base) ? value.slice(base.length).split(/[?#]/)[0] : null;
}

/**
 * A public URL for this picture that WhatsApp will deliver.
 *
 * JPEG and PNG are returned as they are. Anything else of ours is converted to JPEG — transparency
 * flattened onto white, the way a cake thumbnail is already framed — and cached in R2. A URL that is
 * not ours is returned unchanged: it cannot be converted, and the send reports whatever WhatsApp says.
 *
 * @throws when the original cannot be read or converted — the caller records a failed send, which is
 *         retried.
 */
export async function whatsappImageUrl(urlOrKey) {
  if (!urlOrKey) return null;
  const url = toPublicUrl(urlOrKey);
  if (ACCEPTED.test(url)) return url;

  const key = r2KeyOf(urlOrKey);
  if (!key) return url;

  const jpgKey = `${MEDIA_FOLDER}/${key.replace(/\.[^./]+$/, '')}.jpg`;
  if (!(await objectExists(jpgKey))) {
    const original = await getObjectBuffer(key);
    const jpg = await sharp(original)
      .flatten({ background: '#ffffff' })
      .resize(MAX_EDGE, MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();
    await putObject(jpgKey, jpg, 'image/jpeg');
  }
  return toPublicUrl(jpgKey);
}
