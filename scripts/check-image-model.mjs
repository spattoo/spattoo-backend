#!/usr/bin/env node
// ── the image model per intent, and the one parameter that must follow it ─────────────────────────
//
// Two models are in play: gpt-image-2 for `print`, because half of what a baker prints is words and
// it renders text far more reliably; whatever `imageModel` says for everything else, because that
// work is admin building the catalogue on our money.
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

const { modelSupportsTransparent, modelForIntent, GENERATION_INTENTS } =
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

// ── print is the one that differs, and it differs deliberately ──────────────────────────────────
ok(modelForIntent('print') === 'gpt-image-2',
   'print generates on gpt-image-2', modelForIntent('print'));
ok(modelForIntent('print') !== modelForIntent('sticker'),
   'print and sticker are NOT the same model — if they are, the split has silently collapsed');

/* ⚠️ The whole point, asserted directly: nothing may ask for transparency on a model that refuses
 * it. `print` is doubly safe — it is excluded by intent as well, because an edible print is cut out
 * with a knife and never wanted alpha in the first place. */
for (const intent of GENERATION_INTENTS) {
  const m = modelForIntent(intent);
  const wants = intent !== 'model' && intent !== 'print' && modelSupportsTransparent(m);
  ok(!(wants && !modelSupportsTransparent(m)),
     `intent \`${intent}\` never asks ${m} for a background it rejects`);
}
ok(!(modelForIntent('print') && modelSupportsTransparent(modelForIntent('print'))),
   'print is on a model that would reject transparency — which is fine, because print never asks');

if (failures) {
  console.error(`\n✗ check:image-model — ${failures} rule(s) broken.`);
  process.exit(1);
}
console.log('✓ check:image-model — print on gpt-image-2, the rest on the global, and transparency follows the resolved model');
