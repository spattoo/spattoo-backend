import sharp from 'sharp';

// Crop one decoration out of a cake photo, given the NORMALISED bbox (0..1) that GPT-4o vision
// returned for it. The crop becomes the reference image for regeneration, so this is the step that
// decides how faithful the result can possibly be.
//
// Vision models are only roughly accurate at bounding boxes, so we deliberately do NOT trust the box
// as given: `pad` expands it (default 12% of the box's own size on each side) before cropping. A
// crop that clips half the rosette is unrecoverable — the model will invent the missing half — while
// a crop carrying some surrounding frosting is harmless, because the regeneration prompt explicitly
// tells the model to drop the cake behind the subject. Asymmetric risk, so we pad.
//
// The box is clamped to the image, and a degenerate/absent box falls back to the whole image (better
// to condition on the full photo than to throw away the candidate).
export async function cropRegion(imageBuffer, bbox, { pad = 0.12, minPx = 64 } = {}) {
  const img  = sharp(imageBuffer).rotate();          // honour EXIF orientation before measuring
  const base = await img.toBuffer();                 // rotation baked in, so metadata matches pixels
  const { width, height } = await sharp(base).metadata();

  const b = normalise(bbox);
  if (!b) return base;                               // no usable box → condition on the whole photo

  // Pad by a fraction of the box's own size, then clamp to the image bounds.
  const padX = b.w * pad;
  const padY = b.h * pad;
  const x0 = clamp01(b.x - padX);
  const y0 = clamp01(b.y - padY);
  const x1 = clamp01(b.x + b.w + padX);
  const y1 = clamp01(b.y + b.h + padY);

  const left = Math.round(x0 * width);
  const top  = Math.round(y0 * height);
  const w    = Math.max(minPx, Math.round((x1 - x0) * width));
  const h    = Math.max(minPx, Math.round((y1 - y0) * height));

  return sharp(base)
    .extract({
      left,
      top,
      // Re-clamp after the minPx floor — a tiny box near an edge could otherwise overrun.
      width:  Math.min(w, width  - left),
      height: Math.min(h, height - top),
    })
    .png()
    .toBuffer();
}

// Accept a bbox only if it is a real, non-degenerate, in-range box. Anything else → null (caller
// falls back to the full image) rather than a crash on a bad model response.
function normalise(bbox) {
  if (!bbox) return null;
  const x = Number(bbox.x), y = Number(bbox.y), w = Number(bbox.w), h = Number(bbox.h);
  if (![x, y, w, h].every(Number.isFinite)) return null;
  if (w <= 0.01 || h <= 0.01) return null;           // degenerate — a sliver is not a decoration
  if (x < 0 || y < 0 || x >= 1 || y >= 1) return null;
  return { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
