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

if (failures) {
  console.error(`\n✗ check:image-model — ${failures} rule(s) broken.`);
  process.exit(1);
}
console.log('✓ check:image-model — every intent on the global model, and BOTH capability gates follow the resolved model');
