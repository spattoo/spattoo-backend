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

// The output sizes the image model actually supports. There is no arbitrary-aspect option, so the
// crop has to be mapped onto the closest one.
const SIZES = {
  portrait:  { w: 1024, h: 1536 },
  square:    { w: 1024, h: 1024 },
  landscape: { w: 1536, h: 1024 },
};

// Turn a raw crop into the reference image we actually send, and tell the caller what output size to
// ask for. This exists because of a real bug: a hanging monkey cropped at aspect 0.50 (tall) was sent
// with a hardcoded 1024x1024 SQUARE output request, and the model — having to fit a 2:1 subject into a
// 1:1 frame — cut its legs off. Nothing was wrong with the bounding box or the crop; the frame was
// wrong. Any tall or wide decoration (a drip, a lettering topper, a giraffe) would have hit it.
//
// Two things fix it together:
//  1. ASPECT — pick the supported output size closest to the crop's own aspect, so a tall subject is
//     rendered into a tall frame. Squeezing 2:1 into 1:1 is what forced the crop.
//  2. MARGIN — letterbox the crop inside that frame with breathing room, centred on white, rather than
//     letting the subject run to the edges. A subject that touches the frame edge invites the model to
//     continue the crop; one floating with margin reads as a complete, isolated object. This is also
//     what a product shot looks like, which is what we're asking for.
//
// It also UPSCALES: crops are small (that monkey was 119x238 in a 960x1280 photo), and the model works
// at 1024+. Feeding it a postage stamp wastes input_fidelity. Upscaling can't invent detail that was
// never in the photo — a decoration only 119px wide is inherently limited — but it does let the model
// use the detail that IS there.
export async function composeReference(cropBuffer, { margin = 0.86 } = {}) {
  const meta = await sharp(cropBuffer).metadata();
  const aspect = (meta.width || 1) / (meta.height || 1);

  // Thresholds, not exact matches — a 0.9-aspect crop is "square enough", and forcing it into a
  // portrait frame would add pointless empty space.
  const size = aspect < 0.8 ? SIZES.portrait
             : aspect > 1.25 ? SIZES.landscape
             : SIZES.square;

  const inner = await sharp(cropBuffer)
    .resize({
      width:  Math.round(size.w * margin),
      height: Math.round(size.h * margin),
      fit: 'inside',                       // never crop, never distort — the whole subject survives
      withoutEnlargement: false,           // DO upscale a small crop; that's the point
      kernel: 'lanczos3',
    })
    .toBuffer();

  const buffer = await sharp({
    create: { width: size.w, height: size.h, channels: 3, background: '#ffffff' },
  })
    .composite([{ input: inner, gravity: 'centre' }])
    .png()
    .toBuffer();

  return { buffer, size: `${size.w}x${size.h}` };
}
