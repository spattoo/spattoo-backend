import { supabase } from './supabase.js';

// ── A baker's paid-message balance, settings and history ─────────────────────────────────────────
//
// Paid customer updates (SMS/WhatsApp) are optional and bought in packs; email and push stay free.
// See plans/message-recharge.md for why this is opt-in rather than a pass-through.

/* ⚠️ THE DEFAULT IS IN THE DATABASE (`baker_message_settings.enabled_types`), and this mirrors it for
   the baker who has no row yet. Two statements of a default can disagree, so this one exists only to
   answer "what would they get if they saved nothing", and any change belongs in BOTH — which is what
   the test asserts. The two that stall an order if unseen: a quote nobody sees is an order that dies,
   a cake nobody collects sits on a shelf. */
export const DEFAULT_ENABLED_TYPES = ['quote_issued_customer', 'order_ready_customer'];

/** Balance = SUM of the ledger, never a stored column. @returns {Promise<number>} */
export async function getMessageBalance(bakerId) {
  const { data, error } = await supabase
    .from('message_transactions')
    .select('messages')
    .eq('baker_id', bakerId);
  if (error) throw new Error(`message balance: ${error.message}`);
  return (data ?? []).reduce((n, r) => n + (r.messages ?? 0), 0);
}

/** The baker's choices, falling back to the default when they have never saved. */
export async function getMessageSettings(bakerId) {
  const { data, error } = await supabase
    .from('baker_message_settings')
    .select('enabled_types, updated_at')
    .eq('baker_id', bakerId)
    .maybeSingle();
  if (error) throw new Error(`message settings: ${error.message}`);
  return {
    enabledTypes: data?.enabled_types ?? DEFAULT_ENABLED_TYPES,
    // null means "never touched it", which the UI says out loud rather than implying a choice.
    updatedAt:    data?.updated_at ?? null,
  };
}

/**
 * Save the baker's choices.
 *
 * ⚠️ Slugs are checked against notification_types rather than trusted. An unknown slug would sit in
 * the array looking enabled and silently never match anything at send time — a setting that appears
 * to work and does nothing is worse than one that is refused.
 */
