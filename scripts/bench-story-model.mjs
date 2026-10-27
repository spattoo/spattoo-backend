#!/usr/bin/env node
/* ── Which model should turn a baker's STORY into a cake spec? ───────────────────────────────────
 *
 * Sandeep: *"can we check if we can get a cheaper model. ofcourse cost is always an issue"*.
 *
 * ⚠️ THE PROMPT IS THE COST, NOT THE STORY. Measured on the shipped photo prompt: 6,040 characters
 * ≈ 1,510 tokens of instructions against ~50 tokens of story. 97% of what every call pays for is
 * the schema and the rules — so this benchmark runs a TRIMMED, text-only prompt rather than the
 * photo one. Everything a photograph needs and a story cannot have is gone: `bbox`,
 * `tier_width_ratio` (both measured against an image), and the photo-print privacy rules (there is
 * no photograph to describe a person in).
 *
 * ⚠️ AND IT IS SCORED ON WHETHER OUR MATCHER CAN SERVE THE SPEC, not on whether the JSON reads
 * nicely. A spec is worth nothing if `matchAnalysis` cannot resolve its decorations to real rows in
 * `cake_elements` — that is the whole bakeability argument. So every run goes through the SAME
 * match step the photo path uses, and the headline number is how many decorations came back with a
 * confident element behind them.
 *
 * Usage:
 *   node scripts/bench-story-model.mjs --dry                 # print the prompt + stories, call nothing
 *   node scripts/bench-story-model.mjs                       # the default model set
 *   node scripts/bench-story-model.mjs --models gpt-5-nano,gpt-4o
 *   node scripts/bench-story-model.mjs --stories 3           # first N stories only
 *   node scripts/bench-story-model.mjs --out bench.json      # keep every spec for reading
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';

/* ⚠️ `config.js` IS A SERVER GATE, AND THIS IS NOT THE SERVER. It throws unless every runtime
   secret is present — Redis, the R2 write keys — because a server missing one of those is a server
   that fails later, in front of a baker. A benchmark touches neither: it calls OpenAI and reads
   `cake_elements` through the service key. So the handful this script provably does not use are
   given obvious placeholders rather than asking whoever runs it to invent real ones. If a future
   edit makes the benchmark actually reach Redis or write to R2, it will fail loudly on these
   values, which is the right outcome. */
for (const [k, v] of Object.entries({
  REDIS_URL: 'redis://unused.bench.invalid:6379',
  R2_ACCESS_KEY_ID: 'unused-by-bench',
  R2_SECRET_ACCESS_KEY: 'unused-by-bench',
})) if (!process.env[k]) process.env[k] = v;

const { config } = await import('../src/config.js');
const { matchAnalysis } = await import('../src/services/inspirationMatch.js');

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] ?? true) : dflt;
};
const DRY = process.argv.includes('--dry');

/* Priced per 1M tokens, read off OpenAI's pricing page on 2026-10-27. Kept here so the run prints a
   real cost rather than a vague "cheaper" — and so a stale number is visible rather than implied. */
const PRICE = {
  'gpt-4o':       { in: 2.50, out: 10.00 },
  'gpt-5-mini':   { in: 0.25, out: 2.00 },
  'gpt-4o-mini':  { in: 0.15, out: 0.60 },
  // gpt-4.1-nano: on the pricing page, DEPRECATED at the API — 404 on every call, 2026-10-27.
  'gpt-5-nano':   { in: 0.05, out: 0.40 },
};
const MODELS = String(arg('models', 'gpt-4o,gpt-5-mini,gpt-4o-mini,gpt-5-nano')).split(',');

/* ⚠️ THE STORIES ARE CHOSEN TO FAIL IN DIFFERENT WAYS, not to be answered well. A benchmark of five
   easy prompts tells you nothing: every model passes. These cover a theme we stock, a theme we do
   NOT stock (superhero — zero elements in the library, almost certainly on purpose, since those
   characters are trademarked), a subject with no theme tag at all but plenty of elements (makeup),
   a rambling story where the subject has to be found inside noise, a story with no subject at all,
   and one that asks for something physically silly. */
const STORIES = [
  { id: 'makeup-short',  text: 'my daughter likes makeup kits, can you generate a cake for her' },
  { id: 'superhero',     text: 'i am looking for a super hero cake for 8 year old boy' },
  { id: 'mermaid-rich',  text: 'a mermaid cake for my niece turning 6, she loves turquoise and pink, something with pearls' },
  { id: 'rambling',      text: "it's my mum's 60th next Sunday, we're doing lunch at my sister's place, she's never liked fuss, she gardens constantly and her whole house is full of roses, nothing too sweet, maybe 15 of us" },
  { id: 'no-subject',    text: 'i need a birthday cake for next week' },
  { id: 'two-tier-wed',  text: 'two tier wedding cake, white and gold, elegant, fresh flowers on top' },
  { id: 'impossible',    text: 'a cake shaped like a working motorbike that my son can sit on' },
  { id: 'cars-kid',      text: 'cars theme cake for a 4 year old, blue and red' },
];

