import { supabase } from './supabase.js';
import { getEntitlements } from './entitlements.js';
import { config } from '../config.js';

// ── AI credits: reserve → call → commit / release ────────────────────────────────────
// The metering layer for every action that costs us real money at a provider. Schema +
// the reasoning behind the two-pool model: migrations/022_ai_credits_ledger.sql.
// Pricing model and tier values: docs (spattoo-core) AI_CREDITS_PLAN.md.
//
// The ONLY safe way to spend credits is withAiCredits() at the bottom of this file. Calling
// reserve/commit by hand is possible and is how the wrapper is built, but it puts the
// release-on-failure path in the caller's hands — and a missed release is a baker charged for
// a generation that never arrived, which is the one failure mode this whole design exists to
// prevent. Reach for the wrapper.

// Action keys. These identify an action; they do NOT price it — the price is a row in
// credit_costs (admin-editable data, no deploy). A key missing from that table reserves
// nothing and fails closed with UNKNOWN_ACTION.
export const AI_ACTION = {
  PHOTO_TO_XRAY_ESTIMATE: 'photo_to_xray_estimate',
  PHOTO_TO_CAKE_DESIGN:   'photo_to_cake_design',
  ENQUIRY_TO_DRAFT_ORDER: 'enquiry_to_draft_order',
  STICKER_GENERATE:       'sticker_generate',
  ELEMENT_BUILD_GUIDE:    'element_build_guide',
};

// 402 rather than 403: the baker is authenticated and entitled to the FEATURE, they have just
// run out of the metered resource. The client shows a top-up prompt, not a paywall.
export class InsufficientCreditsError extends Error {
  constructor(detail = {}) {
    super('Not enough AI credits');
    this.name    = 'InsufficientCreditsError';
    this.code    = 'INSUFFICIENT_CREDITS';
    this.status  = 402;
    this.detail  = detail;   // { cost, allowanceLeft, walletBalance }
  }
}

export class UnknownAiActionError extends Error {
  constructor(action) {
    super(`Unknown or inactive AI action: ${action}`);
    this.name   = 'UnknownAiActionError';
    this.code   = 'UNKNOWN_AI_ACTION';
    this.status = 500;       // a code/data mismatch on OUR side, never the caller's fault
  }
}

// supabase-js returns an array for a table-returning function and a scalar for the rest.
const one = (data) => (Array.isArray(data) ? data[0] ?? null : data);

// The baker's monthly allowance, resolved through the ONE entitlement resolver. `null` means
// unlimited (the int convention across the registry); an inactive subscription collapses to
// the registry fallback, which is 0 — so a lapsed baker cannot spend.
async function resolveAllowance(bakerId) {
  const e = await getEntitlements(bakerId);
  const raw = e.ent?.ai_credits_per_month;
  return {
    allowance: raw === null ? null : Number(raw) || 0,
    active: e.active,
    canBuy: e.ent?.can_buy_credits === true,
  };
}

// When the monthly allowance next refreshes: the start of the next calendar month, IST — the same
// boundary the ledger meters on (migrations/022). Returned to the client because the copy that
// matters says a DATE ("they refresh on 1 September"), not "next cycle", which makes someone go
// and check a calendar.
export function nextAllowanceReset() {
  const IST = 5.5 * 3600 * 1000;
  const nowIst = new Date(Date.now() + IST);
  const firstOfNextIst = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth() + 1, 1);
  return new Date(firstOfNextIst - IST).toISOString();
}

// ── The stock ceiling ────────────────────────────────────────────────────────────────────────────
// A baker may hold at most ONE MONTH'S ALLOWANCE in purchased credits, on top of the monthly ones.
//
// Why a ceiling exists at all: credits never expire, so without one a Blaze baker could buy a
// year's worth in an afternoon, downgrade to Flame, and run Blaze-level usage at Flame's price.
// can_buy_credits alone does not stop that — it controls WHO may buy, not HOW MUCH they may
// accumulate before doing something else with their subscription.
//
// Why it is derived from the allowance rather than a number of its own: it self-scales per plan
// (Blaze 800, Forge 2000), there is nothing extra to seed or keep in sync, and it states a clean
// invariant — you can never bank more than about a month ahead. That caps the arbitrage at roughly
// one month of discounted usage, which is not worth anyone's trouble.
//
// The trade we accept: a Blaze baker genuinely preparing for a peak month cannot pre-buy three
// months of credits. Their allowance renews monthly and they can top up again as it drains.
export function creditCeiling(allowance) {
  return allowance === null ? null : allowance;   // null = unlimited plan; nothing to stockpile for
}

