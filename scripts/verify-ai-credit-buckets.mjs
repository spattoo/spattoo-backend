// ── The two buckets, verified against the real ledger ─────────────────────────
// A baker has TWO balances — the monthly allowance that comes with their plan, and the
// never-expiring wallet of credits they bought — and we make specific promises about how those
// interact. Those promises are now in the TERMS (ToS B8.2 and B8.6), not just in UI copy, so they
// have to be true rather than plausible.
//
// The logic lives in PL/pgSQL (reserve_ai_credits, migration 028), so it cannot be checked offline
// the way check:ai-credit-pricing checks the cost table. Reimplementing the split in JS would only
// test the copy. This drives the REAL RPCs against the real database, the same way
// verify-interval-switch.mjs drives the real subscribe handler.
//
// Everything it creates is disposable and torn down in the finally block: one baker, its credit
// transactions, nothing else. It never touches an existing baker.
//
// What is being pinned:
//   1. monthly is spent FIRST, wallet only after it runs out          ToS B8.2
//   2. a spend that STRADDLES the two splits correctly
//   3. a lapsed baker (allowance 0) can still spend their wallet      ToS B8.6
//   4. release restores BOTH buckets exactly                          ToS B8.4
//   5. commit keeps them spent
//   6. the month boundary resets the allowance and NOT the wallet     ToS B8.2 / B8.6
//   7. an unlimited plan never touches the wallet
//   8. buying credits adds to the wallet only, and is idempotent
//
// Run:  node scripts/verify-ai-credit-buckets.mjs
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.log('⚠ SKIPPED — SUPABASE_URL / SUPABASE_SERVICE_KEY not set. Point .env at the DEV project and re-run.');
  process.exit(0);
}
const sb = createClient(url, key);

let ok = 0, bad = 0;
const check = (l, c, x = '') => { console.log(`  ${c ? '✔' : '✘'} ${l}${x ? ' — ' + x : ''}`); c ? ok++ : bad++; };
const one = d => (Array.isArray(d) ? d[0] ?? null : d);

const ACTION = 'photo_to_xray_estimate';   // an ACTIVE action; its cost is read below, never assumed
let bakerId = null;

// Drive the RPCs directly. p_allowance is a PARAMETER of reserve_ai_credits rather than something it
// looks up, which is what makes every case below reachable without inventing plans or subscriptions:
// "lapsed" is allowance 0, "unlimited" is null, "mid-month" is any number.
const reserve = (allowance, idem = null) => sb.rpc('reserve_ai_credits', {
  p_baker_id: bakerId, p_action_key: ACTION, p_allowance: allowance,
  p_order_id: null, p_idempotency_key: idem, p_note: 'bucket verify',
}).then(r => { if (r.error) throw r.error; return one(r.data); });

// commit takes provider/model/prompt_version/cost and NO note; release takes a note and no cost.
// Wrapped once each so a signature change is one edit, not five.
const commit  = id => sb.rpc('commit_ai_credits',  { p_transaction_id: id }).then(r => { if (r.error) throw r.error; });
const release = id => sb.rpc('release_ai_credits', { p_transaction_id: id }).then(r => { if (r.error) throw r.error; });

const balance = (allowance) => sb.rpc('ai_credit_balance', {
  p_baker_id: bakerId, p_allowance: allowance,
}).then(r => { if (r.error) throw r.error; return one(r.data); });

