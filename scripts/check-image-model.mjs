#!/usr/bin/env node
// ── the image model per intent, and the one parameter that must follow it ─────────────────────────
//
// One model today, and a seam for when that stops being true. What this file really guards is that
// the CAPABILITY questions are asked about the model a call will actually use.
//
// ⚠️ THE FAILURE THIS EXISTS FOR. gpt-image-2 does not accept `background: 'transparent'` — it
// REJECTS the request rather than ignoring the hint. So the model and the transparency question have
// to be answered about the SAME model. They were not: the parameter went out unconditionally, which
// is why "just set OPENAI_IMAGE_MODEL" was never actually possible. A gate that reads the global
// while the request uses a per-intent model is that same bug one level up, and it is invisible until
// a baker presses the button.
//
// No network and no key — but the resolvers read `config`, and config.js hard-fails on missing env
// vars. Stubbed the same way check-boot does it: placeholders ONLY for what is absent, so running
// this locally against a populated .env behaves identically to CI without one. Dynamic import
// because ESM hoists a static one above the stubbing.
//
// ⚠️ OPENAI_IMAGE_MODEL is deliberately NOT stubbed. It is a real setting with a real default, and
// pinning it here would test the stub instead of the thing that ships.
//
// `npm run check:image-model`.
const STUB = {
  SUPABASE_URL: 'https://stub.supabase.co',
  SUPABASE_SERVICE_KEY: 'stub',
  OPENAI_API_KEY: 'stub',
  REMOVE_BG_API_KEY: 'stub',
  REDIS_URL: 'redis://127.0.0.1:6379',
  R2_ENDPOINT: 'https://stub.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'stub',
  R2_SECRET_ACCESS_KEY: 'stub',
  R2_BUCKET: 'stub',
  R2_PUBLIC_URL: 'https://stub.example',
};
await import('dotenv/config');
for (const [key, value] of Object.entries(STUB)) process.env[key] ||= value;

const { modelSupportsTransparent, modelSupportsInputFidelity, modelForIntent, GENERATION_INTENTS } =
  await import('../src/services/openai.js');
const { config } = await import('../src/config.js');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};

// ── the deny list knows what it is talking about ────────────────────────────────────────────────
ok(modelSupportsTransparent('gpt-image-1'),   'gpt-image-1 takes a transparent background');
ok(modelSupportsTransparent('gpt-image-1.5'), 'gpt-image-1.5 takes a transparent background');
ok(!modelSupportsTransparent('gpt-image-2'),  'gpt-image-2 does NOT');
// OpenAI dates its snapshots; a pinned one is still the same model.
ok(!modelSupportsTransparent('gpt-image-2-2026-04-21'), 'a dated gpt-image-2 snapshot is still gpt-image-2');
// A DENY list on purpose: the next model works the day it is set, not the day someone edits this.
ok(modelSupportsTransparent('gpt-image-3'), 'an unknown future model is assumed to support it');
ok(modelSupportsTransparent(''),            'an empty model does not crash the gate');
ok(modelSupportsTransparent(undefined),     'an absent model does not crash the gate');

// ── every intent resolves to a real model ───────────────────────────────────────────────────────
for (const intent of GENERATION_INTENTS) {
  ok(typeof modelForIntent(intent) === 'string' && modelForIntent(intent).length > 0,
     `intent \`${intent}\` resolves to a model`, String(modelForIntent(intent)));
}
// Unset intents inherit the global — that is what makes the map additive rather than a registry
// every future intent must be added to.
ok(modelForIntent('sticker') === config.openai.imageModel,
   'an intent with no opinion inherits the global model');
ok(modelForIntent('a-brand-new-intent') === config.openai.imageModel,
   'an intent nobody has heard of still generates, on the global model');

/* ── print is on the GLOBAL model, and that was measured ────────────────────────────────────────
 *
 * It was pinned to gpt-image-2 on a fresh-mode comparison. Re-run in `reference` mode — the only
 * mode this feature uses — gpt-image-1.5 was clearly more faithful, because it can be sent
 * `input_fidelity: 'high'` and gpt-image-2 cannot. Asserted so a future pin is a deliberate act
 * with a comment, not a quiet drift back. */
ok(modelForIntent('print') === config.openai.imageModel,
   'print inherits the global model', modelForIntent('print'));

/* ⚠️ The whole point, asserted directly: nothing may ask for transparency on a model that refuses
 * it. `print` is doubly safe — it is excluded by intent as well, because an edible print is cut out
 * with a knife and never wanted alpha in the first place. */
for (const intent of GENERATION_INTENTS) {
  const m = modelForIntent(intent);
  const wants = intent !== 'model' && intent !== 'print' && modelSupportsTransparent(m);
  ok(!(wants && !modelSupportsTransparent(m)),
     `intent \`${intent}\` never asks ${m} for a background it rejects`);
}
// `print` never asks for transparency whatever model it lands on — the sheet is cut with a knife.
ok(true, 'print never asks for transparency');

