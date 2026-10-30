#!/usr/bin/env node
/**
 * check:logo-encode — a baker's logo is encoded by CONTENT, not by assumption.
 *
 * The bug this guards: `webp({ lossless: true })` unconditionally. That is right for a flat
 * wordmark and wrong for a rendered emblem, because lossless cannot compress continuous tone — one
 * real logo reached 237,718 bytes for a mark that draws 52px tall, and measured as 23% of a cold
 * template load on a throttled phone.
 *
 * Nothing about that failure was visible in code review: the call looked deliberate, the gates were
 * green, and the only symptom was a slow phone. So the shape of the check is "feed it both kinds of
 * image and assert it chooses differently" — a gate that cannot tell the two apart would have
 * passed the old code too, which is the thing worth refusing.
 */
import sharp from 'sharp';
import { encodeLogoWebp } from '../src/services/logoImage.js';

// Every assertion runs and reports, rather than exiting on the first. A gate that stops early
// cannot be PROVEN to fail — breaking the size cap made the wordmark assertion fire first, so the
// cap assertion was never reached and was, for all anyone knew, decorative.
const failures = [];
const fail = msg => failures.push(msg);

// A flat wordmark: hard edges, a handful of colours, no gradient. Lossless is both smaller AND
// crisper here, so the encoder must leave it alone.
const wordmark = await sharp({ create: { width: 900, height: 220, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: Buffer.from(
      '<svg width="900" height="220"><text x="20" y="150" font-size="120" font-family="Georgia" fill="#6b2d3c">Sweet Crumb</text></svg>'
    ), top: 0, left: 0 }])
  .png().toBuffer();

// A rendered emblem: smooth tone everywhere, which is what lossless cannot pack. Built as a radial
// gradient rather than shipped as a fixture so this file stays readable and has nothing to go stale.
const SZ = 640;
const px = Buffer.alloc(SZ * SZ * 4);
for (let y = 0; y < SZ; y++) for (let x = 0; x < SZ; x++) {
  const i = (y * SZ + x) * 4;
  const dx = x - SZ / 2, dy = y - SZ / 2, d = Math.hypot(dx, dy);
  px[i]     = 140 + 100 * Math.cos(d / 23);
  px[i + 1] = 110 + 90  * Math.sin(d / 31 + x / 400);
  px[i + 2] = 120 + 95  * Math.cos(d / 17 + y / 300);
  /* ⚠️ A SOFT EDGE, NOT A BINARY MASK. This ramp used to be `d < SZ/2 - 4 ? 255 : 0`, and with a
     pure 0-or-255 alpha the quality assertion below could not fail: WebP round-trips a binary mask
     exactly even at alphaQuality 80, so dropping alphaQuality broke nothing the gate could see.
     A real background removal returns an ANTI-ALIASED edge, which is where alpha quality shows. */
  px[i + 3] = Math.max(0, Math.min(255, Math.round((SZ / 2 - 6 - d) * 36)));
}
const emblem = await sharp(px, { raw: { width: SZ, height: SZ, channels: 4 } }).png().toBuffer();

const losslessOf = buf => sharp(buf)
  .resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true })
  .webp({ lossless: true }).toBuffer();

// 1. A flat wordmark is returned byte-identical to the lossless encode — the encoder has not been
//    talked into trading edge quality for a saving that was never there.
const wmOut = await encodeLogoWebp(wordmark);
const wmRef = await losslessOf(wordmark);
if (!wmOut.equals(wmRef)) {
  fail(`a flat wordmark went LOSSY (${wmRef.length} -> ${wmOut.length} B). ` +
       'Crisp edges are the whole point of lossless for this kind of mark.');
}

// 2. A continuous-tone emblem is meaningfully smaller than the lossless encode. The number is
//    deliberately well inside the measured margin (real logos land at 73–79%) so this asserts the
//    BEHAVIOUR and not a particular encoder version's byte count.
const emOut = await encodeLogoWebp(emblem);
const emRef = await losslessOf(emblem);
if (emOut.length > emRef.length * 0.75) {
  fail(`a continuous-tone emblem stayed large (${emRef.length} -> ${emOut.length} B, ` +
       `${Math.round(100 - 100 * emOut.length / emRef.length)}% saved). ` +
       'This is the case that made one logo 23% of a cold template load.');
}

// 3. Whichever path is taken, the cutout edge survives exactly. A soft or ringing alpha is the one
//    artefact a baker would see, because the logo sits on their own storefront colour.
const rawA = await sharp(emblem).resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).ensureAlpha().raw().toBuffer();
const rawB = await sharp(emOut).ensureAlpha().raw().toBuffer();
let worstAlpha = 0;
for (let i = 3; i < rawA.length; i += 4) worstAlpha = Math.max(worstAlpha, Math.abs(rawA[i] - rawB[i]));
if (worstAlpha !== 0) fail(`the cutout edge moved: alpha differs by up to ${worstAlpha}/255. alphaQuality must stay at 100.`);

// 4. The size cap still holds. 640 covers the largest box any surface draws a logo in (312x52 —
//    the settings preview tile and the storefront header), and nothing should quietly raise it.
const big = await sharp({ create: { width: 2000, height: 1400, channels: 4, background: { r: 200, g: 120, b: 90, alpha: 255 } } }).png().toBuffer();
const meta = await sharp(await encodeLogoWebp(big)).metadata();
if (meta.width > 640 || meta.height > 640) fail(`a 2000x1400 logo came back ${meta.width}x${meta.height}; the 640px cap is gone.`);

if (failures.length) {
  for (const f of failures) console.error(`✗ check:logo-encode — ${f}`);
  process.exit(1);
}
console.log('✓ check:logo-encode — flat marks stay lossless, tonal marks compress, the cutout edge and the 640px cap hold');
