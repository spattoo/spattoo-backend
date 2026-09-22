import { supabase } from './supabase.js';
import { getEntitlements } from './entitlements.js';

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
    .select('id, kind, messages, pack_key, type_slug, channel, recipient, note, created_at')
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

/**
 * The pack behind a key, for the payment row and the invoice line.
 *
 * ⚠️ `activeOnly` IS THE DIFFERENCE BETWEEN SELLING A PACK AND RECORDING ONE. Deciding what may be
 * bought must refuse a retired pack, so checkout takes the default. A webhook must NOT: a pack
 * retired between checkout and capture was still legitimately bought, and filtering it out here
 * silently drops the label and the message count from exactly the historical rows that most need
 * explaining — the payment reads as a bare amount and the invoice names nothing. billing.js's
 * credit-pack branch makes the same argument at length for its own unfiltered lookup.
 */
export async function getMessagePack(packKey, { activeOnly = true } = {}) {
  let q = supabase
    .from('message_packs')
    .select('id, pack_key, messages, price_paise, label')
    .eq('pack_key', packKey);
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`message pack: ${error.message}`);
  return data;
}

/* ── Whose balance pays for a customer notification ──────────────────────────────────────────────
 *
 * ⚠️ NOT `notifications.baker_id` — that is NULL on every customer notification, and deliberately.
 * The bell filters on it (`routes/notifications.js`), so stamping a customer's message with a baker
 * id would drop their customers' notifications into the baker's own notification centre. The column
 * answers "whose bell", not "whose bakery".
 *
 * So it comes from the ORDER, exactly as `customerContact` finds the customer. A customer is scoped
 * to one bakery and an order belongs to exactly one, which is what makes the id sufficient.
 *
 * @returns {Promise<string|null>} null when the payload has no order — nothing to bill to.
 */
export async function payingBakerId(payload) {
  const orderId = payload?.orderId ?? null;
  if (!orderId) return null;
  const { data, error } = await supabase
    .from('orders')
    .select('baker_id')
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw new Error(`paying baker: ${error.message}`);
  return data?.baker_id ?? null;
}

/* ── Notifications that only cost money in one direction ─────────────────────────────────────────
 *
 * `order_placed_customer` fires for BOTH a storefront order and one a baker typed in, and only the
 * second is worth paying for: a customer who placed their own order is looking at a confirmation
 * screen as it sends. A customer whose order the baker wrote down saw nothing and may not know an
 * order exists — for them this is the only notice, and the moment they can give us an email.
 *
 * ⚠️ Stated as data rather than an `if` in the sender (root CLAUDE.md rule 2), and as a PREDICATE
 * rather than a list, because the distinction is inside the payload and not in the slug. `authoredBy`
 * is written by the order route from the signed-in user and never from a request body.
 */
const SPEND_ONLY_WHEN = {
  order_placed_customer: (payload) => payload?.authoredBy === 'baker',
};

/**
 * May this notification spend one of the baker's messages?
 *
 * ⚠️ EVERY ANSWER IS A SKIP, NEVER A FAILURE. A paid channel that cannot send is not an error — the
 * notification still goes by email, which is free and always on. Returning a REASON rather than a
 * boolean is what puts that on the delivery record, so "why did my customer not get a text" has an
 * answer that is not a guess.
 *
 * @returns {Promise<{ ok: true, bakerId: string } | { ok: false, reason: string }>}
 */
export async function maySpendMessage({ typeSlug, payload }) {
  const gate = SPEND_ONLY_WHEN[typeSlug];
  if (gate && !gate(payload)) {
    return { ok: false, reason: 'The customer placed this order themselves, so no paid message' };
  }

  const bakerId = await payingBakerId(payload);
  // No order behind it, so no bakery to bill. Refusing beats sending one nobody paid for.
  if (!bakerId) return { ok: false, reason: 'No order on this notification, so no bakery to bill' };

  const { enabledTypes } = await getMessageSettings(bakerId);
  if (!enabledTypes.includes(typeSlug)) {
    return { ok: false, reason: 'The bakery has not switched this update on' };
  }

  const balance = await getMessageBalance(bakerId);
  if (balance <= 0) return { ok: false, reason: 'The bakery has no messages left' };

  return { ok: true, bakerId };
}

/* ── The first messages are on us, once, and only for a paying bakery ────────────────────────────
 *
 * A baker who has never sent a customer update has no way to judge whether they are worth buying.
 * So the first few are given, at the moment a subscription becomes ACTIVE.
 *
 * ⚠️ HOW MANY IS AN ENTITLEMENT, NOT A NUMBER IN HERE. `welcome_message_credits` falls back to 0, so
 * Spark grants nothing because its plan row says nothing — "we don't spend on trial bakers" is true
 * by DATA, which is why this can be called from every activation path without first asking which
 * tier it is. A plan worth 0 inserts no row and the call costs one entitlements read.
 *
 * ⚠️ AND ONCE IS THE DATABASE'S JOB. The partial unique index from migration 099 makes a second
 * welcome row impossible, so this inserts optimistically and reads a unique violation as "they have
 * already had it". An `if (alreadyGranted)` would lose to a retried webhook, a reactivation, or an
 * upgrade — and every loss is money given away twice.
 *
 * Never throws. A subscription must not fail to activate because a gift did not land; a baker
 * without their welcome credits is a support question, a baker without their subscription is not.
 */