try {
  // ── setup ───────────────────────────────────────────────────────────────────
  const { data: cost } = await sb.from('credit_costs').select('credits').eq('action_key', ACTION).maybeSingle();
  const COST = cost?.credits;
  if (!COST) throw new Error(`action ${ACTION} is not active — pick another`);

  const { data: pack } = await sb.from('credit_packs')
    .select('pack_key, credits').eq('is_active', true).order('credits').limit(1).maybeSingle();
  if (!pack) throw new Error('no active credit pack to buy');

  const slug = 'bucket-verify-' + Date.now().toString(36);
  const { data: baker, error: bErr } = await sb.from('bakers').insert({
    name: 'Bucket Verify Co', slug, email: `${slug}@example.invalid`,
    primary_color: '#1a1a1a', accent_color: '#333333',
    currency_code: 'INR', timezone: 'Asia/Kolkata', is_active: true,
  }).select('id').single();
  if (bErr) throw new Error('baker insert: ' + bErr.message);
  bakerId = baker.id;
  console.log(`\naction ${ACTION} costs ${COST} · pack ${pack.pack_key} = ${pack.credits} credits`);

  // ── 8. buying adds to the WALLET only, and is idempotent ────────────────────
  console.log('\n[8] purchase:');
  const buy = () => sb.rpc('purchase_ai_credits', {
    p_baker_id: bakerId, p_pack_key: pack.pack_key,
    p_idempotency_key: 'pay_bucketverify', p_note: 'verify',
  }).then(r => { if (r.error) throw r.error; return r.data; });
  await buy();
  let b = await balance(100);
  check('wallet credited', b.wallet_balance === pack.credits, `${b.wallet_balance}`);
  check('allowance untouched by a purchase', b.allowance_used === 0, `used ${b.allowance_used}`);
  await buy();                                   // same payment id — a redelivered webhook
  b = await balance(100);
  check('replaying the same payment mints nothing more', b.wallet_balance === pack.credits, `${b.wallet_balance}`);

  const WALLET = pack.credits;
  if (WALLET < COST * 3) throw new Error(`pack too small for the cases below (${WALLET} < ${COST * 3})`);

  // ── 1. monthly first ────────────────────────────────────────────────────────
  // Allowance comfortably covers the cost: the wallet must not be touched at all.
  console.log('\n[1] allowance covers it → wallet untouched:');
  let r = await reserve(COST * 10);
  check('reserved', r.ok === true, r.reason ?? '');
  check('all from allowance', r.from_allowance === COST, `${r.from_allowance}`);
  check('nothing from wallet', r.from_wallet === 0, `${r.from_wallet}`);
  await release(r.transaction_id);

  // ── 2. a spend that straddles both ──────────────────────────────────────────
  // The case the ToS sentence is really about. Allowance left is deliberately SHORT of the cost.
  console.log('\n[2] allowance runs out mid-spend → the remainder comes from the wallet:');
  const SHORT = COST - 1;                        // one credit less than the action needs
  r = await reserve(SHORT);
  check('reserved', r.ok === true, r.reason ?? '');
  check(`allowance drained to the last credit (${SHORT})`, r.from_allowance === SHORT, `${r.from_allowance}`);
  check('remainder from wallet (1)', r.from_wallet === COST - SHORT, `${r.from_wallet}`);

  // ── 4. release restores BOTH buckets ────────────────────────────────────────
  console.log('\n[4] release puts back exactly what it took:');
  const beforeRelease = await balance(SHORT);
  await release(r.transaction_id);
  const afterRelease = await balance(SHORT);
  check('wallet restored', afterRelease.wallet_balance === WALLET,
    `${beforeRelease.wallet_balance} → ${afterRelease.wallet_balance}`);
  check('allowance restored', afterRelease.allowance_used === 0, `used ${afterRelease.allowance_used}`);

  // ── 3. a lapsed baker can still spend the wallet ────────────────────────────
  // allowance 0 is exactly what resolveAllowance() produces for a lapsed subscription. ToS B8.6
  // says the balance is PRESERVED, so the ledger must not refuse it.
  console.log('\n[3] allowance 0 (lapsed) → the wallet still works:');
  r = await reserve(0);
  check('reserved', r.ok === true, r.reason ?? '');
  check('nothing from allowance', r.from_allowance === 0, `${r.from_allowance}`);
  check('all from wallet', r.from_wallet === COST, `${r.from_wallet}`);

  // ── 5. commit keeps it spent ────────────────────────────────────────────────
  console.log('\n[5] commit:');
  await commit(r.transaction_id);
  b = await balance(0);
  check('wallet stays down after commit', b.wallet_balance === WALLET - COST, `${b.wallet_balance}`);

  // ── 6. the month boundary ───────────────────────────────────────────────────
  // The allowance is metered from the start of the current calendar month (IST); the wallet is
  // summed over all time. Backdating the committed row to last month must therefore forget the
  // ALLOWANCE usage and remember the WALLET spend — that asymmetry IS "monthly resets, bought
  // credits never expire".
  console.log('\n[6] month boundary — allowance resets, wallet does not:');
  const spent = await reserve(COST * 10);
  await commit(spent.transaction_id);
  b = await balance(COST * 10);
  check('this month, the allowance spend counts', b.allowance_used === COST, `used ${b.allowance_used}`);

  // 40 days rather than setMonth(-1): the latter overflows on a 31st (31 Mar → 3 Mar) and the
  // test only needs "definitively before the start of this IST month".
  const lastMonth = new Date(Date.now() - 40 * 24 * 3600 * 1000);
  await sb.from('credit_transactions')
    .update({ created_at: lastMonth.toISOString() })
    .in('id', [spent.transaction_id, r.transaction_id]);
  b = await balance(COST * 10);
  check('last month\'s allowance spend is forgotten', b.allowance_used === 0, `used ${b.allowance_used}`);
  check('last month\'s WALLET spend is still gone (no expiry, no reset)',
    b.wallet_balance === WALLET - COST, `${b.wallet_balance}`);

  // ── 7. unlimited never touches the wallet ───────────────────────────────────
  // p_allowance null. The ledger still records the cost (the margin guardrail needs it) but must
  // bill it entirely to the allowance, or an unlimited plan would quietly eat bought credits.
  console.log('\n[7] unlimited plan:');
  r = await reserve(null);
  check('reserved', r.ok === true, r.reason ?? '');
  check('billed entirely to allowance', r.from_allowance === COST, `${r.from_allowance}`);
  check('wallet untouched', r.from_wallet === 0, `${r.from_wallet}`);
  await release(r.transaction_id);

  // ── the refusal ─────────────────────────────────────────────────────────────
  // Drain the wallet, then ask for one more with no allowance. This must be a clean refusal rather
  // than a negative balance — the ledger is the only thing standing between us and giving away
  // provider calls.
  console.log('\n[9] both buckets short → refused, not overdrawn:');
  b = await balance(0);
  let guard = 0;
  while (b.wallet_balance >= COST && guard++ < 200) {
    const t = await reserve(0);
    if (!t.ok) break;
    await commit(t.transaction_id);
    b = await balance(0);
  }
  r = await reserve(0);
  check('refused', r.ok === false, `ok=${r.ok}`);
  check('reason is INSUFFICIENT_CREDITS', r.reason === 'INSUFFICIENT_CREDITS', r.reason ?? '');
  b = await balance(0);
  check('wallet never went negative', b.wallet_balance >= 0, `${b.wallet_balance}`);
} catch (e) {
  console.error('\n✘ threw:', e.message);
  bad++;
} finally {
  // Ordered: transactions reference the baker.
  if (bakerId) {
    await sb.from('credit_transactions').delete().eq('baker_id', bakerId);
    await sb.from('bakers').delete().eq('id', bakerId);
  }
}

console.log(`\n${bad ? '✘' : '✔'} verify:ai-credit-buckets — ${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
