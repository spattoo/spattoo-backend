#!/usr/bin/env node
//
// ── Shrink the environment map ───────────────────────────────────────────────────────────────────
//
// `code/env/lebombo_1k.hdr` is 1024×512 and 1.4 MB, and it loads with the canvas — before the cake
// is on screen. On mobile data that is most of the wait, and it buys almost nothing: three.js
// pre-blurs an environment map for roughness (PMREM), so the majority of those pixels are averaged
// away before they light anything. A cake is fondant and buttercream, not chrome.
//
//   1024×512   1.4 MB    today
//    512×256   ~350 KB   4× smaller, no visible difference
//    256×128   ~90 KB    15× smaller — watch gold leaf, the shiniest thing in the library
//
// ── This never overwrites the original ───────────────────────────────────────────────────────────
// It writes a NEW file at a NEW key. `ENV_HDR_PATH` in CakeCanvas.jsx picks which one is used, so
// rolling back is editing one line, not restoring a file.
//
// ── Usage ────────────────────────────────────────────────────────────────────────────────────────
//   node scripts/downsample-hdr.mjs --width=256                 # from the dev CDN → ./tmp
//   node scripts/downsample-hdr.mjs --width=256 --width=512     # both, to compare
//   node scripts/downsample-hdr.mjs --in=local.hdr --out=small.hdr --width=256
//
// Upload the result yourself (R2 dashboard, or the same path the assets migration uses) — this
// script only does the pixels, deliberately: writing to a bucket is not something a resize tool
// should decide to do.
//
// ── Why the averaging happens in FLOAT ───────────────────────────────────────────────────────────
// RGBE packs a shared exponent into the fourth byte, so two neighbouring pixels can carry the same
// mantissa at wildly different brightness. Averaging the BYTES would blend those as if they were
// equal — a bright sky pixel next to a dark one would come out mid-grey rather than bright, and the
// whole map would lose its highlights, which are the only part that matters for reflections.
// So: decode to linear float, box-average, re-encode.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const flag = (n, d = null) => argv.find(a => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=') ?? d;
const flags = (n) => argv.filter(a => a.startsWith(`--${n}=`)).map(a => a.split('=').slice(1).join('='));

const SRC_URL = flag('url', 'https://dev.spattoocdn.com/code/env/lebombo_1k.hdr');
const IN      = flag('in');
const OUT_DIR = flag('outdir', path.join(import.meta.dirname, '..', 'tmp'));
const WIDTHS  = (flags('width').length ? flags('width') : ['256']).map(Number);

const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };

// ── Radiance .hdr decode ─────────────────────────────────────────────────────────────────────────
function decodeHdr(buf) {
  // Header is ASCII lines up to a blank one, then the resolution line.
  let p = 0;
  const line = () => { let s = ''; while (buf[p] !== 0x0a) s += String.fromCharCode(buf[p++]); p++; return s; };

  if (!line().startsWith('#?')) die('not a Radiance .hdr (missing #? magic)');
  let l;
  while ((l = line()) !== '') {
    if (/^FORMAT=/.test(l) && !/32-bit_rle_rgbe/.test(l)) die(`unsupported FORMAT: ${l}`);
  }

  const res = line().trim().match(/^-Y\s+(\d+)\s+\+X\s+(\d+)$/);
  if (!res) die('unsupported resolution line (only -Y h +X w is handled)');
  const height = +res[1], width = +res[2];

  // Float RGB, linear. Alpha/exponent is gone by design — it exists only to pack the file.
  const out = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4);

  for (let y = 0; y < height; y++) {
    // New-style adaptive RLE: 0x02 0x02 <width hi> <width lo>, then four component passes.
    // Anything else is flat RGBE, four bytes per pixel in order.
    if (buf[p] === 2 && buf[p + 1] === 2 && ((buf[p + 2] << 8) | buf[p + 3]) === width && width >= 8 && width < 32768) {
      p += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < width) {
          const n = buf[p++];
          if (n > 128) {                       // a run: (n-128) copies of the next byte
            const v = buf[p++];
            for (let k = 0; k < n - 128; k++) scan[(x++) * 4 + c] = v;
          } else {                             // a literal span of n bytes
            for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = buf[p++];
          }
        }
      }
    } else {
      for (let i = 0; i < width * 4; i++) scan[i] = buf[p++];
    }

    for (let x = 0; x < width; x++) {
      const e = scan[x * 4 + 3];
      // e === 0 is exact black. Without this branch it would decode as 2^-136, i.e. denormal noise.
      const f = e ? Math.pow(2, e - 136) : 0;
      const i = (y * width + x) * 3;
      out[i]     = scan[x * 4]     * f;
      out[i + 1] = scan[x * 4 + 1] * f;
      out[i + 2] = scan[x * 4 + 2] * f;
    }
  }
  return { width, height, data: out };
}

