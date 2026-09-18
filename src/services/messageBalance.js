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