export async function setMessageSettings(bakerId, enabledTypes) {
  const wanted = [...new Set((enabledTypes ?? []).map(String))];

  const { data: known, error: kErr } = await supabase
    .from('notification_types')
    .select('slug')
    .eq('audience', 'customer');
  if (kErr) throw new Error(`message settings: ${kErr.message}`);

  const valid = new Set((known ?? []).map(r => r.slug));
  const unknown = wanted.filter(s => !valid.has(s));
  if (unknown.length) {
    const err = new Error(`Not a customer notification: ${unknown.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const { error } = await supabase
    .from('baker_message_settings')
    .upsert({ baker_id: bakerId, enabled_types: wanted, updated_at: new Date().toISOString() },
            { onConflict: 'baker_id' });
  if (error) throw new Error(`message settings: ${error.message}`);
  return { enabledTypes: wanted };
}

/** What a recharge can buy. Admin-authored (CLAUDE.md rule 3), so never a constant in here. */
export async function listMessagePacks() {
  const { data, error } = await supabase
    .from('message_packs')
    .select('pack_key, messages, price_paise, label')
    .eq('is_active', true)
    .order('sort_order');
  if (error) throw new Error(`message packs: ${error.message}`);
  return (data ?? []).map(p => ({
    packKey: p.pack_key, messages: p.messages, basePaise: p.price_paise, label: p.label,
  }));
}

/**
 * Where the messages went. Newest first, paged by `before` (an ISO instant).
 *
 * ⚠️ Fetches `limit + 1` so the caller can say whether there is more WITHOUT a second count query —
 * a count over a growing ledger is the query that gets slow first.
 *
 * ⚠️ KNOWN: THE CURSOR IS `created_at` ALONE, SO ROWS SHARING AN INSTANT CAN BE SKIPPED. `now()` in
 * Postgres is TRANSACTION time, so several rows written in one statement get an identical timestamp —
 * and `.lt(created_at, before)` then steps over the whole tie, not past one row of it. Observed while
 * testing 098: three probe rows inserted together all shared a microsecond.
 *
 * It does not bite today. Each debit is its own write, so production ties need two sends in the same
 * microsecond. It WILL bite the first time something writes a batch — a digest spending several
 * messages at once, or a bulk adjustment — and the symptom is a "load more" that quietly omits rows
 * rather than anything failing.
 *
 * The fix is a composite cursor, `(created_at, id)`:
 *   .or(`created_at.lt.${ts},and(created_at.eq.${ts},id.lt.${id})`)
 * Left undone deliberately: the ledger view is not built yet, and a cursor format is worth choosing
 * once, with the screen that pages it, rather than twice.
 */
export async function listMessageHistory(bakerId, { limit = 25, before = null } = {}) {
  let q = supabase
    .from('message_transactions')
    .select('id, kind, messages, pack_key, type_slug, channel, recipient, created_at')
    .eq('baker_id', bakerId)
    .order('created_at', { ascending: false })
    .limit(limit + 1);
  if (before) q = q.lt('created_at', before);

  const { data, error } = await q;
  if (error) throw new Error(`message history: ${error.message}`);

  const rows = data ?? [];
  const more = rows.length > limit;
  return { rows: rows.slice(0, limit), hasMore: more };
}

/**
 * How many messages went out over the last N days, for "you sent 42 this week".
 *
 * ⚠️ Counts DEBITS only, and returns a positive number. Summing every row would net purchases against
 * sends and answer a different question entirely — one that reads as "you sent -158 messages" the day
 * after a recharge.
 */
export async function countMessagesSent(bakerId, sinceIso) {
  const { data, error } = await supabase
    .from('message_transactions')
    .select('messages')
    .eq('baker_id', bakerId)
    .eq('kind', 'debit')
    .gte('created_at', sinceIso);
  if (error) throw new Error(`message usage: ${error.message}`);
  return Math.abs((data ?? []).reduce((n, r) => n + (r.messages ?? 0), 0));
}

/**
 * Mint a purchased pack into the ledger. Called ONLY by the payment webhook, never by the checkout
 * route — an abandoned Checkout must cost nothing and credit nothing.
 *
 * ⚠️ IDEMPOTENT ON THE RAZORPAY PAYMENT ID. Razorpay redelivers webhooks, and without this a second
 * delivery mints a second pack: the baker pays once and gets 450 messages, and nothing anywhere
 * looks wrong. The unique partial index on `payment_id` (098) is the guard; 23505 means the first
 * delivery already did the work, which is success, not failure.
 *
 * @returns {Promise<string|null>} the transaction id, or null when already minted or the pack is gone
 */
export async function purchaseMessages({ bakerId, packKey, paymentId }) {
  const { data: pack, error: pErr } = await supabase
    .from('message_packs')
    .select('id, pack_key, messages, price_paise, label')
    .eq('pack_key', packKey)
    .maybeSingle();
  if (pErr) throw new Error(`message pack: ${pErr.message}`);
  /* A retired or renamed pack. Loud, because the alternative is a baker who paid and got nothing
     while the webhook reports success — the caller logs and does not send a receipt. */
  if (!pack) return null;

  const { data, error } = await supabase
    .from('message_transactions')
    .insert({ baker_id: bakerId, kind: 'purchase', messages: pack.messages,
              pack_key: pack.pack_key, payment_id: paymentId })
    .select('id')
    .single();

  if (error?.code === '23505') return null;   // already minted by an earlier delivery
  if (error) throw new Error(`message purchase: ${error.message}`);
  return data.id;
}

/** The pack behind a key, for the payment row and the invoice line. */
export async function getMessagePack(packKey) {
  const { data, error } = await supabase
    .from('message_packs')
    .select('id, pack_key, messages, price_paise, label')
    .eq('pack_key', packKey)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw new Error(`message pack: ${error.message}`);
  return data;
}
