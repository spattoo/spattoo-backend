#!/usr/bin/env node
// ── Tripo refuses parts AND texture; we must never ask for both ─────────────────────────────────
//
// From Tripo's own docs (read 2026-10-31): *"generate_parts is not compatible with texture=true or
// pbr=true. If you want to generate parts, please set texture=false and pbr=false."*
//
// So this is a FORK, not two independent booleans — and the two sides serve different people:
//
//   ready to use   texture + pbr, one fused mesh   — the baker, with a customer waiting
//   recolourable   parts, no maps                  — the catalogue, finished by staff
//
// ⚠️ THE FAILURE IS A WASTED GENERATION, WHICH IS THE WORST SHAPE OF BUG HERE. Asking for both does
// not fail fast: the request is accepted, 20-30 credits and several minutes are spent, and what
// comes back is missing whichever half the vendor decided to drop. The baker finds out at the end.
// Three booleans in a request body is all it takes, so the resolution lives in ONE function
// (`appearance()` in services/tripo.js) and this asserts that every caller goes through it.
//
// Pure text reading: no network, no vendor call. Run via `npm run check:tripo-appearance`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src  = readFileSync(join(ROOT, 'src/services/tripo.js'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const failures = [];

// 1. The resolver exists and sets all three together.
const fn = code.slice(code.indexOf('function appearance'), code.indexOf('export async function createImageTo3D'));
if (!fn.includes('function appearance')) {
  failures.push('appearance() is gone — the fork has to be resolved in one place, or a caller will ask for both.');
} else {
  if (!/generate_parts:\s*true,\s*texture:\s*false,\s*pbr:\s*false/.test(fn)) {
    failures.push('the parts branch no longer forces texture:false AND pbr:false — Tripo rejects the combination.');
  }
}

// 2. No task builder sets generate_parts itself. This is the smell that preceded the resolver: a
//    `...(parts ? { generate_parts: true } : {})` spread sitting next to a bare `texture,`.
for (const m of code.matchAll(/export async function (create\w+)\(([\s\S]*?)\n\}/g)) {
  const [, name, body] = m;
  if (name === 'createTextTo3D' || name === 'createImageTo3D') {
    if (/generate_parts/.test(body)) {
      failures.push(`${name} sets generate_parts directly instead of calling appearance() — that is how the impossible combination gets rebuilt.`);
    }
    if (/^\s*texture,\s*$/m.test(body) || /^\s*pbr,\s*$/m.test(body)) {
      failures.push(`${name} passes texture/pbr straight through rather than through appearance().`);
    }
    if (!/\.\.\.appearance\(/.test(body)) {
      failures.push(`${name} does not call appearance().`);
    }
  }
}

if (failures.length) {
  console.error('✗ check:tripo-appearance — a request could ask Tripo for parts AND texture:\n');
  for (const f of failures) console.error(`    • ${f}`);
  console.error('\n  Tripo accepts it, spends the credits, and returns a model missing one half.');
  process.exit(1);
}
console.log('✓ check:tripo-appearance — parts and texture are resolved in one place; no caller can ask for both');
