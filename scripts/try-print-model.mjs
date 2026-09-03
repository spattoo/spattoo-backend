#!/usr/bin/env node
/* ── Does gpt-image-2 actually spell the plaque? ──────────────────────────────────────────────────
 *
 * The ONLY justification for putting edible prints on a dearer model is text: half of what a baker
 * prints is words, and "Our little goose is on the way" going out misspelt on a baby-shower cake is
 * how this feature embarrasses a bakery. That claim came from a model card, not from our own eyes.
 *
 * So this generates the SAME plaque on both models and writes both PNGs out, side by side. If the
 * cheaper one spells it correctly too, the split has no justification and `print` should go back on
 * the global model — deleting a config entry is easier than defending a bill.
 *
 * ⚠️ THIS SPENDS REAL MONEY — one image per model, roughly $0.03–0.06 each. It is a script, run by
 * hand, and it is not wired into any check.
 *
 *   npm run try:print-model
 *   npm run try:print-model -- "Ava is one!"
 *   npm run try:print-model -- "Our little goose is on the way" gpt-image-2
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

await import('dotenv/config');

if (!process.env.OPENAI_API_KEY) {
  console.error('✗ OPENAI_API_KEY is not set, and this makes a real API call.\n');
  console.error('  It is not in the repo .env — supply it for this one command:');
  console.error('    OPENAI_API_KEY=sk-... npm run try:print-model\n');
  process.exit(1);
}

/* config.js hard-fails on ANY missing required var, not just the one this script needs — so having
 * the OpenAI key alone was not enough to run it. Placeholders for everything else, `||=` so a real
 * value always wins, exactly as check-boot does it. OPENAI_API_KEY is deliberately absent from the
 * list: it is the one thing here that must be real, and the guard above already refused without it. */
for (const [key, value] of Object.entries({
  SUPABASE_URL: 'https://stub.supabase.co',
  SUPABASE_SERVICE_KEY: 'stub',
  REMOVE_BG_API_KEY: 'stub',
  REDIS_URL: 'redis://127.0.0.1:6379',
  R2_ENDPOINT: 'https://stub.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'stub',
  R2_SECRET_ACCESS_KEY: 'stub',
  R2_BUCKET: 'stub',
  R2_PUBLIC_URL: 'https://stub.example',
})) process.env[key] ||= value;

const { config } = await import('../src/config.js');
const { generateDecorationImage } = await import('../src/services/openai.js');

const [textArg, ...modelArgs] = process.argv.slice(2);
const TEXT   = textArg || 'Our little goose is on the way';
const MODELS = modelArgs.length ? modelArgs : [config.openai.imageModel, 'gpt-image-2'];

/* The prompt a real print would carry. Deliberately the SAME wording the feature will use — a test
 * that quietly writes a better prompt than production tells you nothing about production. */
const PROMPT = process.env.PROMPT
  ? process.env.PROMPT.replace('{TEXT}', TEXT)
  : `a decorative baby-shower plaque: an ornate gold-outlined frame on a cream background, ` +
    `with the words "${TEXT}" inside it in an elegant gold script`;
/* ⚠️ The default says "ornate" and "baby-shower", which INVITES decoration — the first run came
 * back with a goose and foliage nobody asked for, and that was the prompt's doing as much as the
 * model's. PROMPT= overrides it, so "does this model embellish?" can be asked with a prompt that
 * does not ask it to. Use {TEXT} as the placeholder. */

const OUT = resolve(process.cwd(), 'tmp/print-model-test');
mkdirSync(OUT, { recursive: true });

console.log(`\n  text    "${TEXT}"`);
console.log(`  models  ${MODELS.join('  vs  ')}`);
console.log(`  out     ${OUT}\n`);

let failures = 0;
for (const model of MODELS) {
  /* Mutated rather than set through the env, because the point is ONE run showing both. `print`
   * resolves through config at call time (modelForIntent), so this is the seam — and a throwaway
   * script is the one place reaching into config is honest. */
  config.openai.imageModelByIntent = { ...config.openai.imageModelByIntent, print: model };

  process.stdout.write(`  ${model.padEnd(16)} generating… `);
  const started = Date.now();
  try {
    // `fresh` — no reference image. Nothing of a source photo is sent, which is both what a
    // generated plaque actually is and cheaper (no input image to tokenise).
    const [png] = await generateDecorationImage(null, PROMPT, '1024x1024', 'print', 'fresh', 1);
    const file = resolve(OUT, `${model.replace(/[^\w.-]/g, '_')}.png`);
    writeFileSync(file, png);
    console.log(`ok  ${((Date.now() - started) / 1000).toFixed(1)}s  ${(png.length / 1024).toFixed(0)}KB`);
    console.log(`  ${' '.repeat(16)} ${file}`);
  } catch (err) {
    failures++;
    console.log('FAILED');
    console.log(`  ${' '.repeat(16)} ${String(err.message).slice(0, 300)}`);
  }
}

console.log('\n  Open both and read the words. The question is only: is the text right?');
console.log('  If the cheaper model spells it correctly, drop the split.\n');
process.exit(failures === MODELS.length ? 1 : 0);