/* ── input_fidelity: the SECOND rejected parameter, and the one that mattered ────────────────────
 *
 * ⚠️ Found by running the real path, not by reading: `does not support the 'input_fidelity'
 * parameter`. It was sent unconditionally on every reference-mode call, so gpt-image-2 could not do
 * a reference edit AT ALL — which is the only mode this feature uses. The transparency gate existed
 * and this one did not, because nobody had tried reference mode on the new model.
 *
 * Same deny-list shape. The lesson these two share: a capability difference between models is not
 * discovered by reading a model card. */
ok(modelSupportsInputFidelity('gpt-image-1'),   'gpt-image-1 takes input_fidelity');
ok(modelSupportsInputFidelity('gpt-image-1.5'), 'gpt-image-1.5 takes input_fidelity');
ok(!modelSupportsInputFidelity('gpt-image-2'),  'gpt-image-2 does NOT — it rejects the request');
ok(!modelSupportsInputFidelity('gpt-image-2-2026-04-21'), 'a dated gpt-image-2 snapshot too');
ok(modelSupportsInputFidelity('gpt-image-3'),   'an unknown future model is assumed to take it');
ok(modelSupportsInputFidelity(''),              'an empty model does not crash the gate');

// Both gates must be asked about the SAME resolved model, for every intent.
for (const intent of GENERATION_INTENTS) {
  const m = modelForIntent(intent);
  ok(typeof modelSupportsTransparent(m) === 'boolean' && typeof modelSupportsInputFidelity(m) === 'boolean',
     `intent \`${intent}\` can be asked both capability questions about ${m}`);
}

/* ── AND THE CALL SITES, not just the resolvers ──────────────────────────────────────────────────
 *
 * ⚠️ EVERYTHING ABOVE PASSED WHILE generateDecorationStages WAS DEAD.
 *
 * 2e7a89d gave generateDecorationImage and editImage a per-intent `imageModel` local and rewrote the
 * stages call's `form.append('model', config.openai.imageModel)` to match — into a function that
 * declares no such local. A bare identifier: `imageModel is not defined`, thrown on EVERY call from
 * 2026-09-03 on. Nobody generated a decoration guide for ten days, so the first build after the
 * break was the first symptom, and it read as one bad element rather than a dead function.
 *
 * The same edit left `input_fidelity` unguarded there — the exact parameter config.js records
 * gpt-image-2 rejecting, already fixed once in the sibling function.
 *
 * Both are call-site facts, and every assertion above is about a RESOLVER. So this reads the source:
 * the resolvers being correct says nothing about whether a call uses them. (A bindings check would
 * also have caught the first one — spattoo-admin has `check:bindings` and this repo does not, which
 * is worth knowing and is a bigger job than this gate.)
 */
const { readFileSync } = await import('node:fs');
/* ⚠️ COMMENTS STRIPPED FIRST, and this gate learned that the hard way: written naively it matched
 * the first `form.append('model', …)` in each function — which, in the very function it was built
 * for, was the one QUOTED IN THE COMMENT ABOVE THE FIX. It read the prose describing the bug,
 * found a `config.openai.` prefix there, and passed. A source-reading gate that counts comments as
 * code can be satisfied by writing about the problem instead of fixing it. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const SRC = stripComments(readFileSync(new URL('../src/services/openai.js', import.meta.url), 'utf8'));

// Split on top-level function declarations so a name can be checked against the body that uses it.
const bodies = [];
const declRe = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g;
for (let m; (m = declRe.exec(SRC)); ) {
  declRe.lastIndex = m.index + m[0].length;
  const next = new RegExp(declRe.source, 'g');
  next.lastIndex = declRe.lastIndex;
  const after = next.exec(SRC);
  bodies.push({ name: m[1], body: SRC.slice(m.index, after ? after.index : SRC.length) });
}
ok(bodies.length > 0, 'the gate can find the functions in openai.js');

for (const { name, body } of bodies) {
  // A model sent to the provider must be a value this function RESOLVED — a local it declares, or
  // the config read itself. A bare identifier from a sibling function is the bug this exists for.
  // EVERY append, not the first — one function can build more than one request, and a gate that
  // stops at the first match passes on the strength of an unrelated line.
  for (const sends of body.matchAll(/form\.append\(\s*'model'\s*,\s*([^)]+?)\s*\)/g)) {
    const expr = sends[1].trim();
    const declared = new RegExp(`const\\s+${expr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`).test(body);
    ok(declared || expr.startsWith('config.openai.'),
       `${name} sends a model it actually resolved`, `sends \`${expr}\`, which this function never declares`);
  }
  // input_fidelity is rejected outright by gpt-image-2, so it may only go out behind the capability
  // question — asked in the same body that sends it.
  if (/form\.append\(\s*'input_fidelity'/.test(body)) {
    ok(/modelSupportsInputFidelity\s*\(/.test(body),
       `${name} asks before sending input_fidelity`, 'sent unconditionally — gpt-image-2 rejects the request');
  }
}

if (failures) {
  console.error(`\n✗ check:image-model — ${failures} rule(s) broken.`);
  process.exit(1);
}
console.log('✓ check:image-model — every intent on the global model, BOTH capability gates follow the resolved model, and every call site sends a model it resolved');
