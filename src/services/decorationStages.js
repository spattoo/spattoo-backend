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
export async function renderStageImage({ sourceKey, bbox = null, objectKey, title, stepCount }) {
  const source = await getObjectBuffer(sourceKey);

  // cropRegion pads the box outward before cutting — vision models are imprecise at boundaries, and
  // a crop that clips the decoration is unrecoverable (the model invents the missing half) while
  // surrounding cake is harmless, because the prompt tells it to drop the background.
  const cropped = bbox ? await cropRegion(source, bbox) : source;
  const { buffer: reference, size } = await composeReference(cropped);

  const { buffer, usage, model } = await generateDecorationStages(reference, {
    title,
    // The stages worth drawing are the ones where the SHAPE changes, which is always fewer than the
    // number of written steps — one panel per step reads as a comic strip and costs detail in each.
    stages: stagesFor(stepCount),
    size,
  });

  await putObject(objectKey, buffer, 'image/webp');
  return { key: objectKey, usage, model };
}

export function stagesFor(stepCount) {
  return Math.min(9, Math.max(4, Math.round((Number(stepCount) || 0) * 0.75)));
}

// Where a photo decoration's picture lives. Order-scoped, so it is unreachable from another
// bakery's sheet and falls inside the account-erasure sweep with the order's own photos.
export function orderStagesKey(orderId, decorationKey) {
  return `orders/guides/${orderId}/${encodeURIComponent(decorationKey)}/stages.webp`;
}

// Where a library element's picture lives. Shared by every baker who uses that element.
export function elementStagesKey(elementId) {
  return `elements/guides/${elementId}/stages.webp`;
}