// ── Balance ─────────────────────────────────────────────────────────────────────────
// What the balance UI and the pre-flight check read. Both numbers come from the same SQL the
// reserve path uses, so the figure shown to the baker and the figure the gate enforces cannot
// drift apart.
export async function getAiCreditBalance(bakerId) {
  const { allowance, active, canBuy } = await resolveAllowance(bakerId);
  const { data, error } = await supabase.rpc('ai_credit_balance', {
    p_baker_id:  bakerId,
    p_allowance: allowance,
  });
  if (error) throw error;
  const row = one(data) ?? { allowance_used: 0, allowance_left: 0, wallet_balance: 0 };
  return {
    active,
    canBuy,
    resetsOn:      nextAllowanceReset(),
    ceiling:       creditCeiling(allowance),
    unlimited:     allowance === null,
    allowance,
    allowanceUsed: row.allowance_used  ?? 0,
    allowanceLeft: allowance === null ? null : (row.allowance_left ?? 0),
    walletBalance: row.wallet_balance  ?? 0,
    // What the baker can spend right now. Unlimited plans report null rather than a number,
    // so a UI can say "included" instead of inventing a countdown.
    spendable: allowance === null ? null : (row.allowance_left ?? 0) + (row.wallet_balance ?? 0),
  };
}