// ── Box downsample, in linear light ──────────────────────────────────────────────────────────────
// A plain box filter is right here: the target is a power-of-two division of the source, so every
// output pixel is an exact, equal-weighted block of inputs. Nothing to be gained from a fancier
// kernel when the environment gets convolved into near-nothing downstream anyway.
function downsample(img, outW) {
  const outH = Math.round(outW / 2);                 // equirectangular is always 2:1
  const bx = img.width / outW, by = img.height / outH;
  if (!Number.isInteger(bx) || !Number.isInteger(by)) die(`${img.width}×${img.height} does not divide evenly into ${outW}×${outH}`);

  const out = new Float32Array(outW * outH * 3);
  const n = bx * by;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < by; sy++) {
        const row = (y * by + sy) * img.width;
        for (let sx = 0; sx < bx; sx++) {
          const i = (row + x * bx + sx) * 3;
          r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2];
        }
      }
      const o = (y * outW + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return { width: outW, height: outH, data: out };
}

// ── Encode back to RGBE, with RLE ────────────────────────────────────────────────────────────────
function encodeHdr(img) {
  const { width, height, data } = img;
  const header = Buffer.from(`#?RADIANCE\n# Downsampled by scripts/downsample-hdr.mjs\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, 'ascii');
  const chunks = [header];
  const scan = new Uint8Array(width * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const v = Math.max(r, g, b);
      if (v < 1e-32) { scan[x * 4] = scan[x * 4 + 1] = scan[x * 4 + 2] = scan[x * 4 + 3] = 0; continue; }
      // frexp: v = m * 2^e with m in [0.5, 1). The mantissa is then rescaled to a byte.
      const e = Math.ceil(Math.log2(v));
      const s = Math.pow(2, -e) * 256;
      scan[x * 4]     = Math.min(255, Math.floor(r * s));
      scan[x * 4 + 1] = Math.min(255, Math.floor(g * s));
      scan[x * 4 + 2] = Math.min(255, Math.floor(b * s));
      scan[x * 4 + 3] = e + 128;
    }

    // New-style RLE, one pass per component. Runs of 4+ are worth encoding; shorter ones cost more
    // in overhead than they save, which is why the threshold is not 2.
    const row = [2, 2, (width >> 8) & 0xff, width & 0xff];
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        let run = 1;
        while (x + run < width && run < 127 && scan[(x + run) * 4 + c] === scan[x * 4 + c]) run++;
        if (run >= 4) {
          row.push(128 + run, scan[x * 4 + c]);
          x += run;
        } else {
          // Gather literals until a run of 4 appears, capped at 128 per the format.
          const start = x;
          let lit = 0;
          while (x < width && lit < 128) {
            let r2 = 1;
            while (x + r2 < width && r2 < 5 && scan[(x + r2) * 4 + c] === scan[x * 4 + c]) r2++;
            if (r2 >= 4) break;
            x++; lit++;
          }
          row.push(lit);
          for (let k = 0; k < lit; k++) row.push(scan[(start + k) * 4 + c]);
        }
      }
    }
    chunks.push(Buffer.from(row));
  }
  return Buffer.concat(chunks);
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────────
const source = IN
  ? readFileSync(IN)
  : Buffer.from(await (await fetch(SRC_URL).then(r => r.ok ? r : die(`fetch failed: ${r.status} ${SRC_URL}`))).arrayBuffer());

const src = decodeHdr(source);
console.log(`\n  source: ${src.width}×${src.height}  ${(source.length / 1024).toFixed(0)} KB`);

mkdirSync(OUT_DIR, { recursive: true });

for (const w of WIDTHS) {
  const small = downsample(src, w);
  const buf = encodeHdr(small);

  // Round-trip check. This script hand-rolls an RLE encoder, and a bug in it would surface as a
  // subtly wrong sky in the designer rather than an error — so decode our own output and confirm it
  // reads back at the right size with plausible values, before anyone uploads it.
  const back = decodeHdr(buf);
  if (back.width !== small.width || back.height !== small.height) die('round-trip failed: size mismatch');
  // Error is measured against the PIXEL's brightest channel, not against each channel on its own.
  // RGBE shares one exponent across R, G and B, so a channel that is dim beside a bright one
  // genuinely quantises towards zero — that is the format working as designed, and judging it
  // per-channel reports 100% error on a value nobody can see. What matters is that no pixel shifts
  // relative to its own brightness, which is what an encoder bug would actually do.
  let maxErr = 0;
  for (let i = 0; i < small.data.length; i += 3) {
    const peak = Math.max(small.data[i], small.data[i + 1], small.data[i + 2], 1e-6);
    for (let c = 0; c < 3; c++) {
      const rel = Math.abs(small.data[i + c] - back.data[i + c]) / peak;
      if (rel > maxErr) maxErr = rel;
    }
  }
  // 1/256 of the peak is the quantisation step, so ~0.4% is the floor. 1% leaves room for the
  // exponent boundary without letting a real encoder bug through.
  if (maxErr > 0.01) die(`round-trip failed: ${(maxErr * 100).toFixed(2)}% of peak (quantisation alone is ~0.4%)`);

  const out = flag('out') ?? path.join(OUT_DIR, `lebombo_${w}.hdr`);
  writeFileSync(out, buf);
  console.log(`  → ${small.width}×${small.height}  ${(buf.length / 1024).toFixed(0)} KB  (${(source.length / buf.length).toFixed(1)}× smaller, round-trip ok)  ${path.relative(process.cwd(), out)}`);
}
console.log(`\n  Upload the one you want, then point ENV_HDR_PATH (CakeCanvas.jsx) at its key.`);
console.log(`  The original stays where it is — rollback is that one line.\n`);
