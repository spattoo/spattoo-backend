-- ── 028: a released reservation must not brick its idempotency key ──────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHAT WAS BROKEN ─────────────────────────────────────────────────────────────────
-- One failed generation permanently locked an element (or an order) out of ever being
-- generated again, and reported it as "You've used this month's credits".
--
-- The routes key their reservations on the THING, not the attempt — `build-guide:<element_id>`,
-- `xray-estimate:<order_id>` — which is right: it is what stops a double-click paying for two
-- OpenAI calls. But reserve_ai_credits replayed on ANY prior row with that key:
--
--     select * into v_prev from credit_transactions t where t.idempotency_key = p_idempotency_key;
--     if found then
--       return query select v_prev.id, (v_prev.state <> 'released'), 'REPLAY'::text, ...
--
-- For a RELEASED row that yields ok = false, and services/aiCredits.js maps every ok = false
-- to InsufficientCreditsError. So the sequence was: generation fails → hold released (correct,
-- nobody charged) → every retry forever after replays the released row → ok = false → the
-- baker is told they are out of credits. Topping up does not help, because the wallet is
-- never consulted on the replay path.
--
-- ── THE RULE ────────────────────────────────────────────────────────────────────────
-- Idempotency exists to stop us charging TWICE for one outcome. A released reservation has no
-- outcome and no charge — we tried, it failed, the baker paid nothing. It is a record of an
-- attempt, not a result, and it must not stand in the way of trying again.
--
-- So: released rows keep their key for the audit trail, but stop competing for it.

-- ── 1. The unique index goes partial ────────────────────────────────────────────────
-- Without this the fix below cannot work: the lookup would ignore the released row and then
-- the INSERT would hit the unique violation instead.
--
-- Retains full force where it matters — a 'reserved' or 'committed' row still owns its key, so
-- a redelivered Razorpay webhook still cannot mint credits twice (a purchase is inserted
-- 'committed' and never released, so purchase_ai_credits' unique_violation dedupe is unaffected).
drop index if exists credit_transactions_idempotency_idx;
create unique index if not exists credit_transactions_idempotency_idx
  on credit_transactions (idempotency_key)
  where idempotency_key is not null and state <> 'released';

comment on index credit_transactions_idempotency_idx is
  'Partial on state <> released: a released reservation is an ATTEMPT, not a result. It keeps its key for the audit trail but stops owning it, so the same element/order can be generated again after a failure. Reserved and committed rows still own their key — that is what stops a redelivered webhook double-crediting.';

-- ── 2. The replay lookup ignores released rows ──────────────────────────────────────
-- Only the `select ... into v_prev` line changes; everything else is 022 verbatim.
create or replace function reserve_ai_credits(
  p_baker_id        uuid,
  p_action_key      text,
  p_allowance       integer,                 -- resolved ai_credits_per_month; null = unlimited
  p_order_id        uuid    default null,
  p_idempotency_key text    default null,
  p_note            text    default null
)
returns table (
  transaction_id bigint,
  ok             boolean,
  reason         text,
  cost           integer,
  from_allowance integer,
  from_wallet    integer
)
language plpgsql
as $$
declare
  v_cost        integer;
  v_action_id   smallint;
  v_month_start timestamptz;
  v_used        integer;
  v_wallet      integer;
  v_left        integer;
  v_take_allow  integer;
  v_take_wallet integer;
  v_id          bigint;
  v_prev        credit_transactions%rowtype;
begin
  -- Replay of an already-accepted request → return the original decision, charge nothing more.
  -- `state <> 'released'` is the 028 fix: a released row is a failed attempt that charged
  -- nothing, so it is not a decision to replay. Without it, one failure locked the key forever
  -- and every retry was reported to the baker as "out of credits".
  if p_idempotency_key is not null then
    select * into v_prev from credit_transactions t
     where t.idempotency_key = p_idempotency_key and t.state <> 'released';
    if found then
      return query select v_prev.id, (v_prev.state <> 'released'), 'REPLAY'::text,
                          -v_prev.credits, -v_prev.allowance_credits, -v_prev.wallet_credits;
      return;
    end if;
  end if;

  select c.id, c.credits into v_action_id, v_cost from credit_costs c
   where c.action_key = p_action_key and c.is_active;
  if v_cost is null then
    return query select null::bigint, false, 'UNKNOWN_ACTION'::text, 0, 0, 0;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_baker_id::text, 0));

  -- Start of the current calendar month, in IST, as an absolute instant.
  v_month_start := date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';

  select coalesce(-sum(t.allowance_credits), 0) into v_used
    from credit_transactions t
   where t.baker_id = p_baker_id and t.state <> 'released' and t.created_at >= v_month_start;

  select coalesce(sum(t.wallet_credits), 0) into v_wallet
    from credit_transactions t
   where t.baker_id = p_baker_id and t.state <> 'released';

  if p_allowance is null then
    -- Unlimited plan: bill the whole cost to the allowance so the wallet is untouched and the
    -- ledger still records what the action cost us (the margin guardrail needs that either way).
    v_take_allow  := v_cost;
    v_take_wallet := 0;
  else
    v_left        := greatest(p_allowance - v_used, 0);
    v_take_allow  := least(v_left, v_cost);
    v_take_wallet := v_cost - v_take_allow;
    if v_take_wallet > v_wallet then
      return query select null::bigint, false, 'INSUFFICIENT_CREDITS'::text, v_cost, v_left, v_wallet;
      return;
    end if;
  end if;

  insert into credit_transactions
    (baker_id, kind, state, action_id, credits, allowance_credits, wallet_credits,
     order_id, idempotency_key, note)
  values
    (p_baker_id, 'debit', 'reserved', v_action_id, -v_cost, -v_take_allow, -v_take_wallet,
     p_order_id, p_idempotency_key, p_note)
  returning id into v_id;

  return query select v_id, true, null::text, v_cost, v_take_allow, v_take_wallet;
end;
$$;
