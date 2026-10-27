#!/usr/bin/env node
/* ── What does story→template search actually return from the real library? ──────────────────────
 *
 * The gate next door proves the ranker keeps its properties against made-up numbers. This asks the
 * only question that matters: point it at the real catalogue and real sentences, and see what comes
 * back. One embedding call per story (`text-embedding-3-small`, $0.02 per million tokens against a
 * story of about fifty) — no generative model, no credits.
 *
 *   node scripts/eval-story-search.mjs
 *   node scripts/eval-story-search.mjs --story "she loves doing her nails and lipstick"
 */
import 'dotenv/config';
/* The same placeholders the benchmark uses: this reaches OpenAI and reads the catalogue, and
   touches neither Redis nor R2 writes. A future edit that does will fail loudly on these. */
for (const [k, v] of Object.entries({
  REDIS_URL: 'redis://unused.eval.invalid:6379',
  R2_ACCESS_KEY_ID: 'unused-by-eval', R2_SECRET_ACCESS_KEY: 'unused-by-eval',
})) if (!process.env[k]) process.env[k] = v;

const { searchTemplatesByStory } = await import('../src/services/storyMatch.js');

const i = process.argv.indexOf('--story');
const STORIES = i > -1 ? [process.argv[i + 1]] : [
  'my daughter likes makeup kits, can you generate a cake for her',
  'she loves doing her nails and lipstick',
  'i am looking for a super hero cake for 8 year old boy',
  'a mermaid cake for my niece turning 6, she loves turquoise and pink',
  'cars theme cake for a 4 year old, blue and red',
  "it's my mum's 60th, she gardens constantly and her house is full of roses",
  'something for a cricket mad teenager',
  'i need a birthday cake for next week',
];

for (const story of STORIES) {
  const t0 = Date.now();
  const { templates, subject, ages } = await searchTemplatesByStory(story, { limit: 4 });
  const ms = Date.now() - t0;
  console.log(`\n"${story}"   (${ms}ms)`);
  console.log(`   embedded: "${subject}"${ages?.length ? `   ages: ${ages.join(',')}` : ''}`);
  if (!templates.length) { console.log('   — nothing matched —'); continue; }
  for (const t of templates) {
    console.log(`   ${t.score.toFixed(3)}  ${t.name}`);
    console.log(`          because: ${t.why.map(w => `${w.name} ${w.similarity.toFixed(2)}`).join(', ')}`);
  }
}
