import { generateDecorationStages } from './openai.js';
import { cropRegion, composeReference } from './imageCrop.js';
import { getObjectBuffer, putObject } from './r2.js';

// ── The build-sequence image, for either kind of decoration ──────────────────────────
// One image showing a decoration at each stage of being made (spattoo-docs
// plans/visual-decoration-guide.md, Phase 2). Both callers want the identical thing and differ in
// only two details, so the pipeline lives here rather than being written twice:
//
//   photo decoration   source is the ORDER'S REFERENCE PHOTO and must be cropped to the decoration
//                      first, because the frame is a whole cake. Key is order-scoped: the
//                      decoration exists on that order alone and its picture can never be reused.
//
//   library element    source is ALREADY the isolated decoration, so there is nothing to crop. Key
//                      is element-scoped and deliberately shared — this is the same object for
//                      everyone who places the element, and regenerating per baker would pay
//                      repeatedly for one answer.
//
// Throws on any failure. Every caller treats that as "no picture", never as "no guide": the words
// are the product and the picture is the improvement, so an image failure must not throw away
// steps the baker is about to be charged for.
export async function renderStageImage({ sourceKey, bbox = null, objectKey, title, steps = [], dimension = null }) {
  const source = await getObjectBuffer(sourceKey);

  // cropRegion pads the box outward before cutting — vision models are imprecise at boundaries, and
  // a crop that clips the decoration is unrecoverable (the model invents the missing half) while
  // surrounding cake is harmless, because the prompt tells it to drop the background.
  const cropped = bbox ? await cropRegion(source, bbox) : source;
  // Only the reference buffer is wanted. composeReference also returns an output size matched to
  // the CROP's shape, which is right for rendering one subject and wrong for a tutorial sheet —
  // that is portrait regardless of what the decoration looks like.
  const { buffer: reference } = await composeReference(cropped);

  const { buffer, usage, model } = await generateDecorationStages(reference, {
    title,
    // The sheet illustrates THESE steps. Without them the model invents its own sequence — always
    // empty, then partial, then complete, which is an assembly story rather than this guide.
    steps,
    dimension,
  });

  await putObject(objectKey, buffer, 'image/webp');
  return { key: objectKey, usage, model };
}

// Where a photo decoration's picture lives. Order-scoped, so it is unreachable from another
// bakery's sheet and falls inside the account-erasure sweep with the order's own photos.
export function orderStagesKey(orderId, decorationKey) {
  return `orders/guides/${orderId}/${encodeURIComponent(decorationKey)}/stages-${stamp()}.webp`;
}

// Where a library element's picture lives. Shared by every baker who uses that element.
export function elementStagesKey(elementId) {
  return `elements/guides/${elementId}/stages-${stamp()}.webp`;
}

// ── Why every generation gets a NEW key ──────────────────────────────────────────────
// putObject stores everything as `public, max-age=31536000, immutable` — a year, and browsers and
// CDNs are entitled to take that literally. That is correct for content-addressed assets and WRONG
// for a fixed key we overwrite: a rebuilt guide wrote a new picture to the same URL, and nothing
// ever fetched it again. The words changed on every rebuild (they come back in the API's JSON,
// which is not cached) and the picture never did — which looked exactly like regeneration being
// broken, and was really a cache doing its job.
//
// So the key carries a stamp and the caching stays honest: a URL that never changes never lies.
// The previous object is deleted by the caller once the new one is stored, so the bucket does not
// accumulate a copy per rebuild.
function stamp() {
  return Date.now().toString(36);
}