export async function grantWelcomeMessages({ bakerId }) {
  if (!bakerId) return { granted: 0, reason: 'no bakery' };
  try {
    /* ⚠️ THE VALUES ARE UNDER `.ent`, not on the object itself — `getEntitlements` returns
       { planId, plan, status, active, ent, anchor }. Destructuring the key straight off the result
       reads `undefined`, which is falsy, so the grant silently became "this plan includes none" for
       EVERY baker including paying ones. Caught by running it against dev rather than by reading it:
       a paid-tier bakery whose plan row says 25 was refused, and so was ai_credits_per_month, which
       is what named the real cause. */
    const { ent, active } = await getEntitlements(bakerId);
    const amount = ent?.welcome_message_credits;
    // A lapsed or blocked subscription already reads the floor, but saying it plainly keeps the
    // reason on the log useful rather than "this plan includes none" for a plan that includes some.
    if (!active) return { granted: 0, reason: 'No active subscription' };
    if (!(amount > 0)) return { granted: 0, reason: 'This plan includes no welcome messages' };

    const { error } = await supabase.from('message_transactions').insert({
      baker_id: bakerId, kind: 'welcome', messages: amount,
    });
    // 23505 = unique_violation: the index did its job and they already have theirs.
    if (error) {
      if (error.code === '23505') return { granted: 0, reason: 'Already had their welcome messages' };
      console.error('[messages] welcome grant failed', JSON.stringify({ bakerId, error: error.message }));
      return { granted: 0, reason: error.message };
    }
    console.log('[messages] welcome grant', JSON.stringify({ bakerId, messages: amount }));
    return { granted: amount };
  } catch (err) {
    console.error('[messages] welcome grant threw', JSON.stringify({ bakerId, error: err.message }));
    return { granted: 0, reason: err.message };
  }
}

/**
 * Record one message against the baker's balance.
 *
 * ⚠️ CALLED AFTER A SUCCESSFUL SEND, NEVER BEFORE. Debiting first and refunding on failure trades a
 * message given away for a message CHARGED AND NEVER SENT — and only one of those produces a baker
 * who cannot prove they were wronged. A crash between the send and this line costs us one message;
 * the other order costs the baker one, and their trust.
 *
 * Never throws: the message has already gone, and failing the job here would retry a send that
 * already happened. A debit that does not land is logged and lost, which is the cheaper mistake.
 */
export async function spendMessage({ bakerId, typeSlug, channel, recipient }) {
  const { error } = await supabase.from('message_transactions').insert({
    baker_id: bakerId, kind: 'debit', messages: -1,
    type_slug: typeSlug, channel, recipient,
  });
  if (error) {
    console.error('[messages] debit failed after a successful send',
      JSON.stringify({ bakerId, typeSlug, channel, error: error.message }));
  }
}

/**
 * Give a baker message credits, on the house.
 *
 * The third way a balance can go UP, and the only one that is a decision rather than an event: a
 * purchase is the baker paying, a welcome grant is their subscription activating, and this is
 * somebody at Spattoo choosing to. Goodwill after a bad week, a promise made on a support call, a
 * nudge for a baker who has never tried customer updates.
 *
 * ⚠️ UNLIKE THE WELCOME GRANT, THIS IS REPEATABLE AND HAS NO DATABASE GUARD. 099 could make a second
 * welcome impossible with a partial unique index because "once, ever" is a rule about the bakery;
 * "twice in March" is a perfectly good outcome here, so there is nothing for an index to refuse and
 * a double submit really would give twice. What stops that is the caller: the admin form disables
 * while saving and the new balance comes back in the response, so a duplicate is visible in the
 * same breath rather than discovered by a baker with a suspicious number.
 *
 * ⚠️ AND UNLIKE EVERY OTHER WRITE IN THIS FILE, IT THROWS. `spendMessage` swallows its error because
 * the message has already gone and failing would retry a send that happened; `grantWelcomeMessages`
 * swallows its error because a subscription must not fail to activate over a gift. Neither applies
 * to an admin pressing a button and watching for the answer — a grant that silently did not land,
 * reported as success, is a promise made to a baker and not kept.
 *
 * @returns {Promise<{ messages: number, balance: number }>} balance AFTER the grant.
 */
export async function grantComplimentaryMessages({ bakerId, messages, note, grantedBy = null, grantedByEmail = null }) {
  if (!bakerId) { const e = new Error('bakerId is required'); e.status = 400; throw e; }

  // Whole, positive, and bounded. The ceiling is not arithmetic — it is a typo guard, and the typo
  // it guards is a trailing zero on a number nobody is invoiced for and therefore nobody checks.
  const n = Number(messages);
  if (!Number.isInteger(n) || n < 1 || n > 5000) {
    const e = new Error('messages must be a whole number between 1 and 5000');
    e.status = 400;
    throw e;
  }

  // ⚠️ REQUIRED, NOT OPTIONAL. A gift is the one row whose reason is not recoverable from the row:
  // a purchase names its pack and a debit names its recipient, and six weeks later "40 credits,
  // no reason" is unanswerable for the baker who asks and for us. Enforced here rather than only in
  // the form, so a second caller cannot skip it.
  const reason = String(note ?? '').trim();
  if (reason.length < 3) {
    const e = new Error('A reason is required — it is the only record of why these were given');
    e.status = 400;
    throw e;
  }

  const { error } = await supabase.from('message_transactions').insert({
    baker_id: bakerId, kind: 'complimentary', messages: n,
    note: reason.slice(0, 500), granted_by: grantedBy, granted_by_email: grantedByEmail,
  });
  if (error) throw new Error(`complimentary grant: ${error.message}`);

  // Re-read rather than add to a number we were passed: the balance is a SUM (098), and the only
  // honest way to report it is to ask for it. A concurrent debit between the two is exactly the
  // kind of thing the sum is for.
  const balance = await getMessageBalance(bakerId);
  console.log('[messages] complimentary grant',
    JSON.stringify({ bakerId, messages: n, balance, by: grantedByEmail }));
  return { messages: n, balance };
}
