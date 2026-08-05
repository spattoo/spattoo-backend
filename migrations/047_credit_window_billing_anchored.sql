-- ── 047: the credit allowance follows the billing date, not the calendar ────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/features/ai-credits.md — "The allowance is not aligned to the billing date"
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- 022 metered the monthly allowance on the CALENDAR month: everyone refreshed on the 1st,
-- whatever day they subscribed. So the first paid month was not equal —
--
--     subscribes on the 2nd   → one allowance before month two
--     subscribes on the 28th  → TWO, four days apart
--
-- for the same money, with no proration.
--
-- 022's stated reason does not survive contact: it says metering "per billing period"
-- would hand an ANNUAL subscriber 12x the allowance. True, and not the alternative — that
-- is the monthly ANNIVERSARY of the billing date (the 20th of every month, for a baker who
-- joined on the 20th), which behaves identically for monthly and annual plans. The window
-- is always one month long; only its start moves.
--
-- ── WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT ────────────────────────────────────
-- The window start is now PASSED IN, exactly as p_allowance already is, and for the same
-- reason 022 gives for that: resolving it involves the subscription record, and a second
-- source of truth in SQL would silently disagree with the middleware and the client.
--
-- Everything else about the meter is untouched, and that is the point:
--   * still DERIVED — allowance_used = sum of debits since the window start. No grant rows,
--     no monthly job to run twice, no expiry sweep, recomputable from the ledger alone.
--   * a plan change still takes effect immediately with no back-fill: the allowance moves,
--     the window does not, and used-so-far is measured within it.
--   * boundaries are still IST.
--
-- ── THE TRIAL HALVES UNLESS SPARK IS RAISED ─────────────────────────────────────────
-- A 30-day trial nearly always straddles a month boundary, so under the calendar meter it
-- collected TWO allowances — Spark's 100 was chosen knowing it is worth up to ~200 in
-- practice. Anchored to the trial's start date, a 30-day trial fits inside ONE window and
-- collects one. Spark therefore moves 100 → 200 in the same change (see the seed), or the
-- trial silently halves.
--
-- It also becomes EVEN. Under the calendar the trial was worth between 100 and 200
-- depending on the day somebody signed up — a trial starting on the 1st never reached the
-- second allowance at all. 200 now means 200 for everyone.
--
-- ── NULL WINDOW START ───────────────────────────────────────────────────────────────
-- Falls back to the calendar month, so a baker with no resolvable anchor (no subscription
-- row at all) behaves exactly as before rather than erroring. Such a baker is blocked by
-- BLOCKED_STATUSES and has an allowance of 0 anyway, so the fallback is unreachable in
-- practice — it exists so a bug upstream cannot take the meter down.

BEGIN;

-- ── The reserve path ─────────────────────────────────────────────────────────────────
create or replace function reserve_ai_credits(
  p_baker_id        uuid,
  p_action_key      text,
  p_allowance       integer,                 -- resolved ai_credits_per_month; null = unlimited
  p_order_id        uuid    default null,
  p_idempotency_key text    default null,
  p_note            text    default null,
  -- NEW, last and defaulted so an un-upgraded caller keeps working through a rolling deploy.
  p_window_start    timestamptz default null
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
  v_window_start timestamptz;
  v_used        integer;
  v_wallet      integer;
  v_left        integer;
  v_take_allow  integer;
  v_take_wallet integer;
  v_id          bigint;
  v_prev        credit_transactions%rowtype;
begin
  -- Replay of an already-accepted request → return the original decision, charge nothing more.
  if p_idempotency_key is not null then
    select * into v_prev from credit_transactions t where t.idempotency_key = p_idempotency_key;
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

  -- The baker's OWN allowance window, resolved from their billing anchor and passed in — the
  -- same treatment p_allowance gets, for the same reason (022's note above this function).
  -- The calendar month is the fallback ONLY when no anchor was resolvable; such a baker has no
  -- subscription row, is blocked by BLOCKED_STATUSES, and has an allowance of 0 anyway. It
  -- exists so a bug upstream cannot take the meter down.
  v_window_start := coalesce(
    p_window_start,
    date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
  );

  select coalesce(-sum(t.allowance_credits), 0) into v_used
    from credit_transactions t
   where t.baker_id = p_baker_id and t.state <> 'released' and t.created_at >= v_window_start;

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

-- ── The read path ────────────────────────────────────────────────────────────────────
create or replace function ai_credit_balance(
  p_baker_id uuid, p_allowance integer, p_window_start timestamptz default null)
returns table (allowance_used integer, allowance_left integer, wallet_balance integer)
language sql
stable
as $$
  with bounds as (
    select coalesce(
             p_window_start,
             date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata'
           ) as month_start
  ),
  used as (
    select coalesce(-sum(t.allowance_credits), 0)::integer as v
      from credit_transactions t, bounds b
     where t.baker_id = p_baker_id and t.state <> 'released' and t.created_at >= b.month_start
  ),
  wallet as (
    select coalesce(sum(t.wallet_credits), 0)::integer as v
      from credit_transactions t
     where t.baker_id = p_baker_id and t.state <> 'released'
  )
  select used.v,
         case when p_allowance is null then null::integer else greatest(p_allowance - used.v, 0) end,
         wallet.v
    from used, wallet;
$$;

COMMIT;