/* ⚠️ TRIMMED FOR TEXT. The photo prompt's job is to READ a cake; this one's is to PROPOSE one from
   a sentence. Same schema downstream, so `matchAnalysis` and `inspirationToDesign` need no change.
   The word "json" has to appear for response_format: json_object. */
const PROMPT = (story) => `You are helping a baker turn a customer's words into a cake specification.

The customer said: "${story}"

Propose ONE cake. Reply as json only, in this exact shape:

{
  "cake": { "tier_count": <1-3>, "shape": "<round|square|heart>", "style": "<short phrase>" },
  "tiers": [
    {
      "index": <0-based; 0 = bottom>,
      "frosting": { "type": "<buttercream|fondant|whipped>", "base_color_hex": "<hex>", "color_name": "<name>" },
      "decorations": [
        {
          "type": "<piping_border|rosette|flower|drip|topper|lettering|ribbon_bow|sprinkles|pearls|fruit|macaron|figurine|other>",
          "subtype": "<short, or null>",
          "placement": "<top_surface|side|board|rim>",
          "rim_side": "<top|bottom, only when placement is rim, else null>",
          "color_hex": "<hex>",
          "text": "<for lettering, the exact words, else null>",
          "count": "<a number, or 'continuous', or 'few'>",
          "notes": "<short, optional>"
        }
      ]
    }
  ],
  "palette": [ { "hex": "<hex>", "name": "<name>" } ],
  "confidence": <0.0-1.0>,
  "observations": "<one sentence>"
}

Rules:
- Use ONLY the vocabularies above. If unsure, pick the closest.
- Decorations must be things a baker makes or places: a topper, a piped border, flowers, a drip.
  Never an edible photograph of a real person, and never a licensed cartoon or film character by name.
- If the customer named no subject, choose something plain and say so in observations.
- If what they asked for cannot be baked as described, propose the closest cake that CAN be and say
  what you changed in observations.
- tiers.length must equal cake.tier_count.`;

const SHAPES = ['round', 'square', 'heart'];
const FROSTINGS = ['buttercream', 'fondant', 'whipped'];
const PLACEMENTS = ['top_surface', 'side', 'board', 'rim'];
const HEX = /^#[0-9a-f]{6}$/i;

/** Objective schema check — the faults a cheap model actually makes. */
function validate(a) {
  const bad = [];
  if (!a || typeof a !== 'object') return ['not an object'];
  const n = a.cake?.tier_count;
  if (!Number.isInteger(n) || n < 1 || n > 3) bad.push(`tier_count=${n}`);
  if (!SHAPES.includes(a.cake?.shape)) bad.push(`shape=${a.cake?.shape}`);
  if (!Array.isArray(a.tiers)) return [...bad, 'tiers not an array'];
  if (a.tiers.length !== n) bad.push(`tiers.length=${a.tiers.length} but tier_count=${n}`);
  a.tiers.forEach((t, i) => {
    if (!FROSTINGS.includes(t?.frosting?.type)) bad.push(`tier${i}.frosting.type=${t?.frosting?.type}`);
    if (!HEX.test(t?.frosting?.base_color_hex ?? '')) bad.push(`tier${i}.base_color_hex=${t?.frosting?.base_color_hex}`);
    for (const [j, d] of (t?.decorations ?? []).entries()) {
      if (!PLACEMENTS.includes(d?.placement)) bad.push(`tier${i}.deco${j}.placement=${d?.placement}`);
      if (d?.color_hex && !HEX.test(d.color_hex)) bad.push(`tier${i}.deco${j}.color_hex=${d.color_hex}`);
    }
  });
  return bad;
}

async function callModel(model, story) {
  const body = {
    model,
    messages: [{ role: 'user', content: PROMPT(story) }],
    response_format: { type: 'json_object' },
  };
  /* ⚠️ THE TOKEN CAP IS SPELLED TWO WAYS. Older models take `max_tokens`; the newer families reject
     it and want `max_completion_tokens`. Rather than keep a list of which is which — a list that is
     wrong the week a model ships — ask, and switch on what the API says. */
  let capKey = /^gpt-[56]/.test(model) ? 'max_completion_tokens' : 'max_tokens';
  for (let attempt = 0; attempt < 3; attempt++) {
    const t0 = Date.now();
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, [capKey]: 4000 }),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (res.ok) {
      const data = JSON.parse(text);
      const choice = data.choices?.[0];
      let spec = null, parseError = null;
      try { spec = JSON.parse(choice?.message?.content ?? ''); }
      catch (e) {
        /* ⚠️ AN EMPTY REPLY IS NOT BAD JSON, AND REPORTING IT AS BAD JSON HIDES THE CAUSE. The
           reasoning families spend the completion budget on thinking before they write anything,
           so a cap sized for a non-reasoning model returns `finish_reason: 'length'` with empty
           content — which looks exactly like a model that cannot follow a schema, and is not. */
        parseError = choice?.finish_reason === 'length'
          ? `ran out of completion budget (finish_reason=length, ${data.usage?.completion_tokens ?? '?'} tokens used, nothing returned)`
          : e.message;
      }
      return { ms, usage: data.usage ?? {}, spec, parseError };
    }
    if (/max_tokens/.test(text) && capKey === 'max_tokens') { capKey = 'max_completion_tokens'; continue; }
    if (/max_completion_tokens/.test(text) && capKey === 'max_completion_tokens') { capKey = 'max_tokens'; continue; }
    if (res.status === 429) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    return { ms, error: `${res.status} ${text.slice(0, 160)}` };
  }
  return { error: 'gave up after 3 attempts' };
}

