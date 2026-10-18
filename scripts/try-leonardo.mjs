#!/usr/bin/env node
// ── Prove the Leonardo call before trusting it ──────────────────────────────────────────────────
//
// ⚠️ THE ONE THING THE GATES CANNOT ANSWER. Every rule in check:bg-fallback is about our own
// policy; none of them has ever made a request. The request shape here was taken from Leonardo's
// own migration guide rather than from memory, but a shape that reads right and a call that works
// are different claims — this repo has the scar already, from a WhatsApp payload "verified" by
// intercepting our own outbound JSON while the other end had never accepted one.
//
//   node --env-file=.env scripts/try-leonardo.mjs path/to/photo.jpg
//
// ⚠️ --env-file, because this imports the REAL provider rather than a copy of its request shape —
// and the real one reads config.js, which refuses to load without the service's required env. A
// second copy of the body here would prove that the copy works.
//
// Writes the cut-out beside the input as *-nobg.png and prints what the call actually cost.
import { readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2];
if (!input) {
  console.error('usage: LEONARDO_API_KEY=... node scripts/try-leonardo.mjs <image>');
  process.exit(1);
}
if (!process.env.LEONARDO_API_KEY) {
  console.error('LEONARDO_API_KEY is not set — create one at app.leonardo.ai → API Access');
  process.exit(1);
}

let removeBackground;
try {
  ({ removeBackground } = await import('../src/services/leonardo.js'));
} catch (err) {
  console.error(`could not load the provider: ${err.message}`);
  console.error('run it as:  node --env-file=.env scripts/try-leonardo.mjs <image>');
  process.exit(1);
}

const bytes = readFileSync(input);
const started = Date.now();
try {
  const { png, costUsd } = await removeBackground(bytes);
  const out = input.replace(/\.[^./]+$/, '') + '-nobg.png';
  writeFileSync(out, png);
  // The cost comes off THEIR response, not off a price we remember — so this line is also the
  // check on whether $0.1047 is still the figure.
  console.log(`✓ ${out}  ${(png.length / 1024).toFixed(0)} KB  ${Date.now() - started}ms  ` +
              `cost ${costUsd == null ? 'not reported' : `$${costUsd}`}`);
} catch (err) {
  console.error(`✗ ${err.message}${err.status != null ? `  (status ${err.status})` : ''}`);
  process.exit(1);
}
