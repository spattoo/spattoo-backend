#!/usr/bin/env node
// ── provider-cost arithmetic gate ─────────────────────────────────────────────
// The figure stamped on every debit as provider_cost_inr. It never affects what a baker pays —
// retail is credits — but it IS the margin guardrail, and a guardrail that quietly reports the
// wrong number is worse than no guardrail, because it gets believed.
//
// Two things here are easy to get wrong and impossible to notice in production:
//   1. The API answers with a DATED model id ('gpt-4o-2024-08-06'). A table keyed on 'gpt-4o'
//      misses every real call and prices them all at null — the guardrail reads "not measured"
//      forever and nobody investigates, because null is also what a genuinely unpriced model
//      looks like.
//   2. Longest-prefix matching. 'gpt-4o-mini-2024-07-18' starts with 'gpt-4o', so a naive
//      first-match would price mini calls at the flagship's rate — 16x too high on input.
//
// Run via `npm run check:ai-credit-pricing` (or the aggregate `npm run check`).

// services/config.js throws on missing required env at import time, and this gate is pure
// arithmetic that touches nothing. Stub what it insists on, import, and compute.
process.env.SUPABASE_URL       ||= 'http://stub';
process.env.SUPABASE_SERVICE_KEY ||= 'stub';
process.env.OPENAI_API_KEY     ||= 'stub';
process.env.REMOVE_BG_API_KEY  ||= 'stub';
process.env.REDIS_URL          ||= 'redis://stub';
process.env.R2_ENDPOINT        ||= 'http://stub';
process.env.R2_ACCESS_KEY_ID   ||= 'stub';
process.env.R2_SECRET_ACCESS_KEY ||= 'stub';
process.env.R2_BUCKET          ||= 'stub';
process.env.R2_PUBLIC_URL      ||= 'http://stub';
process.env.AI_USD_INR         = '90';        // pin the rate so the expected values below are stable

const { openAiCostInr, sumOpenAiCostInr, usdToInr } = await import('../src/services/aiCredits.js');

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) return;
  failures++;
  console.error(`✗ ${label}${extra ? `  — ${extra}` : ''}`);
};
const near = (a, b, tol = 1e-6) => a != null && Math.abs(a - b) < tol;

// ── FX ───────────────────────────────────────────────────────────────────────
ok(near(usdToInr(1), 90), 'usdToInr uses the configured rate');
ok(near(usdToInr(0), 0), 'usdToInr(0) is 0');

// ── The dated-model-id trap ──────────────────────────────────────────────────
// gpt-4o = $2.50/M in, $10/M out. 1000 in + 500 out = $0.0025 + $0.005 = $0.0075 → ₹0.675
const gpt4oUsage = { prompt_tokens: 1000, completion_tokens: 500 };
ok(near(openAiCostInr({ model: 'gpt-4o', usage: gpt4oUsage }), 0.675), 'bare model id prices');
ok(near(openAiCostInr({ model: 'gpt-4o-2024-08-06', usage: gpt4oUsage }), 0.675),
   'DATED model id prices the same — the id the API actually returns');

// ── Longest prefix wins ──────────────────────────────────────────────────────
// gpt-4o-mini = $0.15/M in, $0.60/M out. Same tokens = $0.00015 + $0.0003 = $0.00045 → ₹0.0405
ok(near(openAiCostInr({ model: 'gpt-4o-mini', usage: gpt4oUsage }), 0.0405),
   'gpt-4o-mini prices at the mini rate');
ok(near(openAiCostInr({ model: 'gpt-4o-mini-2024-07-18', usage: gpt4oUsage }), 0.0405),
   'dated mini is NOT swallowed by the gpt-4o prefix', 'this is the 16x-overstatement bug');

// ── Embeddings (input-only) ──────────────────────────────────────────────────
// text-embedding-3-small = $0.02/M in. 10_000 tokens = $0.0002 → ₹0.018
ok(near(openAiCostInr({ model: 'text-embedding-3-small', usage: { prompt_tokens: 10_000 } }), 0.018),
   'embeddings price on input alone');

// ── "Not measured" must stay distinguishable from "free" ─────────────────────
ok(openAiCostInr({ model: 'some-model-we-never-priced', usage: gpt4oUsage }) === null,
   'an unknown model is null, never a guess');
ok(openAiCostInr({ model: 'gpt-4o', usage: null }) === null, 'no usage block is null');
ok(openAiCostInr({}) === null, 'an empty meter is null');

// ── Summing a multi-call action ──────────────────────────────────────────────
// One photo→X-Ray estimate: a vision call + one embedding per decoration.
const action = [
  { model: 'gpt-4o-2024-08-06', usage: gpt4oUsage },
  { model: 'text-embedding-3-small', usage: { prompt_tokens: 10_000 } },
  { model: 'text-embedding-3-small', usage: { prompt_tokens: 10_000 } },
];
ok(near(sumOpenAiCostInr(action), 0.675 + 0.018 + 0.018), 'sums every call in one action');

ok(sumOpenAiCostInr([]) === null, 'no calls at all is null (not measured), not 0 (free)');
ok(sumOpenAiCostInr(null) === null, 'null calls is null');
ok(sumOpenAiCostInr([{ model: 'unknown', usage: gpt4oUsage }]) === null,
   'nothing priceable is null, not 0');
// A partial total is still the right thing to record: it is a floor on what the action cost, and
// a floor that trends beats a null that never does.
ok(near(sumOpenAiCostInr([{ model: 'unknown', usage: gpt4oUsage }, { model: 'gpt-4o', usage: gpt4oUsage }]), 0.675),
   'a partially-priceable action reports what it could price');

if (failures) {
  console.error(`\n${failures} provider-cost check(s) failed. provider_cost_inr would be wrong,`);
  console.error('which makes the margin dashboard wrong in a direction nobody would notice.');
  process.exit(1);
}
console.log('✓ provider cost: dated ids, longest-prefix matching, embeddings and multi-call sums all hold');