// The live price list. Read from the DB, never from AI_ACTION — the whole point of credit_costs
// being data is that the number can move without a deploy, and a client that computes "how many
// build guides is my balance worth" must divide by the CURRENT price, not one baked into the
// bundle months ago.
export async function listAiCreditCosts() {
  const { data, error } = await supabase
    .from('credit_costs')
    .select('action_key, credits, label')
    .eq('is_active', true)
    .order('credits', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// ── Top-up packs ────────────────────────────────────────────────────────────────────

// The shelf. Prices come from the DB and never from the client — a checkout that trusts a
// client-sent amount is a free-credits endpoint.
export async function listCreditPacks() {
  const { data, error } = await supabase
    .from('credit_packs')
    .select('pack_key, credits, price_paise, label')
    .eq('is_active', true)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function getCreditPack(packKey) {
  const { data, error } = await supabase
    .from('credit_packs')
    .select('pack_key, credits, price_paise, label')
    .eq('pack_key', packKey)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// Credit a paid pack to the baker's wallet. Call ONLY from the payment webhook, never from a
// client-facing route — the argument that a payment succeeded has to come from Razorpay, not
// from the browser that just clicked pay.
//
// `razorpayPaymentId` is the idempotency key: Razorpay redelivers webhooks, and the unique
// index turns a redelivery into a no-op that returns the original row instead of minting a
// second batch of credits.
export async function creditPurchase({ bakerId, packKey, razorpayPaymentId, note = null }) {
  const { data, error } = await supabase.rpc('purchase_ai_credits', {
    p_baker_id:        bakerId,
    p_pack_key:        packKey,
    p_idempotency_key: razorpayPaymentId,
    p_note:            note,
  });
  if (error) throw error;
  return data ?? null;   // transaction id, or null when the pack key is unknown/inactive
}

// ── Reserve ─────────────────────────────────────────────────────────────────────────
// Holds the credits BEFORE the provider call. Returns { transactionId, cost, replay, ... }.
// Throws InsufficientCreditsError when the baker cannot afford it — that is an expected
// outcome, not an exception in the "something broke" sense, but throwing keeps every caller
// from having to remember to check a flag before spending money.
//
// `idempotencyKey`: pass one whenever the caller can be retried (a queued job, a webhook, a
// button a user can double-click). A replayed key returns the ORIGINAL reservation with
// replay:true and charges nothing further. The caller MUST short-circuit on replay — this
// service cannot return the previous result, only the previous accounting.
export async function reserveCredits({ bakerId, action, orderId = null, idempotencyKey = null, note = null }) {
  const { allowance, canBuy } = await resolveAllowance(bakerId);

  const { data, error } = await supabase.rpc('reserve_ai_credits', {
    p_baker_id:        bakerId,
    p_action_key:      action,
    p_allowance:       allowance,
    p_order_id:        orderId,
    p_idempotency_key: idempotencyKey,
    p_note:            note,
  });
  if (error) throw error;

  const row = one(data);
  if (!row) throw new Error('reserve_ai_credits returned no row');

  if (!row.ok) {
    if (row.reason === 'UNKNOWN_ACTION') throw new UnknownAiActionError(action);
    // Only an actual shortfall may be reported as one. This used to fall through for EVERY
    // ok=false, which is how a released reservation (pre-028: replayed as ok=false) told bakers
    // they were out of credits — an error they could not act on, that topping up did not fix,
    // and that pointed the investigation at the ledger instead of at the replay path. A reason
    // we do not recognise is a bug in the RPC contract, and it should read like one.
    if (row.reason !== 'INSUFFICIENT_CREDITS') {
      throw new Error(`reserve_ai_credits refused '${action}' with unexpected reason: ${row.reason ?? 'null'}`);
    }
    // The client renders a different sentence for a baker who can top up than for one who must
    // wait, so the server — which already knows — says which. Cheaper and more reliable than
    // making the launcher fetch entitlements to find out.
    throw new InsufficientCreditsError({
      cost:          row.cost,
      allowanceLeft: row.from_allowance,
      walletBalance: row.from_wallet,
      canTopUp:      canBuy,
      resetsOn:      nextAllowanceReset(),
    });
  }

  return {
    transactionId: row.transaction_id,
    cost:          row.cost,
    fromAllowance: row.from_allowance,
    fromWallet:    row.from_wallet,
    replay:        row.reason === 'REPLAY',
  };
}

// ── Settle ──────────────────────────────────────────────────────────────────────────

// The result is good and the baker keeps it → the hold becomes a real charge, stamped with
// what it actually cost us. `meter` is what makes the margin dashboard possible; commit still
// succeeds without it, but every field omitted is a blind spot in §2.3's guardrail.
export async function commitCredits(transactionId, meter = {}) {
  const { provider = null, model = null, promptVersion = null } = meter;
  // Cost, in order of how much we trust it: a figure the caller worked out itself, else the sum of
  // the provider calls it reports (`calls`), else a single usage block. Null when none is given —
  // "not measured", never a guess.
  const costInr = meter.providerCostInr
    ?? (meter.calls ? sumOpenAiCostInr(meter.calls) : null)
    ?? (meter.usage ? openAiCostInr({ model, usage: meter.usage }) : null);

  const { data, error } = await supabase.rpc('commit_ai_credits', {
    p_transaction_id:    transactionId,
    p_provider:          provider,
    p_model:             model,
    p_prompt_version:    promptVersion,
    p_provider_cost_inr: costInr,
  });
  if (error) throw error;
  return data === true;
}

// The call failed, or the output failed validation → the hold evaporates and the baker is not
// charged. The row stays as the record of an attempt we paid for; the rate of these IS the
// retry_rate that loads every landed-cost calculation (§2.2), so they are data, not litter.
export async function releaseCredits(transactionId, note = null) {
  const { data, error } = await supabase.rpc('release_ai_credits', {
    p_transaction_id: transactionId,
    p_note:           note,
  });
  if (error) throw error;
  return data === true;
}

// Give back a charge that was already committed — support gesture, or a quality problem found
// after the fact. A separate positive row, never an edit of the original, so the audit trail
// shows both that we charged and that we gave it back.
export async function refundCredits(transactionId, note = null) {
  const { data, error } = await supabase.rpc('refund_ai_credits', {
    p_transaction_id: transactionId,
    p_note:           note,
  });
  if (error) throw error;
  return data ?? null;   // the new transaction id, or null if the row wasn't a committed debit
}

// ── The wrapper every caller should use ─────────────────────────────────────────────
// Reserves, runs, and settles exactly once on every path — including the ones people forget:
// a thrown provider error, a validation failure, a result the caller decides to discard.
//
//   const estimate = await withAiCredits(
//     { bakerId, action: AI_ACTION.PHOTO_TO_XRAY_ESTIMATE, orderId, idempotencyKey: `xray:${orderId}` },
//     async () => {
//       const spec = await analyzeCake(photoUrl);
//       if (!spec?.tiers?.length) return { keep: false };          // released, not charged
//       return { value: spec, provider: 'openai', model: 'gpt-4o', promptVersion: 'xray-v1', usage: spec.usage };
//     },
//   );
//
// `run` returns { value, keep?, provider?, model?, promptVersion?, usage?, providerCostInr? }.
// keep === false releases the hold and resolves to null. Anything thrown releases and rethrows,
// so a provider outage never charges a baker.
//
// On a replayed idempotency key the wrapper does NOT re-run `run` — it resolves to
// { replay: true } and leaves it to the caller to fetch whatever the first attempt stored.
export async function withAiCredits(opts, run) {
  // `free` — run the action WITHOUT metering it. Not a discount and not a bypass: it marks work
  // whose cost is OURS rather than the baker's, and the only case today is generating a guide for
  // a Spattoo library element, which should have shipped with one (see routes/craftGuide.js).
  //
  // Deliberately explicit at the call site rather than inferred here. A wrapper that decided on its
  // own when something was free would be one refactor away from silently un-metering a paid action,
  // which is the failure this whole module exists to prevent.
  //
  // Note what is NOT skipped: `run` still executes and still reports its provider calls, so free
  // work is absent from the ledger but its rupee cost is not invisible — it shows up in the
  // provider invoice either way, and pretending otherwise would flatter the margin numbers.
  if (opts?.free) {
    const out = await run(null);
    return { replay: false, value: out?.keep === false ? null : out?.value ?? null,
             discarded: out?.keep === false, discardedValue: out?.value ?? null, reservation: null };
  }

  const reservation = await reserveCredits(opts);
  if (reservation.replay) return { replay: true, value: null, reservation };

  let out;
  try {
    out = await run(reservation);
  } catch (err) {
    await releaseCredits(reservation.transactionId, `failed: ${String(err?.message ?? err).slice(0, 200)}`)
      .catch(() => {});   // a failed release must not mask the real error; the sweep catches it
    throw err;
  }

  if (!out || out.keep === false) {
    await releaseCredits(reservation.transactionId, out?.note ?? 'discarded').catch(() => {});
    // `value` stays null — it means "what the baker was charged for", and nothing was charged.
    // But a discarded result is not always a failure: "we looked, and this is piped rather than
    // modelled" is a real answer worth showing, just not worth billing. Handing it back under a
    // separate name lets the caller tell those apart, instead of every discard surfacing as
    // "we couldn't read that".
    return { replay: false, value: null, discarded: true, discardedValue: out?.value ?? null, reservation };
  }

  await commitCredits(reservation.transactionId, out);
  return { replay: false, value: out.value, reservation };
}

// ── Provider cost, for the guardrail only ───────────────────────────────────────────
// Converts a call's token usage into the rupee figure stamped on the debit. This is
// REPORTING, not billing: retail price is credits (credit_costs), and nothing here can change
// what a baker pays. A stale number here makes the margin dashboard wrong, not the invoice.
//
// Prices are USD per 1M tokens, and they are in CODE rather than a table on purpose — the
// blast radius of getting one wrong is a mis-drawn chart, and a table would be a second thing
// to keep current for no gain. If this list starts churning monthly, promote it to
// provider_model_prices and read it the way credit_costs is read.
//
// UNVERIFIED against a live invoice — reconcile these against the first real provider bill and
// correct them then (AI_CREDITS_PLAN.md §2.3 says the same about the credit prices).
const USD_PER_MTOK = {
  'gpt-4o':                 { in: 2.50, out: 10.00 },   // what services/openai.js calls today
  'gpt-4o-mini':            { in: 0.15, out:  0.60 },
  'text-embedding-3-small': { in: 0.02, out:  0    },
};

// ── Images are priced PER IMAGE, not per token ──────────────────────────────────────
// USD per generated image, by quality and shape. OpenAI bills images this way, and the token
// path cannot substitute: /v1/images/edits does not reliably return a `usage` block, and
// sumOpenAiCostInr SKIPS anything it cannot price — so an image call recorded nothing at all and
// the ledger reported a guide at ~R1 when the picture alone costs ~R5.5.
//
// That failure is quiet and one-directional: the margin dashboard reads LOW, which is exactly the
// direction that would let something unprofitable ship. Hence a table that needs no cooperation
// from the response.
//
// UNVERIFIED against a live invoice, like USD_PER_MTOK above. Reconcile both against the first
// real bill.
const USD_PER_IMAGE = {
  low:    { square: 0.011, tall: 0.016 },
  medium: { square: 0.042, tall: 0.063 },
  high:   { square: 0.167, tall: 0.250 },
};

// A call is an IMAGE call when it says so — the caller passes { image: { quality, size } } rather
// than a usage block. Returns null for anything it does not recognise, which keeps "not measured"
// distinct from "free".
export function imageCostInr(image) {
  if (!image) return null;
  const byQuality = USD_PER_IMAGE[image.quality] ?? USD_PER_IMAGE.medium;
  // Anything that is not 1024x1024 is one of the two larger shapes, which cost the same as each
  // other — so the only distinction that matters is square vs not.
  const shape = String(image.size ?? '') === '1024x1024' ? 'square' : 'tall';
  return usdToInr((byQuality[shape] ?? byQuality.square) * (Number(image.n) || 1));
}

export function usdToInr(usd) {
  return Math.round((Number(usd) || 0) * (config.aiCredits?.usdInr ?? 90) * 10000) / 10000;
}

// The API answers with a DATED model id — 'gpt-4o-2024-08-06', not 'gpt-4o' — and we deliberately
// record what actually ran rather than what we asked for. So the table is matched by longest
// prefix, or every real call would miss it and silently price at null. Longest wins so that
// 'gpt-4o-mini-…' cannot be swallowed by the 'gpt-4o' row.
function priceFor(model) {
  const id = String(model ?? '');
  let best = null, bestLen = -1;
  for (const key of Object.keys(USD_PER_MTOK)) {
    if (id.startsWith(key) && key.length > bestLen) { best = USD_PER_MTOK[key]; bestLen = key.length; }
  }
  return best;
}

// usage = the provider's own usage block ({ prompt_tokens, completion_tokens }). Returns null
// for an unknown model rather than guessing — a null in the column reads as "not measured",
// where a fabricated number would quietly poison the margin average.
export function openAiCostInr({ model, usage, image }) {
  // An image call prices per image and never per token — see USD_PER_IMAGE.
  if (image) return imageCostInr(image);
  const p = priceFor(model);
  if (!p || !usage) return null;
  const inTok  = Number(usage.prompt_tokens     ?? usage.input_tokens  ?? 0);
  const outTok = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  return usdToInr((inTok / 1e6) * p.in + (outTok / 1e6) * p.out);
}

// One baker action is usually SEVERAL provider calls — a photo→X-Ray estimate is one vision call
// plus an embedding per decoration — and the ledger records one cost per action. Sums what it can
// price and ignores what it cannot.
//
// Returns null only when NOTHING was priceable, so the column keeps meaning "not measured" rather
// than "free". A partial total is still the right number to record: it is the floor on what the
// call cost us, and a floor that trends is worth more than a null that never does.
export function sumOpenAiCostInr(calls) {
  let total = null;
  for (const c of calls ?? []) {
    const v = openAiCostInr(c ?? {});
    if (v != null) total = (total ?? 0) + v;
  }
  return total == null ? null : Math.round(total * 10000) / 10000;
}

// ── Where the credits went ───────────────────────────────────────────────────────────
// The baker's own spend history, for the transparency surface: a dated list of what each action
// cost and WHICH BUCKET it came from.
//
// The split is not derived here and never could be — allowance_credits and wallet_credits are
// written onto each row by reserve_ai_credits at the moment it decides, with a DB constraint that
// they sum to the total. A row that took 10 from the monthly allowance and 5 from the wallet says
// exactly that, which is the whole point: "which credits did that use" is a question with a
// recorded answer, not an inference from balances.
//
// EXCLUDES 'released' rows. A released reservation is an attempt that failed on our side and
// charged nothing (see withAiCredits) — showing it would tell a baker they were billed for
// something they were not, which is worse than showing nothing. They remain in the table as the
// retry_rate signal that loads the margin numbers; they are just not a spend.
//
// Signs are flipped on the way out. In the ledger a debit is negative because it is an accounting
// entry; to a baker "15" is what it cost. The sign convention is ours, not theirs.
export async function listAiCreditHistory(bakerId, { limit = 50, before = null } = {}) {
  let q = supabase
    .from('credit_transactions')
    .select('id, kind, credits, allowance_credits, wallet_credits, created_at, note, credit_costs (label)')
    .eq('baker_id', bakerId)
    .neq('state', 'released')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })          // a tiebreak, so a page boundary is stable
    .limit(Math.min(Number(limit) || 50, 100));
  // Keyset rather than offset: this list only ever grows at the head, and an offset page shifts
  // under the reader every time a credit is spent mid-scroll.
  if (before) q = q.lt('created_at', before);

  const { data, error } = await q;
  if (error) throw error;

  return (data ?? []).map(t => ({
    id:        t.id,
    at:        t.created_at,
    kind:      t.kind,                                    // debit | purchase | grant | refund | adjustment
    // What it was for. A debit has an action; a purchase does not, so it names itself.
    label:     t.credit_costs?.label ?? labelForKind(t.kind, t.note),
    credits:   Math.abs(t.credits),
    // The bucket split, per row. Both can be non-zero on one spend — that is a straddle, and the
    // UI should show it as one, not round it to whichever was larger.
    allowance: Math.abs(t.allowance_credits),
    wallet:    Math.abs(t.wallet_credits),
    spent:     t.kind === 'debit',                        // false = it ADDED credits
  }));
}

// A purchase, grant or adjustment has no action to name it. Kept deliberately plain: this text is
// read months later by someone reconciling, so it should say what happened, not be clever.
function labelForKind(kind, note) {
  if (kind === 'purchase')   return 'Credits purchased';
  if (kind === 'grant')      return 'Monthly credits';
  if (kind === 'refund')     return 'Refunded';
  if (kind === 'adjustment') return note || 'Adjustment';
  return note || 'Credits';
}