const cost = (model, u) => {
  const p = PRICE[model];
  if (!p || !u?.prompt_tokens) return null;
  return (u.prompt_tokens / 1e6) * p.in + ((u.completion_tokens ?? 0) / 1e6) * p.out;
};

// ── run ─────────────────────────────────────────────────────────────────────────────────────────
const stories = STORIES.slice(0, Number(arg('stories', STORIES.length)));

if (DRY) {
  console.log('── the prompt ' + '─'.repeat(60));
  console.log(PROMPT('<the story goes here>'));
  console.log(`\n── ${stories.length} stories, ${MODELS.length} models = ${stories.length * MODELS.length} calls`);
  for (const s of stories) console.log(`   ${s.id.padEnd(14)} ${s.text.slice(0, 80)}`);
  console.log('\n(nothing was called — drop --dry to run)');
  process.exit(0);
}

const out = [];
for (const model of MODELS) {
  const row = { model, ok: 0, schemaFails: 0, decos: 0, matched: 0, ms: [], usd: 0, errors: [], gaps: new Map() };
  for (const s of stories) {
    const r = await callModel(model, s.text);
    if (r.error || r.parseError) { row.errors.push(`${s.id}: ${r.error ?? r.parseError}`); continue; }
    const bad = validate(r.spec);
    if (bad.length) { row.schemaFails++; row.errors.push(`${s.id}: ${bad.slice(0, 2).join('; ')}`); }
    else row.ok++;
    row.ms.push(r.ms);
    row.usd += cost(model, r.usage) ?? 0;

    /* The number that matters: can our own matcher serve this spec from the real library?
       ⚠️ ASK THE MATCHER, DO NOT COUNT ITS OUTPUT YOURSELF. The first cut of this walked the tiers
       looking for `d.element` — a field that does not exist; the field is `d.match` — and scored a
       flat 0% for every model, including the one the photo path uses in production. An implausible
       result is a bug in the measurement until proven otherwise. `matchAnalysis` already returns
       `coverage: { matched, total, gaps }`, which is the authoritative answer. */
    let matched = 0, total = 0, gaps = [];
    try {
      const m = await matchAnalysis(r.spec);
      ({ matched, total } = m.coverage ?? { matched: 0, total: 0 });
      gaps = (m.coverage?.gaps ?? []).map(g => `${g.type}@${g.placement}`);
    } catch (e) { row.errors.push(`${s.id}: match threw ${e.message}`); }
    row.decos += total; row.matched += matched;
    for (const g of gaps) row.gaps.set(g, (row.gaps.get(g) ?? 0) + 1);
    out.push({ model, story: s.id, spec: r.spec, schema: bad, matched, total, gaps, ms: r.ms, usd: cost(model, r.usage) });
    process.stdout.write('.');
  }
  console.log(` ${model}`);
  row.p50 = row.ms.sort((a, b) => a - b)[Math.floor(row.ms.length / 2)] ?? 0;
  out.push({ summary: row });
}

console.log('\n' + 'model'.padEnd(14) + 'schema ok'.padEnd(12) + 'decos matched'.padEnd(16) + 'p50 ms'.padEnd(10) + 'USD / story');
for (const r of out.filter(o => o.summary).map(o => o.summary)) {
  const rate = r.decos ? `${r.matched}/${r.decos} (${Math.round(100 * r.matched / r.decos)}%)` : '—';
  console.log(
    r.model.padEnd(14) +
    `${r.ok}/${stories.length}`.padEnd(12) +
    rate.padEnd(16) +
    String(r.p50).padEnd(10) +
    (r.usd ? '$' + (r.usd / stories.length).toFixed(5) : '—'));
  for (const e of r.errors.slice(0, 3)) console.log(`      ! ${e}`);
  const top = [...r.gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) console.log(`      library could not serve: ${top.map(([g, n]) => `${g} x${n}`).join(', ')}`);
}

const file = arg('out', null);
if (file) { writeFileSync(file, JSON.stringify(out, null, 2)); console.log(`\nevery spec written to ${file}`); }
