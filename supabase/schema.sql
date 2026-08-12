-- ─────────────────────────────────────────────────────────────────────────────
-- spattoo — schema baseline.  GENERATED FILE — do not hand-edit.
--
-- Regenerate:  node scripts/dump-schema.mjs
-- Verify:      node scripts/dump-schema.mjs --check
--
-- This is a SNAPSHOT of the live schema, not a migration. Schema changes still ship as
-- numbered files in migrations/; this captures the result so a fresh environment can be
-- built from today rather than replayed from 007 (which is impossible — the tables the
-- first six migrations made were never captured in this repo).
--
-- Captured with: pg_dump (PostgreSQL) 18.4 (Postgres.app)
-- ─────────────────────────────────────────────────────────────────────────────
-- ══ PREAMBLE — added by scripts/dump-schema.mjs, NOT from pg_dump ───────────────────────────────
--
-- Supabase keeps extensions in the `extensions` schema, which a --schema=public dump does
-- not visit. Without these the restore fails on the first vector column.
--
-- The SUPPORTED route is the dashboard (Database → Extensions) — enable them there BEFORE
-- running this file. These statements are the belt-and-braces: no-ops if already enabled,
-- and pg_cron in particular may need to be enabled from the dashboard regardless.

create extension if not exists vector;
create extension if not exists pg_cron;

-- ══ pg_dump output begins ───────────────────────────────────────────────────────────────────────
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4 (Postgres.app)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: baker_contact_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.baker_contact_role AS ENUM (
    'owner',
    'manager',
    'ops',
    'delivery',
    'other'
);


--
-- Name: notification_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_status AS ENUM (
    'pending',
    'enqueued',
    'sent',
    'failed'
);


--
-- Name: ai_credit_balance(uuid, integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ai_credit_balance(p_baker_id uuid, p_allowance integer, p_window_start timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(allowance_used integer, allowance_left integer, wallet_balance integer)
    LANGUAGE sql STABLE
    AS $$
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


--
-- Name: commit_ai_credits(bigint, text, text, text, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.commit_ai_credits(p_transaction_id bigint, p_provider text DEFAULT NULL::text, p_model text DEFAULT NULL::text, p_prompt_version text DEFAULT NULL::text, p_provider_cost_inr numeric DEFAULT NULL::numeric) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
declare v_state text;
begin
  select state into v_state from credit_transactions where id = p_transaction_id;
  if v_state is null then return false; end if;
  if v_state = 'committed' then return true; end if;   -- replay
  if v_state = 'released'  then return false; end if;  -- a released reservation cannot be revived

  update credit_transactions
     set state             = 'committed',
         settled_at        = now(),
         provider          = coalesce(p_provider,          provider),
         model             = coalesce(p_model,             model),
         prompt_version    = coalesce(p_prompt_version,    prompt_version),
         provider_cost_inr = coalesce(p_provider_cost_inr, provider_cost_inr)
   where id = p_transaction_id;
  return true;
end;
$$;


--
-- Name: get_baker_subscription(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_baker_subscription(p_baker_id uuid) RETURNS TABLE(id uuid, plan_id integer, plan_name text, plan_display_name text, period_name text, period_display_name text, status text, derived_status text, start_date date, end_date date, cancel_at_period_end boolean, current_period_start timestamp with time zone, current_period_end timestamp with time zone, cancellation_requested_at timestamp with time zone, cancellation_reason text, cancellation_note text, scheduled_plan_id integer, scheduled_plan_name text, scheduled_effective_at timestamp with time zone, scheduled_period_name text, scheduled_period_display_name text)
    LANGUAGE sql STABLE
    AS $$
  SELECT
    bs.id,
    sp.id           AS plan_id,
    sp.name         AS plan_name,
    sp.display_name AS plan_display_name,
    bp.name         AS period_name,
    bp.display_name AS period_display_name,
    CASE bs.status_id
      WHEN 1 THEN 'active'
      WHEN 2 THEN 'pending'
      WHEN 3 THEN 'paused'
      WHEN 4 THEN 'past_due'
      WHEN 5 THEN 'expired'
      WHEN 6 THEN 'cancelled'
      ELSE 'unknown'
    END             AS status,
    CASE
      WHEN bs.status_id = 1 AND (
        CASE
          WHEN bs.current_period_end IS NOT NULL THEN now() >= bs.current_period_end
          ELSE bs.end_date IS NOT NULL AND bs.end_date < CURRENT_DATE
        END
      ) THEN 'expired'
      WHEN bs.status_id = 1 THEN 'active'
      WHEN bs.status_id = 2 THEN 'pending'
      WHEN bs.status_id = 3 THEN 'paused'
      WHEN bs.status_id = 4 THEN 'past_due'
      WHEN bs.status_id = 5 THEN 'expired'   -- halted/dunning-exhausted; was missing → 'unknown' → access NOT blocked
      WHEN bs.status_id = 6 THEN 'cancelled'
      ELSE 'unknown'
    END             AS derived_status,
    bs.start_date,
    bs.end_date,
    bs.cancel_at_period_end,
    bs.current_period_start,
    bs.current_period_end,
    bs.cancellation_requested_at,
    cr.key          AS cancellation_reason,
    bs.cancellation_note,
    bs.scheduled_plan_id,
    ssp.name        AS scheduled_plan_name,
    bs.scheduled_effective_at,
    sbp.name         AS scheduled_period_name,
    sbp.display_name AS scheduled_period_display_name
  FROM baker_subscriptions bs
  LEFT JOIN subscription_plans   sp  ON sp.id  = bs.plan_id
  LEFT JOIN subscription_plans   ssp ON ssp.id = bs.scheduled_plan_id
  LEFT JOIN billing_periods      bp  ON bp.id  = bs.billing_period_id
  LEFT JOIN cancellation_reasons cr  ON cr.id  = bs.cancellation_reason_id
  -- The parked (scheduled) sub — its billing period is the target of an interval switch.
  LEFT JOIN baker_subscriptions  ss  ON ss.billing_subscription_id = bs.scheduled_subscription_id
  LEFT JOIN billing_periods      sbp ON sbp.id = ss.billing_period_id
  WHERE bs.baker_id = p_baker_id
  ORDER BY (bs.status_id = 1) DESC,   -- the ACTIVE row wins over a newer PENDING parked (downgrade) row
           bs.created_at DESC
  LIMIT 1;
$$;


--
-- Name: get_baker_subscriptions_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_baker_subscriptions_admin() RETURNS TABLE(baker_id uuid, baker_name text, plan_name text, period_name text, status text, derived_status text, end_date date, start_date date, current_period_end timestamp with time zone, cancel_at_period_end boolean, cancellation_requested_at timestamp with time zone, cancellation_reason text, cancellation_note text)
    LANGUAGE sql STABLE
    AS $$
  SELECT DISTINCT ON (b.id)
    b.id            AS baker_id,
    b.name          AS baker_name,
    sp.name         AS plan_name,
    bp.name         AS period_name,
    CASE bs.status_id
      WHEN 1 THEN 'active'
      WHEN 2 THEN 'pending'
      WHEN 3 THEN 'paused'
      WHEN 4 THEN 'past_due'
      WHEN 5 THEN 'expired'
      WHEN 6 THEN 'cancelled'
      ELSE 'unknown'
    END             AS status,
    CASE
      WHEN bs.status_id = 1 AND (
        CASE
          WHEN bs.current_period_end IS NOT NULL THEN now() >= bs.current_period_end
          ELSE bs.end_date IS NOT NULL AND bs.end_date < CURRENT_DATE
        END
      ) THEN 'expired'
      WHEN bs.status_id = 1 THEN 'active'
      WHEN bs.status_id = 2 THEN 'pending'
      WHEN bs.status_id = 3 THEN 'paused'
      WHEN bs.status_id = 4 THEN 'past_due'
      WHEN bs.status_id = 6 THEN 'cancelled'
      ELSE 'unknown'
    END             AS derived_status,
    bs.end_date,
    bs.start_date,
    bs.current_period_end,
    bs.cancel_at_period_end,
    bs.cancellation_requested_at,
    cr.key          AS cancellation_reason,
    bs.cancellation_note
  FROM bakers b
  LEFT JOIN baker_subscriptions  bs ON bs.baker_id = b.id
  LEFT JOIN subscription_plans   sp ON sp.id = bs.plan_id
  LEFT JOIN billing_periods      bp ON bp.id = bs.billing_period_id
  LEFT JOIN cancellation_reasons cr ON cr.id = bs.cancellation_reason_id
  ORDER BY b.id, bs.created_at DESC;
$$;


--
-- Name: handle_new_baker_contact(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_baker_contact() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$                                                         
  BEGIN
    IF new.raw_user_meta_data->>'baker_id' IS NOT NULL THEN                     
      INSERT INTO public.baker_contacts (auth_user_id, baker_id, name, email,
  role, is_primary)                                                             
      VALUES (
        new.id,                                                                 
        (new.raw_user_meta_data->>'baker_id')::uuid,
        COALESCE(new.raw_user_meta_data->>'full_name', ''),
        new.email,                                                              
        COALESCE(new.raw_user_meta_data->>'role', 'staff')::baker_contact_role,
        COALESCE((new.raw_user_meta_data->>'is_primary')::boolean, false)       
      );                                  
    END IF;                                                                     
    RETURN new;                           
  END;
  $$;


--
-- Name: orders_calendar_counts(uuid, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.orders_calendar_counts(p_baker_id uuid, p_from date, p_to date) RETURNS TABLE(delivery_date date, status_id smallint, order_count bigint)
    LANGUAGE sql STABLE
    AS $$
  SELECT o.delivery_date, o.status_id, count(*) AS order_count
  FROM orders o
  WHERE o.baker_id = p_baker_id
    AND o.delivery_date >= p_from
    AND o.delivery_date <= p_to
  GROUP BY o.delivery_date, o.status_id
$$;


--
-- Name: purchase_ai_credits(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purchase_ai_credits(p_baker_id uuid, p_pack_key text, p_idempotency_key text, p_note text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
declare
  v_pack_id smallint;
  v_credits integer;
  v_id      bigint;
begin
  select p.id, p.credits into v_pack_id, v_credits
    from credit_packs p where p.pack_key = p_pack_key and p.is_active;
  if v_pack_id is null then return null; end if;

  begin
    insert into credit_transactions
      (baker_id, kind, state, pack_id, credits, allowance_credits, wallet_credits,
       idempotency_key, note, settled_at)
    values
      (p_baker_id, 'purchase', 'committed', v_pack_id, v_credits, 0, v_credits,
       p_idempotency_key, p_note, now())
    returning id into v_id;
  exception when unique_violation then
    -- A redelivered webhook. The first one already credited the baker; hand back its row.
    select t.id into v_id from credit_transactions t where t.idempotency_key = p_idempotency_key;
  end;

  return v_id;
end;
$$;


--
-- Name: purge_old_notifications(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.purge_old_notifications(retain_days integer DEFAULT 90) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE deleted int;
BEGIN
  DELETE FROM notifications
   WHERE status = 'sent'
     AND COALESCE(sent_at, created_at) < now() - make_interval(days => retain_days)
     AND (
       read_at IS NOT NULL
       OR COALESCE(sent_at, created_at) < now() - interval '365 days'
     );
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END $$;


--
-- Name: refund_ai_credits(bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refund_ai_credits(p_transaction_id bigint, p_note text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql
    AS $$
declare
  v_row credit_transactions%rowtype;
  v_id  bigint;
begin
  select * into v_row from credit_transactions where id = p_transaction_id;
  if not found or v_row.kind <> 'debit' or v_row.state <> 'committed' then return null; end if;

  insert into credit_transactions
    (baker_id, kind, state, action_id, credits, allowance_credits, wallet_credits,
     order_id, note, settled_at)
  values
    (v_row.baker_id, 'refund', 'committed', v_row.action_id,
     -v_row.credits, -v_row.allowance_credits, -v_row.wallet_credits,
     v_row.order_id, coalesce(p_note, 'refund of #' || v_row.id), now())
  returning id into v_id;
  return v_id;
end;
$$;


--
-- Name: release_ai_credits(bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_ai_credits(p_transaction_id bigint, p_note text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
declare
  v_state text;
begin
  select state into v_state from credit_transactions where id = p_transaction_id;
  if v_state is null      then return false; end if;
  if v_state = 'released' then return true;  end if;   -- replay
  if v_state = 'committed' then return false; end if;

  update credit_transactions
     set state      = 'released',
         settled_at = now(),
         note       = coalesce(p_note, note)
   where id = p_transaction_id;
  return true;
end;
$$;


--
-- Name: reserve_ai_credits(uuid, text, integer, uuid, text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_ai_credits(p_baker_id uuid, p_action_key text, p_allowance integer, p_order_id uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_note text DEFAULT NULL::text, p_window_start timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(transaction_id bigint, ok boolean, reason text, cost integer, from_allowance integer, from_wallet integer)
    LANGUAGE plpgsql
    AS $$
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


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
  $$;


--
-- Name: xray_add_decoration_steps(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.xray_add_decoration_steps(p_order_id uuid, p_key text, p_value jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  v_spec jsonb;
  v_next jsonb;
begin
  select xray_spec into v_spec from orders where id = p_order_id for update;
  if v_spec is null then return null; end if;

  -- Bare (pre-029) rows ARE the design. Wrap before adding, so the shape converges on write
  -- rather than depending on a backfill nobody runs.
  if v_spec ? 'design' then
    v_next := v_spec;
  else
    v_next := jsonb_build_object('design', v_spec);
  end if;

  v_next := v_next || jsonb_build_object(
    'decorations',
    coalesce(v_next -> 'decorations', '{}'::jsonb) || jsonb_build_object(p_key, p_value)
  );

  update orders set xray_spec = v_next where id = p_order_id;
  return v_next -> 'decorations';
end;
$$;


--
-- Name: FUNCTION xray_add_decoration_steps(p_order_id uuid, p_key text, p_value jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.xray_add_decoration_steps(p_order_id uuid, p_key text, p_value jsonb) IS 'Atomically add one decoration''s steps to orders.xray_spec. Merges inside the statement (row-locked) because two decorations generated at once would otherwise clobber each other and the baker would pay for steps that vanish. Promotes a pre-029 bare design_snapshot to the { design, decorations } wrapper on first write.';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admins (
    auth_user_id uuid NOT NULL,
    role text DEFAULT 'admin_staff'::text NOT NULL,
    email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT admins_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'admin_staff'::text])))
);


--
-- Name: baker_appusers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baker_appusers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    baker_id uuid NOT NULL,
    role public.baker_contact_role DEFAULT 'owner'::public.baker_contact_role NOT NULL,
    email text,
    phone text,
    whatsapp_number text,
    address text,
    city text,
    state text,
    pincode text,
    country text DEFAULT 'IN'::text NOT NULL,
    is_primary boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_user_id uuid,
    first_name text NOT NULL,
    last_name text NOT NULL,
    phone_country text,
    welcome_sent_at timestamp with time zone,
    tour_seen_at timestamp with time zone
);


--
-- Name: COLUMN baker_appusers.tour_seen_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.baker_appusers.tour_seen_at IS 'When this person was first shown the designer tour. NULL = never. Per PERSON, not per bakery — bakers is the shop, and a second staff member deserves their own first run.';


--
-- Name: baker_element_exclusions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baker_element_exclusions (
    baker_id uuid NOT NULL,
    element_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: baker_flavour_dietary_conflicts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baker_flavour_dietary_conflicts (
    baker_id uuid NOT NULL,
    flavour_id uuid,
    baker_flavour_id uuid,
    requirement_id smallint NOT NULL,
    conflicts boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT baker_flavour_dietary_one_target CHECK ((num_nonnulls(flavour_id, baker_flavour_id) = 1))
);


--
-- Name: TABLE baker_flavour_dietary_conflicts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.baker_flavour_dietary_conflicts IS 'Sparse per-baker override of flavour_dietary_conflicts. conflicts=true adds a conflict, conflicts=false clears one the global baseline asserted (a baker who really does make a nut-free hazelnut sponge must be able to say so). No row = no opinion, fall through to the baseline. Exclusive arc: exactly one of flavour_id / baker_flavour_id is set.';


--
-- Name: baker_flavour_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baker_flavour_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    baker_id uuid NOT NULL,
    flavour_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    offered boolean DEFAULT true NOT NULL,
    price_per_kg numeric(10,2),
    display_name text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_signature boolean DEFAULT false NOT NULL,
    CONSTRAINT baker_flavour_settings_price_non_negative CHECK (((price_per_kg IS NULL) OR (price_per_kg >= (0)::numeric)))
);


--
-- Name: TABLE baker_flavour_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.baker_flavour_settings IS 'Sparse per-baker overlay on the global flavours list. A row means this baker has said something about this flavour — switched it off, priced it, or renamed it for their menu. No row = offered, unpriced, under its global name. Renamed from baker_flavour_exclusions in migration 037, where presence alone meant excluded.';


--
-- Name: COLUMN baker_flavour_settings.price_per_kg; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.baker_flavour_settings.price_per_kg IS 'What this baker charges per kg for this flavour. NULL = not priced; the storefront says "ask" and never guesses. Whether a customer ever SEES it is bakers.price_visibility, not this column.';


--
-- Name: COLUMN baker_flavour_settings.display_name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.baker_flavour_settings.display_name IS 'Optional per-baker name override ("Choco Truffle" for "Chocolate Truffle"). NULL = use the global name. Exists so a baker can match their own menu without the global list being cloned per baker.';


--
-- Name: COLUMN baker_flavour_settings.is_signature; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.baker_flavour_settings.is_signature IS 'Has this baker marked this global flavour as one of theirs? Feeds the storefront suggester as a TIEBREAK (it cannot overturn a rule) and the "what this kitchen is known for" fallback. Capped at 3 per baker in PUT /api/baker/flavours — the claim means nothing if it is everything. Default false.';


--
-- Name: baker_flavours; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baker_flavours (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    baker_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    price_per_kg numeric(10,2),
    sponge_color text,
    filling_color text,
    taste_family text,
    crowd_pleaser boolean,
    is_signature boolean DEFAULT false NOT NULL,
    CONSTRAINT baker_flavours_colors_hex CHECK ((((sponge_color IS NULL) OR (sponge_color ~* '^#[0-9a-f]{6}$'::text)) AND ((filling_color IS NULL) OR (filling_color ~* '^#[0-9a-f]{6}$'::text)))),
    CONSTRAINT baker_flavours_price_non_negative CHECK (((price_per_kg IS NULL) OR (price_per_kg >= (0)::numeric))),
    CONSTRAINT baker_flavours_taste_family_valid CHECK (((taste_family IS NULL) OR (taste_family = ANY (ARRAY['chocolate'::text, 'fruit'::text, 'classic'::text, 'nut'::text, 'caramel'::text, 'coffee'::text, 'tea'::text, 'indian'::text]))))
);


--
-- Name: COLUMN baker_flavours.price_per_kg; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.baker_flavours.price_per_kg IS 'What this baker charges per kg for their own flavour. Direct, not overlaid — they own the row. Same NULL semantics as baker_flavour_settings.price_per_kg.';


--
-- Name: COLUMN baker_flavours.is_signature; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.baker_flavours.is_signature IS 'Has this baker marked their own recipe as a signature? Same meaning and same cap as baker_flavour_settings.is_signature — counted together, since a baker has one set of signatures, not one per table.';


--
-- Name: baker_storefront_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baker_storefront_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    baker_id uuid NOT NULL,
    storage_key text NOT NULL,
    caption text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: baker_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baker_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    baker_id uuid NOT NULL,
    start_date date NOT NULL,
    end_date date,
    created_at timestamp with time zone DEFAULT now(),
    plan_id integer,
    billing_period_id integer,
    status_id integer DEFAULT 1 NOT NULL,
    billing_subscription_id text,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    cancellation_requested_at timestamp with time zone,
    cancellation_reason_id smallint,
    cancellation_note text,
    scheduled_plan_id integer,
    scheduled_effective_at timestamp with time zone,
    scheduled_subscription_id text
);


--
-- Name: baker_template_exclusions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baker_template_exclusions (
    baker_id uuid NOT NULL,
    template_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE baker_template_exclusions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.baker_template_exclusions IS 'Per-baker hidden GLOBAL templates. A row = this baker has switched OFF that Spattoo global template, so it is filtered out of GET /api/templates for the whole tenant. Baker-owned templates are never listed here (a baker deletes their own). Mirrors baker_flavour_exclusions.';


--
-- Name: baker_testimonials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baker_testimonials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    baker_id uuid NOT NULL,
    quote text NOT NULL,
    author text,
    occasion text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: baker_upload_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baker_upload_shares (
    upload_id bigint NOT NULL,
    shared_with_type smallint NOT NULL,
    shared_with_id uuid NOT NULL,
    shared_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: baker_uploads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.baker_uploads (
    id bigint NOT NULL,
    baker_id uuid NOT NULL,
    uploaded_by_type smallint NOT NULL,
    uploaded_by_id uuid NOT NULL,
    for_customer_id uuid,
    storage_key text NOT NULL,
    name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    cutout_key text
);


--
-- Name: baker_uploads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.baker_uploads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: baker_uploads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.baker_uploads_id_seq OWNED BY public.baker_uploads.id;


--
-- Name: bakers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bakers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    logo_url text,
    primary_color text,
    accent_color text,
    tagline text,
    email text,
    instagram_handle text,
    website_url text,
    subscription_start_date date,
    subscription_end_date date,
    auth_user_id uuid,
    currency_code text DEFAULT 'INR'::text NOT NULL,
    timezone text DEFAULT 'Asia/Kolkata'::text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    payment_provider_id uuid,
    subscription_status_id integer,
    subscription_plan_id integer,
    billing_customer_id text,
    billing_subscription_id text,
    story text,
    storefront_theme_id smallint DEFAULT 1 NOT NULL,
    portrait_url text,
    storefront_published boolean DEFAULT false NOT NULL,
    storefront_customizations jsonb DEFAULT '{}'::jsonb NOT NULL,
    address_line1 text,
    address_line2 text,
    street text,
    city text,
    state text,
    postal_code text,
    country text,
    logo_transparent_key text,
    gstin text,
    deletion_status smallint DEFAULT 0 NOT NULL,
    deletion_requested_at timestamp with time zone,
    erase_after timestamp with time zone,
    notice_sent_at timestamp with time zone,
    first_paid_at timestamp with time zone,
    credits_low_alert_month date,
    credits_exhausted_alert_month date,
    price_visibility text DEFAULT 'private'::text NOT NULL,
    lead_time_days integer DEFAULT 0 NOT NULL,
    CONSTRAINT bakers_gstin_format_chk CHECK (((gstin IS NULL) OR (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'::text))),
    CONSTRAINT bakers_lead_time_days_sane CHECK (((lead_time_days >= 0) AND (lead_time_days <= 90))),
    CONSTRAINT bakers_price_visibility_valid CHECK ((price_visibility = ANY (ARRAY['private'::text, 'verified'::text, 'public'::text])))
);


--
-- Name: COLUMN bakers.first_paid_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bakers.first_paid_at IS 'Instant of this baker''s FIRST captured payment. Set once by the billing webhook (fill-when-null), never cleared — a baker who has paid never returns to trial. NULL = has never paid. Drives the lapsed-access gate copy (trial ended vs subscription ended vs renewal failed).';


--
-- Name: COLUMN bakers.credits_low_alert_month; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bakers.credits_low_alert_month IS 'Month (its 1st, IST) whose 80%-of-allowance warning has been sent. Null = never. Compared against the current month start, so it needs no monthly reset.';


--
-- Name: COLUMN bakers.credits_exhausted_alert_month; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bakers.credits_exhausted_alert_month IS 'Month (its 1st, IST) whose allowance-exhausted notice has been sent. Same convention as credits_low_alert_month.';


--
-- Name: COLUMN bakers.price_visibility; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bakers.price_visibility IS 'Who sees per-kg prices: private (nobody — the default, and still useful because the baker''s own quote drafting reads them), verified (customers who have proved a phone/email), public (anyone). Gated by show_flavours: there is nowhere to show a price for a list you are not showing.';


--
-- Name: COLUMN bakers.lead_time_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bakers.lead_time_days IS 'Minimum notice in days before a delivery date this baker will accept — 0 means same-day is fine, which is the default and today''s behaviour. The storefront date picker refuses anything inside the window, so a customer learns on the page rather than a day later. Not capacity, not blackout dates.';


--
-- Name: billing_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_outbox (
    id bigint NOT NULL,
    event_id text NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone
);


--
-- Name: billing_outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.billing_outbox ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.billing_outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: billing_periods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_periods (
    id integer NOT NULL,
    name text NOT NULL,
    display_name text NOT NULL,
    months integer NOT NULL,
    discount_pct integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cake_elements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cake_elements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    offering text DEFAULT 'standard'::text NOT NULL,
    image_url text,
    thumbnail_url text,
    default_params jsonb DEFAULT '{}'::jsonb,
    is_active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    element_type_id uuid,
    baker_id uuid,
    parent_id uuid,
    allowed_zones text[],
    applicable_zones text[] DEFAULT '{}'::text[],
    default_color text,
    placement_config jsonb DEFAULT '{}'::jsonb NOT NULL,
    allowed_actions jsonb DEFAULT '{}'::jsonb NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    file_size bigint,
    pattern_only boolean DEFAULT false NOT NULL,
    description_embedding public.vector(1536),
    thumb_key text,
    asset_class smallint,
    tri_count integer,
    texture_max_dim smallint,
    decoded_mem_kb integer,
    optimized_size_kb integer,
    over_cap boolean DEFAULT false NOT NULL,
    optimizer_version smallint,
    optimized_at timestamp with time zone,
    customer_id uuid,
    source_upload_id bigint,
    promoted_by uuid,
    promoted_at timestamp with time zone,
    medium text,
    CONSTRAINT cake_elements_medium_chk CHECK (((medium IS NULL) OR (medium = ANY (ARRAY['fondant'::text, 'edible_print'::text, 'piped'::text, 'acrylic'::text, 'other'::text]))))
);


--
-- Name: COLUMN cake_elements.pattern_only; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cake_elements.pattern_only IS 'Hide from the baker''s individual element picker; still usable as a pattern
  building block.';


--
-- Name: COLUMN cake_elements.thumb_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cake_elements.thumb_key IS 'R2 key of the optimised WebP picker thumbnail (<=256px, served direct). Full-res raw source kept in thumbnail_url.';


--
-- Name: COLUMN cake_elements.asset_class; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cake_elements.asset_class IS 'GLB cost tier (compact surrogate): 1=scatter/small, 2=decor, 3=topper/hero. Drives the §3 caps.';


--
-- Name: COLUMN cake_elements.decoded_mem_kb; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cake_elements.decoded_mem_kb IS 'Estimated decoded GPU memory (KB) — the metric that actually bounds phone RAM, not file size.';


--
-- Name: COLUMN cake_elements.over_cap; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cake_elements.over_cap IS 'True if any measured stat exceeds the asset_class caps. A flag for visibility, not a block.';


--
-- Name: COLUMN cake_elements.customer_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cake_elements.customer_id IS 'Narrower-than-tenant owner. NULL = shared with the whole baker (or global if baker_id is also NULL); set = private to that one customer.';


--
-- Name: COLUMN cake_elements.medium; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cake_elements.medium IS 'Admin HINT for what to pre-build (fondant -> generate a modelling guide at publish). NEVER a gate on what a baker may do: the same 2D image can be printed OR modelled, and that choice belongs to the baker and their customer. Null = not stated.';


--
-- Name: cake_shapes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cake_shapes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    thumbnail_key text,
    design jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: TABLE cake_shapes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.cake_shapes IS 'Master list of cake footprints. `family` names an outline generator in spattoo-core (geometry/shapes.js); `config` is that family''s data. Seeded in code (designer/cakeShapes.js) and overlaid from here.';


--
-- Name: COLUMN cake_shapes.thumbnail_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cake_shapes.thumbnail_key IS 'R2 key of a FRONT VIEW of this shape, captured through the real designer renderer when the shape is saved. The picker renders it as an <img> — one image per shape rather than one WebGL context per shape.';


--
-- Name: COLUMN cake_shapes.design; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.cake_shapes.design IS 'The self-contained starter design for this shape — the SAME shape as cake_templates.design. Each tier carries its own shapeFamily + shapeConfig, so geometry travels with the design and a cake can mix shapes per tier. "New cake → this shape" loads this via the designer''s loadDesign(), exactly like a template.';


--
-- Name: cake_template_attrs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cake_template_attrs (
    template_id uuid NOT NULL,
    min_weight_kg numeric(5,2),
    min_age smallint,
    max_age smallint,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT age_range_valid CHECK (((max_age IS NULL) OR (min_age IS NULL) OR (max_age >= min_age))),
    CONSTRAINT cake_template_attrs_max_age_check CHECK ((max_age >= 0)),
    CONSTRAINT cake_template_attrs_min_age_check CHECK ((min_age >= 0)),
    CONSTRAINT cake_template_attrs_min_weight_kg_check CHECK ((min_weight_kg > (0)::numeric))
);


--
-- Name: cake_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cake_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    shape text DEFAULT 'round'::text NOT NULL,
    tier_count integer NOT NULL,
    offering text DEFAULT 'standard'::text NOT NULL,
    design jsonb NOT NULL,
    thumbnail_url text,
    is_active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    baker_id uuid,
    type text DEFAULT 'basic'::text NOT NULL,
    parent_template_id uuid
);


--
-- Name: cake_textures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cake_textures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    algorithm text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: cancellation_reasons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cancellation_reasons (
    id smallint NOT NULL,
    key text NOT NULL,
    display_name text NOT NULL,
    is_customer_selectable boolean DEFAULT false NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: capabilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capabilities (
    key text NOT NULL,
    label text NOT NULL,
    description text,
    category text DEFAULT 'baker'::text NOT NULL,
    is_sensitive boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: consent_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consent_events (
    id bigint NOT NULL,
    subject_type smallint NOT NULL,
    subject_id uuid NOT NULL,
    document_version_id smallint NOT NULL,
    action smallint DEFAULT 1 NOT NULL,
    source smallint NOT NULL,
    consented_at timestamp with time zone DEFAULT now() NOT NULL,
    ip inet,
    user_agent text
);


--
-- Name: consent_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.consent_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: consent_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.consent_events_id_seq OWNED BY public.consent_events.id;


--
-- Name: content_attestations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_attestations (
    id bigint NOT NULL,
    subject_type smallint NOT NULL,
    subject_id uuid NOT NULL,
    baker_id uuid NOT NULL,
    target_type smallint NOT NULL,
    target_id text NOT NULL,
    document_version_id smallint NOT NULL,
    attested_at timestamp with time zone DEFAULT now() NOT NULL,
    ip inet,
    user_agent text
);


--
-- Name: content_attestations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_attestations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_attestations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_attestations_id_seq OWNED BY public.content_attestations.id;


--
-- Name: credit_costs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_costs (
    id smallint NOT NULL,
    action_key text NOT NULL,
    credits integer NOT NULL,
    label text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credit_costs_credits_check CHECK ((credits > 0))
);


--
-- Name: credit_costs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.credit_costs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.credit_costs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: credit_packs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_packs (
    id smallint NOT NULL,
    pack_key text NOT NULL,
    credits integer NOT NULL,
    price_paise integer NOT NULL,
    label text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order smallint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credit_packs_credits_check CHECK ((credits > 0)),
    CONSTRAINT credit_packs_price_paise_check CHECK ((price_paise > 0))
);


--
-- Name: credit_packs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.credit_packs ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.credit_packs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: credit_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_transactions (
    id bigint NOT NULL,
    baker_id uuid NOT NULL,
    kind text NOT NULL,
    state text DEFAULT 'committed'::text NOT NULL,
    action_id smallint,
    credits integer NOT NULL,
    allowance_credits integer DEFAULT 0 NOT NULL,
    wallet_credits integer DEFAULT 0 NOT NULL,
    order_id uuid,
    provider text,
    model text,
    prompt_version text,
    provider_cost_inr numeric(12,4),
    idempotency_key text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    settled_at timestamp with time zone,
    pack_id smallint,
    CONSTRAINT credit_transactions_kind_check CHECK ((kind = ANY (ARRAY['grant'::text, 'purchase'::text, 'debit'::text, 'refund'::text, 'adjustment'::text]))),
    CONSTRAINT credit_transactions_only_debits_reserve CHECK (((state = 'committed'::text) OR (kind = 'debit'::text))),
    CONSTRAINT credit_transactions_sign_matches_kind CHECK ((((kind = 'debit'::text) AND (credits < 0)) OR ((kind <> 'debit'::text) AND (credits >= 0)))),
    CONSTRAINT credit_transactions_split_matches CHECK ((credits = (allowance_credits + wallet_credits))),
    CONSTRAINT credit_transactions_state_check CHECK ((state = ANY (ARRAY['reserved'::text, 'committed'::text, 'released'::text])))
);


--
-- Name: credit_transactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.credit_transactions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: credit_transactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.credit_transactions_id_seq OWNED BY public.credit_transactions.id;


--
-- Name: customer_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    baker_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    channels text[] DEFAULT '{email}'::text[] NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    note text,
    sent_at timestamp with time zone,
    opened_at timestamp with time zone,
    expires_at timestamp with time zone,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    design_snapshot jsonb,
    design_thumbnail_url text,
    template_id uuid,
    CONSTRAINT customer_invites_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'opened'::text, 'completed'::text, 'expired'::text, 'revoked'::text])))
);


--
-- Name: customers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    baker_id uuid NOT NULL,
    email text,
    first_name text NOT NULL,
    last_name text,
    phone text,
    source text DEFAULT 'online_order'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    auth_user_id uuid
);


--
-- Name: deletion_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deletion_requests (
    id bigint NOT NULL,
    baker_id uuid NOT NULL,
    requested_by uuid NOT NULL,
    reason text,
    ip inet,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    erase_after timestamp with time zone NOT NULL,
    notice_sent_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    erased_at timestamp with time zone
);


--
-- Name: deletion_requests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.deletion_requests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: deletion_requests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.deletion_requests_id_seq OWNED BY public.deletion_requests.id;


--
-- Name: design_session_statuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.design_session_statuses (
    id smallint NOT NULL,
    key text NOT NULL,
    label text NOT NULL
);


--
-- Name: design_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.design_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    baker_id uuid NOT NULL,
    customer_id uuid,
    order_id uuid,
    status_id smallint DEFAULT 1 NOT NULL,
    host_user_id uuid NOT NULL,
    editor_user_id uuid,
    design_snapshot jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    expires_at timestamp with time zone
);


--
-- Name: device_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_tokens (
    id bigint NOT NULL,
    baker_id uuid NOT NULL,
    auth_user_id uuid NOT NULL,
    token text NOT NULL,
    platform text DEFAULT 'web'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    device_model text,
    os_version text,
    app_version text,
    CONSTRAINT device_tokens_platform_check CHECK ((platform = ANY (ARRAY['web'::text, 'android'::text, 'ios'::text])))
);


--
-- Name: TABLE device_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.device_tokens IS 'FCM registration tokens, one row per device per person. Push addresses a device; email addresses a person — which is why this table exists and notifications.recipient_email was not enough. Pruned on FCM UNREGISTERED (services/fcm.js). Same shape for web, Android and iOS.';


--
-- Name: COLUMN device_tokens.device_model; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.device_tokens.device_model IS 'Handset model, for diagnosing non-delivery (Indian OEMs kill background delivery aggressively). Null on web, where a browser cannot report one. Personal data — erased with the account.';


--
-- Name: device_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.device_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: device_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.device_tokens_id_seq OWNED BY public.device_tokens.id;


--
-- Name: dietary_requirements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dietary_requirements (
    id smallint NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    kind text NOT NULL,
    sort_order integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT dietary_requirements_kind_check CHECK ((kind = ANY (ARRAY['diet'::text, 'allergen'::text])))
);


--
-- Name: TABLE dietary_requirements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.dietary_requirements IS 'Bounded lookup of dietary/allergen requirements an order can carry. kind=diet is a product attribute (eggless/vegan/Jain — religious+dietary, high volume); kind=allergen is the safety tail (nut/gluten/dairy). Referenced by order_dietary_requirements via the compact smallint id.';


--
-- Name: dietary_requirements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.dietary_requirements ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.dietary_requirements_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: element_action_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.element_action_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    description text,
    default_value boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: element_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.element_candidates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_id uuid,
    created_by uuid,
    source_key text NOT NULL,
    crop_key text,
    output_key text,
    bbox jsonb,
    label text,
    element_kind text,
    color_hex text,
    material text,
    prompt text,
    status text DEFAULT 'identified'::text NOT NULL,
    error text,
    element_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT element_candidates_status_check CHECK ((status = ANY (ARRAY['identified'::text, 'blocked'::text, 'generating'::text, 'ready'::text, 'failed'::text, 'rejected'::text])))
);


--
-- Name: element_craft_guide; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.element_craft_guide (
    element_id uuid NOT NULL,
    nozzle_recs jsonb DEFAULT '[]'::jsonb NOT NULL,
    consistency text,
    technique text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    guide_type text DEFAULT 'piping_nozzle'::text NOT NULL,
    guide jsonb,
    source_image_url text,
    model text,
    prompt_version text,
    status text DEFAULT 'approved'::text NOT NULL,
    generated_at timestamp with time zone,
    baker_id uuid,
    stages_key text,
    CONSTRAINT element_craft_guide_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text]))),
    CONSTRAINT element_craft_guide_type_chk CHECK ((guide_type = ANY (ARRAY['piping_nozzle'::text, 'fondant_figure'::text])))
);


--
-- Name: TABLE element_craft_guide; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.element_craft_guide IS 'Baker how-to-make-it metadata for piping elements, read by the X-Ray order-help feature. Sidecar to cake_elements so the canvas hot path never loads it.';


--
-- Name: COLUMN element_craft_guide.nozzle_recs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.element_craft_guide.nozzle_recs IS 'Recommended piping tips across brands: [{ brand, number, name }]. A pattern element unions the recs of its building-block parts.';


--
-- Name: COLUMN element_craft_guide.consistency; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.element_craft_guide.consistency IS 'Recommended buttercream consistency for this piping: stiff | medium | soft.';


--
-- Name: COLUMN element_craft_guide.technique; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.element_craft_guide.technique IS 'One-line technique tip (tip angle, pressure, pull-away).';


--
-- Name: COLUMN element_craft_guide.guide_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.element_craft_guide.guide_type IS 'piping_nozzle (nozzle_recs/consistency/technique) | fondant_figure (guide jsonb). X-Ray keys off a guide EXISTING, never off the element''s medium or slug — see FONDANT_BUILD_GUIDE_PLAN §3.';


--
-- Name: COLUMN element_craft_guide.guide; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.element_craft_guide.guide IS 'Structured build guide: { title, roles, materials, parts, steps[{n,title,instructions,tools}], tips, set_time }. Steps reference role tokens ({body}) not literal colours, so one guide serves every colour variant.';


--
-- Name: COLUMN element_craft_guide.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.element_craft_guide.status IS 'draft = model-generated, never reviewed by us (every baker-generated guide). approved = a human signed it off. The report must visibly distinguish them.';


--
-- Name: COLUMN element_craft_guide.baker_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.element_craft_guide.baker_id IS 'Who paid for this guide, when a baker generated one for their own element. NULL for admin-authored library guides.';


--
-- Name: COLUMN element_craft_guide.stages_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.element_craft_guide.stages_key IS 'R2 key of the generated build-sequence image (elements/guides/<element_id>/stages.webp), or NULL. Generated once per element and shared, unlike the photo-order equivalent in orders.xray_spec which belongs to a single order. Store the KEY, never the URL — the public base is deployment config.';


--
-- Name: element_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.element_tags (
    element_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    confidence real,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT element_tags_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT element_tags_source_check CHECK ((source = ANY (ARRAY['ai'::text, 'manual'::text])))
);


--
-- Name: element_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.element_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    description text,
    placement_rules jsonb DEFAULT '{}'::jsonb NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    default_allowed_actions jsonb DEFAULT '{"color": false, "style": false, "delete": false, "resize": false, "fontSize": false, "duplicate": false}'::jsonb NOT NULL,
    baker_uploadable boolean DEFAULT false NOT NULL,
    default_for_uploads boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN element_types.baker_uploadable; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.element_types.baker_uploadable IS 'Admin opt-in: a baker/customer may upload their own element of this type. The upload inherits this row''s placement_rules.';


--
-- Name: flavour_dietary_conflicts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flavour_dietary_conflicts (
    flavour_id uuid NOT NULL,
    requirement_id smallint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE flavour_dietary_conflicts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.flavour_dietary_conflicts IS 'Global baseline: this flavour, as generally made, does not satisfy this dietary requirement (e.g. Hazelnut Praline vs nut_free). Admin-authored master data, and a DEFAULT ONLY — a baker can overturn any row via baker_flavour_dietary_conflicts. Drives a warning that names the baker; it never blocks an order and no UI may disable a flavour on the strength of it (ToS §3.4 / B5.9 / C2.3).';


--
-- Name: flavours; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.flavours (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sponge_color text,
    filling_color text,
    taste_family text,
    crowd_pleaser boolean,
    CONSTRAINT flavours_colors_hex CHECK ((((sponge_color IS NULL) OR (sponge_color ~* '^#[0-9a-f]{6}$'::text)) AND ((filling_color IS NULL) OR (filling_color ~* '^#[0-9a-f]{6}$'::text)))),
    CONSTRAINT flavours_taste_family_valid CHECK (((taste_family IS NULL) OR (taste_family = ANY (ARRAY['chocolate'::text, 'fruit'::text, 'classic'::text, 'nut'::text, 'caramel'::text, 'coffee'::text, 'tea'::text, 'indian'::text]))))
);


--
-- Name: COLUMN flavours.sponge_color; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.flavours.sponge_color IS 'Hex colour of the CRUMB, for drawing a slice in cross-section on the storefront. Authored by Spattoo in admin — a property of the flavour, the same in every kitchen. NULL = not yet authored; the renderer falls back to a neutral sponge rather than guessing.';


--
-- Name: COLUMN flavours.filling_color; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.flavours.filling_color IS 'Hex colour of the FILLING or frosting layer, paired with sponge_color to draw a slice. NULL = not yet authored.';


--
-- Name: COLUMN flavours.taste_family; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.flavours.taste_family IS 'What this flavour IS, for the storefront suggester: chocolate | fruit | classic | nut | caramel | coffee | tea | indian. Authored by Spattoo — true in every kitchen. NULL = not yet authored, and the suggester simply cannot score it; never guessed from the name.';


--
-- Name: COLUMN flavours.crowd_pleaser; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.flavours.crowd_pleaser IS 'Does this please a room, or divide it? Drives the "safe bet" answer. Dark chocolate, matcha and rasmalai are wonderful and divide people; vanilla and butterscotch do not. NULL = not yet authored.';


--
-- Name: jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    payload jsonb,
    result jsonb,
    error text,
    baker_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: legal_document_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.legal_document_versions (
    id smallint NOT NULL,
    doc_key text NOT NULL,
    version text NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    content_hash text NOT NULL,
    content text NOT NULL,
    is_current boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: legal_document_versions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.legal_document_versions_id_seq
    AS smallint
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: legal_document_versions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.legal_document_versions_id_seq OWNED BY public.legal_document_versions.id;


--
-- Name: materials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.materials (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: meshy_generations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meshy_generations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_by uuid,
    source_image_key text NOT NULL,
    meshy_task_id text,
    status text DEFAULT 'PENDING'::text NOT NULL,
    progress integer DEFAULT 0 NOT NULL,
    glb_key text,
    thumbnail_url text,
    consumed_credits integer,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT meshy_generations_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'IN_PROGRESS'::text, 'SUCCEEDED'::text, 'FAILED'::text])))
);


--
-- Name: notification_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_types (
    id integer NOT NULL,
    slug text NOT NULL,
    label text NOT NULL,
    audience text DEFAULT 'baker'::text NOT NULL,
    CONSTRAINT notification_types_audience_check CHECK ((audience = ANY (ARRAY['baker'::text, 'customer'::text])))
);


--
-- Name: notification_types_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.notification_types_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: notification_types_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.notification_types_id_seq OWNED BY public.notification_types.id;


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    type_id integer NOT NULL,
    recipient_email text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    status public.notification_status DEFAULT 'pending'::public.notification_status NOT NULL,
    error_message text,
    sent_at timestamp with time zone,
    failed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 3 NOT NULL,
    dedupe_key text,
    read_at timestamp with time zone,
    baker_id uuid
);


--
-- Name: COLUMN notifications.dedupe_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.dedupe_key IS 'Optional caller-chosen uniqueness key for notifications NOT triggered by a one-off event (scheduled digests, broadcasts). A duplicate insert fails on notifications_dedupe_key_idx instead of sending twice, which makes the producing job safely re-runnable. NULL for event-triggered notifications, where the event itself is the guarantee.';


--
-- Name: COLUMN notifications.read_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.read_at IS 'When the BAKERY marked this read (per bakery, not per person — a shop floor deals with an enquiry once). Distinct from `status`, which tracks delivery.';


--
-- Name: COLUMN notifications.baker_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.baker_id IS 'Whose bell this belongs on. recipient_email is the delivery ADDRESS and a poor owner: it is often bakers.email, which exists nowhere in baker_appusers.';


--
-- Name: nozzles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nozzles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand text NOT NULL,
    number text NOT NULL,
    name text,
    category text NOT NULL,
    description text,
    sample_image_url text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    is_common boolean DEFAULT false NOT NULL
);


--
-- Name: TABLE nozzles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.nozzles IS 'Vetted catalog of real piping tips. Grounds the GPT craft-guide suggester and feeds a future baker nozzle-learning screen. Internal-admin curated.';


--
-- Name: COLUMN nozzles.category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.nozzles.category IS 'Shape class the tip produces. Groups equivalents across brands for GPT matching and the learning screen.';


--
-- Name: COLUMN nozzles.sample_image_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.nozzles.sample_image_url IS 'R2 key of a sample-output image for the baker learning screen. Nullable; populated over time.';


--
-- Name: order_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    baker_id uuid NOT NULL,
    event text NOT NULL,
    comment text,
    changes jsonb,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    changed_by_name text
);


--
-- Name: order_design_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_design_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    version_no integer NOT NULL,
    design_snapshot jsonb NOT NULL,
    design_thumbnail_url text,
    authored_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_design_versions_authored_by_check CHECK ((authored_by = ANY (ARRAY['customer'::text, 'baker'::text])))
);


--
-- Name: order_dietary_requirements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_dietary_requirements (
    order_id uuid NOT NULL,
    requirement_id smallint NOT NULL,
    source text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT order_dietary_requirements_source_check CHECK ((source = ANY (ARRAY['customer'::text, 'baker'::text])))
);


--
-- Name: TABLE order_dietary_requirements; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.order_dietary_requirements IS 'Dietary/allergen requirements asserted on an order. A row is an ASSERTION recorded by Spattoo, not a verification by it — `source` says who made it (customer vs baker recording what the customer said). Order-level on purpose: an eggless requirement is not satisfied by one eggless tier.';


--
-- Name: order_finished_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_finished_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    key text NOT NULL,
    sort_order smallint DEFAULT 0 NOT NULL,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: order_reference_photos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_reference_photos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id uuid NOT NULL,
    key text NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: order_statuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.order_statuses (
    key text NOT NULL,
    label text NOT NULL,
    phase text NOT NULL,
    sort_order integer NOT NULL,
    is_terminal boolean DEFAULT false NOT NULL,
    customer_visible boolean DEFAULT true NOT NULL,
    tone text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    id smallint NOT NULL,
    CONSTRAINT order_statuses_phase_check CHECK ((phase = ANY (ARRAY['quote'::text, 'fulfillment'::text, 'closed'::text])))
);


--
-- Name: order_statuses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.order_statuses ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.order_statuses_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    baker_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    design_snapshot jsonb,
    design_thumbnail_url text,
    weight_kg numeric(4,2),
    flavours jsonb,
    special_instructions text,
    delivery_date date,
    delivery_time time without time zone,
    delivery_mode text DEFAULT 'pickup'::text NOT NULL,
    delivery_address text,
    approved_at timestamp with time zone,
    approved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    suggested_price numeric(10,2),
    quoted_price numeric(10,2),
    quote_line_items jsonb,
    quote_valid_until timestamp with time zone,
    final_price numeric(10,2),
    priced_at timestamp with time zone,
    current_version_id uuid,
    quoted_version_id uuid,
    status_id smallint NOT NULL,
    advance_amount numeric(10,2),
    quote_note text,
    advance_paid_at timestamp with time zone,
    xray_spec jsonb,
    xray_spec_meta jsonb,
    xray_spec_edited jsonb,
    occasion text,
    recipient text,
    cake_number integer,
    tier_count integer,
    shape text,
    celebration text,
    CONSTRAINT delivery_address_required CHECK (((delivery_mode <> 'home_delivery'::text) OR (delivery_address IS NOT NULL))),
    CONSTRAINT orders_cake_number_sane CHECK (((cake_number IS NULL) OR ((cake_number >= 0) AND (cake_number <= 9999)))),
    CONSTRAINT orders_celebration_valid CHECK (((celebration IS NULL) OR (celebration = ANY (ARRAY['first_birthday'::text, 'kids_party'::text, 'teen_party'::text, 'grown_ups'::text, 'elders'::text])))),
    CONSTRAINT orders_occasion_valid CHECK (((occasion IS NULL) OR (occasion = ANY (ARRAY['birthday'::text, 'anniversary'::text, 'wedding'::text, 'engagement'::text, 'bridal_shower'::text, 'baby_shower'::text, 'new_home'::text, 'graduation'::text, 'new_job'::text, 'festival'::text, 'farewell'::text, 'corporate'::text, 'love'::text, 'other'::text])))),
    CONSTRAINT orders_recipient_valid CHECK (((recipient IS NULL) OR (recipient = ANY (ARRAY['child'::text, 'adult'::text, 'couple'::text, 'family'::text, 'friends'::text, 'colleagues'::text])))),
    CONSTRAINT orders_tier_count_sane CHECK (((tier_count IS NULL) OR ((tier_count >= 1) AND (tier_count <= 6))))
);


--
-- Name: COLUMN orders.xray_spec; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.xray_spec IS 'IMMUTABLE model reading of a reference-photo order, in design_snapshot shape — the INPUT X-Ray computes from. Never updated in place; corrections belong in xray_spec_edited.';


--
-- Name: COLUMN orders.xray_spec_meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.xray_spec_meta IS '{ provider, model, prompt_version, confidence, credit_transaction_id, source_photo_key, coverage } — provenance for the spec above.';


--
-- Name: COLUMN orders.xray_spec_edited; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.xray_spec_edited IS 'Baker-corrected copy of xray_spec. NULL until they change something. spec vs edited is the accuracy signal.';


--
-- Name: COLUMN orders.occasion; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.occasion IS 'What the cake is for. Fixed vocabulary, widened by 059: birthday | anniversary | wedding | engagement | bridal_shower | baby_shower | new_home | graduation | new_job | festival | farewell | corporate | love | other. `love` is a motive rather than an event — it covers Valentine''s without pinning a date, and unlike `other` it gives the flavour suggester something to argue from. Customer-facing labels live in spattoo-core cakeDraft.js OCCASIONS and must stay in step with this list.';


--
-- Name: COLUMN orders.recipient; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.recipient IS 'WHO the cake is for: child | adult | couple | family | friends | colleagues. Deliberately NOT an audience size — that is weight_kg. NULL = not answered.';


--
-- Name: COLUMN orders.cake_number; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.cake_number IS 'The number to put ON the cake (a 6, a 50, a 2026). Production data the baker pipes — NOT an age: 25 on an anniversary cake is years married. Only readable as an age when occasion = birthday, and even then it is an inference.';


--
-- Name: COLUMN orders.tier_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.tier_count IS 'How many tiers the customer asked for. ASKED on the storefront (the size facet''s second step) or derived from a picked template. Drives the weight floor — a two-tier cake has a structural minimum whatever the guest count. NULL = never established.';


--
-- Name: COLUMN orders.shape; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.shape IS 'Round, square, heart… DERIVED, never asked: copied from the template or design snapshot when one exists, NULL otherwise. Deliberately not a FK to cake_shapes — a snapshot''s shape is a string inside jsonb, so a FK would be stricter than the source it copies.';


--
-- Name: COLUMN orders.celebration; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.orders.celebration IS 'What KIND of celebration this cake is for: first_birthday | kids_party | teen_party | grown_ups | elders. Replaces 043''s age_band, which was an attribute of a person — usually a child. This describes the EVENT, which is what the flavour suggester actually needs: a first birthday is a milder cake because of the occasion, not because of the guest. NULL = not asked or not answered.';


--
-- Name: patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patterns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    placements jsonb DEFAULT '[]'::jsonb NOT NULL,
    thumbnail_filename text,
    baker_id uuid,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: payment_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    display_name text NOT NULL,
    supported_currencies text[] DEFAULT '{}'::text[] NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    baker_id uuid NOT NULL,
    baker_subscription_id uuid,
    razorpay_payment_id text,
    razorpay_subscription_id text,
    amount integer NOT NULL,
    currency text DEFAULT 'INR'::text NOT NULL,
    status_id integer NOT NULL,
    charged_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    credit_pack_id smallint
);


--
-- Name: COLUMN payments.credit_pack_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payments.credit_pack_id IS 'Set when this payment bought an AI credit pack; NULL for a subscription charge. Presence identifies the row as a top-up and the value names the pack — the label is read from credit_packs so it cannot drift.';


--
-- Name: print_sheets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.print_sheets (
    id bigint NOT NULL,
    baker_id uuid NOT NULL,
    name text NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL,
    guide jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE print_sheets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.print_sheets IS 'Saved layouts for the Edible Print Studio (Chef''s Desk). One row per sheet. items[].uploadId references baker_uploads WITHOUT a foreign key on purpose — a deleted image leaves a hole in the sheet, it does not delete the sheet. Not a cake_template: a template is a 3D design offered to customers, this is paper that never leaves the kitchen.';


--
-- Name: print_sheets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.print_sheets_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: print_sheets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.print_sheets_id_seq OWNED BY public.print_sheets.id;


--
-- Name: role_capabilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_capabilities (
    role_key text NOT NULL,
    capability_key text NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    key text NOT NULL,
    label text NOT NULL,
    description text,
    scope text DEFAULT 'baker'::text NOT NULL,
    is_super boolean DEFAULT false NOT NULL,
    is_system boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: storefront_themes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.storefront_themes (
    id smallint NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    sort_order smallint DEFAULT 0 NOT NULL,
    is_premium boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN storefront_themes.is_premium; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.storefront_themes.is_premium IS 'Whether this theme needs the `premium_themes` entitlement (Blaze+). false = available on every plan. Checked when a baker CHOOSES a theme, never when a storefront is rendered — a shop already published on a theme keeps rendering it if the theme is later re-priced.';


--
-- Name: subscription_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    baker_id uuid NOT NULL,
    event text NOT NULL,
    previous_tier text,
    new_tier text,
    previous_status text,
    new_status text,
    note text,
    changed_by text DEFAULT 'system'::text NOT NULL,
    changed_by_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: subscription_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_plans (
    id integer NOT NULL,
    name text NOT NULL,
    display_name text NOT NULL,
    price_monthly numeric(10,2) DEFAULT 0 NOT NULL,
    price_yearly numeric(10,2) DEFAULT 0 NOT NULL,
    features jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tagline text,
    feature_bullets text[] DEFAULT '{}'::text[] NOT NULL,
    is_popular boolean DEFAULT false NOT NULL,
    has_storefront boolean DEFAULT true NOT NULL
);


--
-- Name: subscription_statuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_statuses (
    id integer NOT NULL,
    name text NOT NULL,
    label text NOT NULL,
    description text,
    sort_order integer DEFAULT 0 NOT NULL
);


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    category text NOT NULL,
    ai_assignable boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tags_category_check CHECK ((category = ANY (ARRAY['occasion'::text, 'style'::text, 'color'::text, 'material'::text, 'theme'::text, 'age_group'::text, 'gender'::text])))
);


--
-- Name: template_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.template_tags (
    template_id uuid NOT NULL,
    tag_id uuid NOT NULL,
    source text DEFAULT 'manual'::text NOT NULL,
    confidence real,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT template_tags_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT template_tags_source_check CHECK ((source = ANY (ARRAY['ai'::text, 'manual'::text])))
);


--
-- Name: text_styles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.text_styles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    algorithm text DEFAULT 'scribble'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: baker_uploads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_uploads ALTER COLUMN id SET DEFAULT nextval('public.baker_uploads_id_seq'::regclass);


--
-- Name: consent_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_events ALTER COLUMN id SET DEFAULT nextval('public.consent_events_id_seq'::regclass);


--
-- Name: content_attestations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_attestations ALTER COLUMN id SET DEFAULT nextval('public.content_attestations_id_seq'::regclass);


--
-- Name: credit_transactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_transactions ALTER COLUMN id SET DEFAULT nextval('public.credit_transactions_id_seq'::regclass);


--
-- Name: deletion_requests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deletion_requests ALTER COLUMN id SET DEFAULT nextval('public.deletion_requests_id_seq'::regclass);


--
-- Name: device_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tokens ALTER COLUMN id SET DEFAULT nextval('public.device_tokens_id_seq'::regclass);


--
-- Name: legal_document_versions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_document_versions ALTER COLUMN id SET DEFAULT nextval('public.legal_document_versions_id_seq'::regclass);


--
-- Name: notification_types id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_types ALTER COLUMN id SET DEFAULT nextval('public.notification_types_id_seq'::regclass);


--
-- Name: print_sheets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.print_sheets ALTER COLUMN id SET DEFAULT nextval('public.print_sheets_id_seq'::regclass);


--
-- Name: admins admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_pkey PRIMARY KEY (auth_user_id);


--
-- Name: baker_appusers baker_contacts_auth_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_appusers
    ADD CONSTRAINT baker_contacts_auth_user_id_key UNIQUE (auth_user_id);


--
-- Name: baker_appusers baker_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_appusers
    ADD CONSTRAINT baker_contacts_pkey PRIMARY KEY (id);


--
-- Name: baker_element_exclusions baker_element_exclusions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_element_exclusions
    ADD CONSTRAINT baker_element_exclusions_pkey PRIMARY KEY (baker_id, element_id);


--
-- Name: baker_flavour_settings baker_flavour_settings_baker_id_flavour_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_flavour_settings
    ADD CONSTRAINT baker_flavour_settings_baker_id_flavour_id_key UNIQUE (baker_id, flavour_id);


--
-- Name: baker_flavour_settings baker_flavour_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_flavour_settings
    ADD CONSTRAINT baker_flavour_settings_pkey PRIMARY KEY (id);


--
-- Name: baker_flavours baker_flavours_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_flavours
    ADD CONSTRAINT baker_flavours_pkey PRIMARY KEY (id);


--
-- Name: baker_storefront_photos baker_storefront_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_storefront_photos
    ADD CONSTRAINT baker_storefront_photos_pkey PRIMARY KEY (id);


--
-- Name: baker_subscriptions baker_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_subscriptions
    ADD CONSTRAINT baker_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: baker_template_exclusions baker_template_exclusions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_template_exclusions
    ADD CONSTRAINT baker_template_exclusions_pkey PRIMARY KEY (baker_id, template_id);


--
-- Name: baker_testimonials baker_testimonials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_testimonials
    ADD CONSTRAINT baker_testimonials_pkey PRIMARY KEY (id);


--
-- Name: baker_upload_shares baker_upload_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_upload_shares
    ADD CONSTRAINT baker_upload_shares_pkey PRIMARY KEY (upload_id, shared_with_type, shared_with_id);


--
-- Name: baker_uploads baker_uploads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_uploads
    ADD CONSTRAINT baker_uploads_pkey PRIMARY KEY (id);


--
-- Name: bakers bakers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bakers
    ADD CONSTRAINT bakers_pkey PRIMARY KEY (id);


--
-- Name: bakers bakers_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bakers
    ADD CONSTRAINT bakers_slug_key UNIQUE (slug);


--
-- Name: billing_outbox billing_outbox_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_outbox
    ADD CONSTRAINT billing_outbox_event_id_key UNIQUE (event_id);


--
-- Name: billing_outbox billing_outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_outbox
    ADD CONSTRAINT billing_outbox_pkey PRIMARY KEY (id);


--
-- Name: billing_periods billing_periods_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_periods
    ADD CONSTRAINT billing_periods_name_key UNIQUE (name);


--
-- Name: billing_periods billing_periods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_periods
    ADD CONSTRAINT billing_periods_pkey PRIMARY KEY (id);


--
-- Name: cake_elements cake_elements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_elements
    ADD CONSTRAINT cake_elements_pkey PRIMARY KEY (id);


--
-- Name: cake_shapes cake_shapes_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_shapes
    ADD CONSTRAINT cake_shapes_key_key UNIQUE (key);


--
-- Name: cake_shapes cake_shapes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_shapes
    ADD CONSTRAINT cake_shapes_pkey PRIMARY KEY (id);


--
-- Name: cake_template_attrs cake_template_attrs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_template_attrs
    ADD CONSTRAINT cake_template_attrs_pkey PRIMARY KEY (template_id);


--
-- Name: cake_templates cake_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_templates
    ADD CONSTRAINT cake_templates_pkey PRIMARY KEY (id);


--
-- Name: cake_textures cake_textures_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_textures
    ADD CONSTRAINT cake_textures_key_key UNIQUE (key);


--
-- Name: cake_textures cake_textures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_textures
    ADD CONSTRAINT cake_textures_pkey PRIMARY KEY (id);


--
-- Name: cancellation_reasons cancellation_reasons_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cancellation_reasons
    ADD CONSTRAINT cancellation_reasons_key_key UNIQUE (key);


--
-- Name: cancellation_reasons cancellation_reasons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cancellation_reasons
    ADD CONSTRAINT cancellation_reasons_pkey PRIMARY KEY (id);


--
-- Name: capabilities capabilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capabilities
    ADD CONSTRAINT capabilities_pkey PRIMARY KEY (key);


--
-- Name: consent_events consent_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_events
    ADD CONSTRAINT consent_events_pkey PRIMARY KEY (id);


--
-- Name: content_attestations content_attestations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_attestations
    ADD CONSTRAINT content_attestations_pkey PRIMARY KEY (id);


--
-- Name: credit_costs credit_costs_action_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_costs
    ADD CONSTRAINT credit_costs_action_key_key UNIQUE (action_key);


--
-- Name: credit_costs credit_costs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_costs
    ADD CONSTRAINT credit_costs_pkey PRIMARY KEY (id);


--
-- Name: credit_packs credit_packs_pack_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_packs
    ADD CONSTRAINT credit_packs_pack_key_key UNIQUE (pack_key);


--
-- Name: credit_packs credit_packs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_packs
    ADD CONSTRAINT credit_packs_pkey PRIMARY KEY (id);


--
-- Name: credit_transactions credit_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_transactions
    ADD CONSTRAINT credit_transactions_pkey PRIMARY KEY (id);


--
-- Name: customer_invites customer_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_invites
    ADD CONSTRAINT customer_invites_pkey PRIMARY KEY (id);


--
-- Name: customers customers_baker_id_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_baker_id_email_key UNIQUE (baker_id, email);


--
-- Name: customers customers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (id);


--
-- Name: deletion_requests deletion_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deletion_requests
    ADD CONSTRAINT deletion_requests_pkey PRIMARY KEY (id);


--
-- Name: design_session_statuses design_session_statuses_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_session_statuses
    ADD CONSTRAINT design_session_statuses_key_key UNIQUE (key);


--
-- Name: design_session_statuses design_session_statuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_session_statuses
    ADD CONSTRAINT design_session_statuses_pkey PRIMARY KEY (id);


--
-- Name: design_sessions design_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_sessions
    ADD CONSTRAINT design_sessions_pkey PRIMARY KEY (id);


--
-- Name: device_tokens device_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tokens
    ADD CONSTRAINT device_tokens_pkey PRIMARY KEY (id);


--
-- Name: device_tokens device_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tokens
    ADD CONSTRAINT device_tokens_token_key UNIQUE (token);


--
-- Name: dietary_requirements dietary_requirements_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dietary_requirements
    ADD CONSTRAINT dietary_requirements_key_key UNIQUE (key);


--
-- Name: dietary_requirements dietary_requirements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dietary_requirements
    ADD CONSTRAINT dietary_requirements_pkey PRIMARY KEY (id);


--
-- Name: element_action_types element_action_types_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_action_types
    ADD CONSTRAINT element_action_types_key_key UNIQUE (key);


--
-- Name: element_action_types element_action_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_action_types
    ADD CONSTRAINT element_action_types_pkey PRIMARY KEY (id);


--
-- Name: element_candidates element_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_candidates
    ADD CONSTRAINT element_candidates_pkey PRIMARY KEY (id);


--
-- Name: element_craft_guide element_craft_guide_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_craft_guide
    ADD CONSTRAINT element_craft_guide_pkey PRIMARY KEY (element_id, guide_type);


--
-- Name: element_tags element_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_tags
    ADD CONSTRAINT element_tags_pkey PRIMARY KEY (element_id, tag_id);


--
-- Name: element_types element_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_types
    ADD CONSTRAINT element_types_pkey PRIMARY KEY (id);


--
-- Name: element_types element_types_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_types
    ADD CONSTRAINT element_types_slug_key UNIQUE (slug);


--
-- Name: flavour_dietary_conflicts flavour_dietary_conflicts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flavour_dietary_conflicts
    ADD CONSTRAINT flavour_dietary_conflicts_pkey PRIMARY KEY (flavour_id, requirement_id);


--
-- Name: flavours flavours_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flavours
    ADD CONSTRAINT flavours_pkey PRIMARY KEY (id);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: legal_document_versions legal_document_versions_doc_key_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_document_versions
    ADD CONSTRAINT legal_document_versions_doc_key_version_key UNIQUE (doc_key, version);


--
-- Name: legal_document_versions legal_document_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.legal_document_versions
    ADD CONSTRAINT legal_document_versions_pkey PRIMARY KEY (id);


--
-- Name: materials materials_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_key_key UNIQUE (key);


--
-- Name: materials materials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.materials
    ADD CONSTRAINT materials_pkey PRIMARY KEY (id);


--
-- Name: meshy_generations meshy_generations_meshy_task_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meshy_generations
    ADD CONSTRAINT meshy_generations_meshy_task_id_key UNIQUE (meshy_task_id);


--
-- Name: meshy_generations meshy_generations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meshy_generations
    ADD CONSTRAINT meshy_generations_pkey PRIMARY KEY (id);


--
-- Name: notification_types notification_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_types
    ADD CONSTRAINT notification_types_pkey PRIMARY KEY (id);


--
-- Name: notification_types notification_types_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_types
    ADD CONSTRAINT notification_types_slug_key UNIQUE (slug);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: nozzles nozzles_brand_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nozzles
    ADD CONSTRAINT nozzles_brand_number_key UNIQUE (brand, number);


--
-- Name: nozzles nozzles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nozzles
    ADD CONSTRAINT nozzles_pkey PRIMARY KEY (id);


--
-- Name: order_audit_log order_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_audit_log
    ADD CONSTRAINT order_audit_log_pkey PRIMARY KEY (id);


--
-- Name: order_design_versions order_design_versions_order_id_version_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_design_versions
    ADD CONSTRAINT order_design_versions_order_id_version_no_key UNIQUE (order_id, version_no);


--
-- Name: order_design_versions order_design_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_design_versions
    ADD CONSTRAINT order_design_versions_pkey PRIMARY KEY (id);


--
-- Name: order_dietary_requirements order_dietary_requirements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_dietary_requirements
    ADD CONSTRAINT order_dietary_requirements_pkey PRIMARY KEY (order_id, requirement_id);


--
-- Name: order_finished_photos order_finished_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_finished_photos
    ADD CONSTRAINT order_finished_photos_pkey PRIMARY KEY (id);


--
-- Name: order_reference_photos order_reference_photos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_reference_photos
    ADD CONSTRAINT order_reference_photos_pkey PRIMARY KEY (id);


--
-- Name: order_statuses order_statuses_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_statuses
    ADD CONSTRAINT order_statuses_key_unique UNIQUE (key);


--
-- Name: order_statuses order_statuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_statuses
    ADD CONSTRAINT order_statuses_pkey PRIMARY KEY (id);


--
-- Name: orders orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_pkey PRIMARY KEY (id);


--
-- Name: patterns patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patterns
    ADD CONSTRAINT patterns_pkey PRIMARY KEY (id);


--
-- Name: payment_providers payment_providers_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_providers
    ADD CONSTRAINT payment_providers_name_key UNIQUE (name);


--
-- Name: payment_providers payment_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_providers
    ADD CONSTRAINT payment_providers_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: payments payments_razorpay_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_razorpay_payment_id_key UNIQUE (razorpay_payment_id);


--
-- Name: print_sheets print_sheets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.print_sheets
    ADD CONSTRAINT print_sheets_pkey PRIMARY KEY (id);


--
-- Name: role_capabilities role_capabilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_capabilities
    ADD CONSTRAINT role_capabilities_pkey PRIMARY KEY (role_key, capability_key);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (key);


--
-- Name: storefront_themes storefront_themes_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storefront_themes
    ADD CONSTRAINT storefront_themes_key_key UNIQUE (key);


--
-- Name: storefront_themes storefront_themes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.storefront_themes
    ADD CONSTRAINT storefront_themes_pkey PRIMARY KEY (id);


--
-- Name: subscription_events subscription_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_pkey PRIMARY KEY (id);


--
-- Name: subscription_plans subscription_plans_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_name_key UNIQUE (name);


--
-- Name: subscription_plans subscription_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_pkey PRIMARY KEY (id);


--
-- Name: subscription_statuses subscription_statuses_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_statuses
    ADD CONSTRAINT subscription_statuses_name_key UNIQUE (name);


--
-- Name: subscription_statuses subscription_statuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_statuses
    ADD CONSTRAINT subscription_statuses_pkey PRIMARY KEY (id);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: tags tags_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_slug_key UNIQUE (slug);


--
-- Name: template_tags template_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_tags
    ADD CONSTRAINT template_tags_pkey PRIMARY KEY (template_id, tag_id);


--
-- Name: text_styles text_styles_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.text_styles
    ADD CONSTRAINT text_styles_key_key UNIQUE (key);


--
-- Name: text_styles text_styles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.text_styles
    ADD CONSTRAINT text_styles_pkey PRIMARY KEY (id);


--
-- Name: baker_contacts_baker_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_contacts_baker_id_idx ON public.baker_appusers USING btree (baker_id);


--
-- Name: baker_element_exclusions_baker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_element_exclusions_baker_idx ON public.baker_element_exclusions USING btree (baker_id);


--
-- Name: baker_flavour_dietary_custom_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX baker_flavour_dietary_custom_uniq ON public.baker_flavour_dietary_conflicts USING btree (baker_id, baker_flavour_id, requirement_id) WHERE (baker_flavour_id IS NOT NULL);


--
-- Name: baker_flavour_dietary_global_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX baker_flavour_dietary_global_uniq ON public.baker_flavour_dietary_conflicts USING btree (baker_id, flavour_id, requirement_id) WHERE (flavour_id IS NOT NULL);


--
-- Name: baker_flavour_settings_signature_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_flavour_settings_signature_idx ON public.baker_flavour_settings USING btree (baker_id) WHERE is_signature;


--
-- Name: baker_flavours_baker_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX baker_flavours_baker_name_key ON public.baker_flavours USING btree (baker_id, lower(name));


--
-- Name: baker_flavours_signature_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_flavours_signature_idx ON public.baker_flavours USING btree (baker_id) WHERE is_signature;


--
-- Name: baker_owner_phone_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX baker_owner_phone_uidx ON public.baker_appusers USING btree (phone) WHERE (is_primary AND (phone IS NOT NULL));


--
-- Name: baker_storefront_photos_baker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_storefront_photos_baker_idx ON public.baker_storefront_photos USING btree (baker_id, sort_order);


--
-- Name: baker_subscriptions_baker_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_subscriptions_baker_id_idx ON public.baker_subscriptions USING btree (baker_id);


--
-- Name: baker_subscriptions_billing_sub_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_subscriptions_billing_sub_id_idx ON public.baker_subscriptions USING btree (billing_subscription_id);


--
-- Name: baker_subscriptions_current_period_end_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_subscriptions_current_period_end_idx ON public.baker_subscriptions USING btree (current_period_end);


--
-- Name: baker_subscriptions_scheduled_effective_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_subscriptions_scheduled_effective_idx ON public.baker_subscriptions USING btree (scheduled_effective_at) WHERE (scheduled_plan_id IS NOT NULL);


--
-- Name: baker_testimonials_baker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_testimonials_baker_idx ON public.baker_testimonials USING btree (baker_id, sort_order);


--
-- Name: baker_upload_shares_grantee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_upload_shares_grantee_idx ON public.baker_upload_shares USING btree (shared_with_type, shared_with_id);


--
-- Name: baker_uploads_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_uploads_customer_idx ON public.baker_uploads USING btree (for_customer_id) WHERE (for_customer_id IS NOT NULL);


--
-- Name: baker_uploads_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX baker_uploads_tenant_idx ON public.baker_uploads USING btree (baker_id, created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: bakers_auth_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bakers_auth_user_idx ON public.bakers USING btree (auth_user_id);


--
-- Name: bakers_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bakers_is_active_idx ON public.bakers USING btree (is_active);


--
-- Name: bakers_pending_erasure_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bakers_pending_erasure_idx ON public.bakers USING btree (erase_after) WHERE (deletion_status = 1);


--
-- Name: bakers_slug_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bakers_slug_idx ON public.bakers USING btree (slug);


--
-- Name: cake_elements_applicable_zones_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cake_elements_applicable_zones_idx ON public.cake_elements USING gin (applicable_zones);


--
-- Name: cake_elements_baker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cake_elements_baker_idx ON public.cake_elements USING btree (baker_id);


--
-- Name: cake_elements_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cake_elements_customer_idx ON public.cake_elements USING btree (customer_id) WHERE (customer_id IS NOT NULL);


--
-- Name: cake_elements_desc_embed_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cake_elements_desc_embed_idx ON public.cake_elements USING hnsw (description_embedding public.vector_cosine_ops);


--
-- Name: cake_elements_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cake_elements_parent_idx ON public.cake_elements USING btree (parent_id);


--
-- Name: cake_elements_scope_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cake_elements_scope_idx ON public.cake_elements USING btree (baker_id, is_active);


--
-- Name: cake_elements_source_upload_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cake_elements_source_upload_idx ON public.cake_elements USING btree (source_upload_id) WHERE (source_upload_id IS NOT NULL);


--
-- Name: cake_shapes_active_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cake_shapes_active_order ON public.cake_shapes USING btree (is_active, sort_order);


--
-- Name: cake_textures_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cake_textures_active_idx ON public.cake_textures USING btree (is_active, sort_order);


--
-- Name: consent_events_subject_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX consent_events_subject_idx ON public.consent_events USING btree (subject_type, subject_id, document_version_id);


--
-- Name: content_attestations_baker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_attestations_baker_idx ON public.content_attestations USING btree (baker_id, attested_at DESC);


--
-- Name: credit_costs_active_label_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX credit_costs_active_label_uniq ON public.credit_costs USING btree (label) WHERE is_active;


--
-- Name: INDEX credit_costs_active_label_uniq; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.credit_costs_active_label_uniq IS 'Two ACTIVE actions must not share a label — the billing card lists them as a price list, so a duplicate reads as one job at two prices. Inactive rows are exempt: they are history.';


--
-- Name: credit_transactions_baker_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credit_transactions_baker_created_idx ON public.credit_transactions USING btree (baker_id, created_at DESC);


--
-- Name: credit_transactions_idempotency_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX credit_transactions_idempotency_idx ON public.credit_transactions USING btree (idempotency_key) WHERE ((idempotency_key IS NOT NULL) AND (state <> 'released'::text));


--
-- Name: INDEX credit_transactions_idempotency_idx; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.credit_transactions_idempotency_idx IS 'Partial on state <> released: a released reservation is an ATTEMPT, not a result. It keeps its key for the audit trail but stops owning it, so the same element/order can be generated again after a failure. Reserved and committed rows still own their key — that is what stops a redelivered webhook double-crediting.';


--
-- Name: credit_transactions_reserved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX credit_transactions_reserved_idx ON public.credit_transactions USING btree (created_at) WHERE (state = 'reserved'::text);


--
-- Name: customer_invites_baker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_invites_baker_idx ON public.customer_invites USING btree (baker_id);


--
-- Name: customer_invites_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_invites_customer_idx ON public.customer_invites USING btree (customer_id);


--
-- Name: customer_invites_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_invites_status_idx ON public.customer_invites USING btree (status);


--
-- Name: customer_invites_template_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_invites_template_idx ON public.customer_invites USING btree (template_id);


--
-- Name: customers_auth_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customers_auth_user_idx ON public.customers USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);


--
-- Name: customers_baker_auth_user_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX customers_baker_auth_user_uidx ON public.customers USING btree (baker_id, auth_user_id) WHERE (auth_user_id IS NOT NULL);


--
-- Name: customers_baker_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customers_baker_id_idx ON public.customers USING btree (baker_id);


--
-- Name: deletion_requests_baker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deletion_requests_baker_idx ON public.deletion_requests USING btree (baker_id);


--
-- Name: design_sessions_baker_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX design_sessions_baker_status_idx ON public.design_sessions USING btree (baker_id, status_id);


--
-- Name: design_sessions_customer_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX design_sessions_customer_idx ON public.design_sessions USING btree (customer_id);


--
-- Name: design_sessions_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX design_sessions_order_idx ON public.design_sessions USING btree (order_id);


--
-- Name: device_tokens_baker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_tokens_baker_idx ON public.device_tokens USING btree (baker_id);


--
-- Name: device_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX device_tokens_user_idx ON public.device_tokens USING btree (auth_user_id);


--
-- Name: element_candidates_element_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX element_candidates_element_idx ON public.element_candidates USING btree (element_id) WHERE (element_id IS NOT NULL);


--
-- Name: element_candidates_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX element_candidates_job_idx ON public.element_candidates USING btree (job_id);


--
-- Name: element_candidates_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX element_candidates_source_idx ON public.element_candidates USING btree (source_key);


--
-- Name: element_craft_guide_baker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX element_craft_guide_baker_idx ON public.element_craft_guide USING btree (baker_id) WHERE (baker_id IS NOT NULL);


--
-- Name: element_types_one_upload_default; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX element_types_one_upload_default ON public.element_types USING btree (default_for_uploads) WHERE default_for_uploads;


--
-- Name: flavours_name_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX flavours_name_key ON public.flavours USING btree (lower(name));


--
-- Name: idx_bakers_geo; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bakers_geo ON public.bakers USING btree (country, state, city);


--
-- Name: idx_element_tags_element; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_element_tags_element ON public.element_tags USING btree (element_id);


--
-- Name: idx_element_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_element_tags_tag ON public.element_tags USING btree (tag_id);


--
-- Name: idx_tags_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_category ON public.tags USING btree (category) WHERE (is_active = true);


--
-- Name: idx_template_tags_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_tags_tag ON public.template_tags USING btree (tag_id);


--
-- Name: idx_template_tags_tmpl; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_template_tags_tmpl ON public.template_tags USING btree (template_id);


--
-- Name: jobs_baker_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_baker_id_idx ON public.jobs USING btree (baker_id);


--
-- Name: jobs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jobs_status_idx ON public.jobs USING btree (status);


--
-- Name: legal_document_versions_current_uk; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX legal_document_versions_current_uk ON public.legal_document_versions USING btree (doc_key) WHERE is_current;


--
-- Name: materials_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX materials_active_idx ON public.materials USING btree (is_active, sort_order);


--
-- Name: meshy_generations_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX meshy_generations_status_idx ON public.meshy_generations USING btree (status);


--
-- Name: meshy_generations_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX meshy_generations_task_idx ON public.meshy_generations USING btree (meshy_task_id);


--
-- Name: notifications_baker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_baker_idx ON public.notifications USING btree (baker_id, created_at DESC) WHERE (baker_id IS NOT NULL);


--
-- Name: notifications_dedupe_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX notifications_dedupe_key_idx ON public.notifications USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: notifications_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_pending_idx ON public.notifications USING btree (created_at) WHERE (status = 'pending'::public.notification_status);


--
-- Name: notifications_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_status_idx ON public.notifications USING btree (status);


--
-- Name: nozzles_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nozzles_category_idx ON public.nozzles USING btree (category);


--
-- Name: nozzles_is_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nozzles_is_active_idx ON public.nozzles USING btree (is_active);


--
-- Name: nozzles_is_common_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX nozzles_is_common_idx ON public.nozzles USING btree (is_common);


--
-- Name: one_primary_per_baker; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX one_primary_per_baker ON public.baker_appusers USING btree (baker_id) WHERE (is_primary = true);


--
-- Name: order_design_versions_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_design_versions_order_idx ON public.order_design_versions USING btree (order_id, version_no);


--
-- Name: order_dietary_requirements_req_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_dietary_requirements_req_idx ON public.order_dietary_requirements USING btree (requirement_id, order_id);


--
-- Name: order_finished_photos_order_id_sort_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_finished_photos_order_id_sort_order_idx ON public.order_finished_photos USING btree (order_id, sort_order);


--
-- Name: order_reference_photos_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX order_reference_photos_order_idx ON public.order_reference_photos USING btree (order_id, sort_order);


--
-- Name: orders_baker_celebration_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_baker_celebration_idx ON public.orders USING btree (baker_id, celebration) WHERE (celebration IS NOT NULL);


--
-- Name: orders_baker_delivery_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_baker_delivery_date_idx ON public.orders USING btree (baker_id, delivery_date);


--
-- Name: orders_baker_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_baker_id_created_at_idx ON public.orders USING btree (baker_id, created_at DESC);


--
-- Name: orders_baker_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_baker_id_idx ON public.orders USING btree (baker_id);


--
-- Name: orders_baker_occasion_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_baker_occasion_idx ON public.orders USING btree (baker_id, occasion) WHERE (occasion IS NOT NULL);


--
-- Name: orders_baker_recipient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_baker_recipient_idx ON public.orders USING btree (baker_id, recipient) WHERE (recipient IS NOT NULL);


--
-- Name: orders_baker_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_baker_status_idx ON public.orders USING btree (baker_id, status_id);


--
-- Name: orders_baker_tier_count_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_baker_tier_count_idx ON public.orders USING btree (baker_id, tier_count) WHERE (tier_count IS NOT NULL);


--
-- Name: orders_customer_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_customer_id_idx ON public.orders USING btree (customer_id);


--
-- Name: orders_xray_spec_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX orders_xray_spec_idx ON public.orders USING btree (baker_id) WHERE (xray_spec IS NOT NULL);


--
-- Name: patterns_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patterns_active_idx ON public.patterns USING btree (is_active);


--
-- Name: patterns_baker_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patterns_baker_idx ON public.patterns USING btree (baker_id);


--
-- Name: patterns_slug_baker_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patterns_slug_baker_unique ON public.patterns USING btree (slug, baker_id) WHERE (baker_id IS NOT NULL);


--
-- Name: patterns_slug_global_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX patterns_slug_global_unique ON public.patterns USING btree (slug) WHERE (baker_id IS NULL);


--
-- Name: patterns_sort_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patterns_sort_idx ON public.patterns USING btree (sort_order);


--
-- Name: payments_baker_charged_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payments_baker_charged_at_idx ON public.payments USING btree (baker_id, charged_at DESC);


--
-- Name: payments_baker_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payments_baker_id_idx ON public.payments USING btree (baker_id);


--
-- Name: print_sheets_tenant_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX print_sheets_tenant_idx ON public.print_sheets USING btree (baker_id, updated_at DESC);


--
-- Name: subscription_events_baker_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX subscription_events_baker_id_idx ON public.subscription_events USING btree (baker_id);


--
-- Name: text_styles_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX text_styles_active_idx ON public.text_styles USING btree (is_active, sort_order);


--
-- Name: bakers bakers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bakers_updated_at BEFORE UPDATE ON public.bakers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: orders orders_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER orders_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: patterns patterns_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER patterns_updated_at BEFORE UPDATE ON public.patterns FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: admins admins_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: admins admins_role_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admins
    ADD CONSTRAINT admins_role_fkey FOREIGN KEY (role) REFERENCES public.roles(key);


--
-- Name: baker_appusers baker_contacts_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_appusers
    ADD CONSTRAINT baker_contacts_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: baker_appusers baker_contacts_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_appusers
    ADD CONSTRAINT baker_contacts_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: baker_element_exclusions baker_element_exclusions_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_element_exclusions
    ADD CONSTRAINT baker_element_exclusions_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: baker_element_exclusions baker_element_exclusions_element_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_element_exclusions
    ADD CONSTRAINT baker_element_exclusions_element_id_fkey FOREIGN KEY (element_id) REFERENCES public.cake_elements(id) ON DELETE CASCADE;


--
-- Name: baker_flavour_dietary_conflicts baker_flavour_dietary_conflicts_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_flavour_dietary_conflicts
    ADD CONSTRAINT baker_flavour_dietary_conflicts_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: baker_flavour_dietary_conflicts baker_flavour_dietary_conflicts_flavour_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_flavour_dietary_conflicts
    ADD CONSTRAINT baker_flavour_dietary_conflicts_flavour_id_fkey FOREIGN KEY (flavour_id) REFERENCES public.flavours(id) ON DELETE CASCADE;


--
-- Name: baker_flavour_dietary_conflicts baker_flavour_dietary_conflicts_requirement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_flavour_dietary_conflicts
    ADD CONSTRAINT baker_flavour_dietary_conflicts_requirement_id_fkey FOREIGN KEY (requirement_id) REFERENCES public.dietary_requirements(id);


--
-- Name: baker_flavour_dietary_conflicts baker_flavour_dietary_custom_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_flavour_dietary_conflicts
    ADD CONSTRAINT baker_flavour_dietary_custom_fk FOREIGN KEY (baker_flavour_id) REFERENCES public.baker_flavours(id) ON DELETE CASCADE;


--
-- Name: baker_flavour_settings baker_flavour_settings_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_flavour_settings
    ADD CONSTRAINT baker_flavour_settings_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: baker_flavour_settings baker_flavour_settings_flavour_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_flavour_settings
    ADD CONSTRAINT baker_flavour_settings_flavour_id_fkey FOREIGN KEY (flavour_id) REFERENCES public.flavours(id) ON DELETE CASCADE;


--
-- Name: baker_flavours baker_flavours_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_flavours
    ADD CONSTRAINT baker_flavours_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: baker_storefront_photos baker_storefront_photos_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_storefront_photos
    ADD CONSTRAINT baker_storefront_photos_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: baker_subscriptions baker_subscriptions_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_subscriptions
    ADD CONSTRAINT baker_subscriptions_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: baker_subscriptions baker_subscriptions_billing_period_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_subscriptions
    ADD CONSTRAINT baker_subscriptions_billing_period_id_fkey FOREIGN KEY (billing_period_id) REFERENCES public.billing_periods(id);


--
-- Name: baker_subscriptions baker_subscriptions_cancellation_reason_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_subscriptions
    ADD CONSTRAINT baker_subscriptions_cancellation_reason_id_fkey FOREIGN KEY (cancellation_reason_id) REFERENCES public.cancellation_reasons(id);


--
-- Name: baker_subscriptions baker_subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_subscriptions
    ADD CONSTRAINT baker_subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.subscription_plans(id);


--
-- Name: baker_subscriptions baker_subscriptions_scheduled_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_subscriptions
    ADD CONSTRAINT baker_subscriptions_scheduled_plan_id_fkey FOREIGN KEY (scheduled_plan_id) REFERENCES public.subscription_plans(id);


--
-- Name: baker_template_exclusions baker_template_exclusions_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_template_exclusions
    ADD CONSTRAINT baker_template_exclusions_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: baker_template_exclusions baker_template_exclusions_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_template_exclusions
    ADD CONSTRAINT baker_template_exclusions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.cake_templates(id) ON DELETE CASCADE;


--
-- Name: baker_testimonials baker_testimonials_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_testimonials
    ADD CONSTRAINT baker_testimonials_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: baker_upload_shares baker_upload_shares_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_upload_shares
    ADD CONSTRAINT baker_upload_shares_upload_id_fkey FOREIGN KEY (upload_id) REFERENCES public.baker_uploads(id) ON DELETE CASCADE;


--
-- Name: baker_uploads baker_uploads_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_uploads
    ADD CONSTRAINT baker_uploads_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: baker_uploads baker_uploads_for_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.baker_uploads
    ADD CONSTRAINT baker_uploads_for_customer_id_fkey FOREIGN KEY (for_customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: bakers bakers_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bakers
    ADD CONSTRAINT bakers_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: bakers bakers_payment_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bakers
    ADD CONSTRAINT bakers_payment_provider_id_fkey FOREIGN KEY (payment_provider_id) REFERENCES public.payment_providers(id);


--
-- Name: bakers bakers_storefront_theme_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bakers
    ADD CONSTRAINT bakers_storefront_theme_id_fkey FOREIGN KEY (storefront_theme_id) REFERENCES public.storefront_themes(id);


--
-- Name: bakers bakers_subscription_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bakers
    ADD CONSTRAINT bakers_subscription_plan_id_fkey FOREIGN KEY (subscription_plan_id) REFERENCES public.subscription_plans(id);


--
-- Name: bakers bakers_subscription_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bakers
    ADD CONSTRAINT bakers_subscription_status_id_fkey FOREIGN KEY (subscription_status_id) REFERENCES public.subscription_statuses(id);


--
-- Name: cake_elements cake_elements_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_elements
    ADD CONSTRAINT cake_elements_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: cake_elements cake_elements_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_elements
    ADD CONSTRAINT cake_elements_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: cake_elements cake_elements_element_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_elements
    ADD CONSTRAINT cake_elements_element_type_id_fkey FOREIGN KEY (element_type_id) REFERENCES public.element_types(id) ON DELETE SET NULL;


--
-- Name: cake_elements cake_elements_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_elements
    ADD CONSTRAINT cake_elements_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.cake_elements(id) ON DELETE CASCADE;


--
-- Name: cake_elements cake_elements_source_upload_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_elements
    ADD CONSTRAINT cake_elements_source_upload_id_fkey FOREIGN KEY (source_upload_id) REFERENCES public.baker_uploads(id);


--
-- Name: cake_template_attrs cake_template_attrs_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_template_attrs
    ADD CONSTRAINT cake_template_attrs_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.cake_templates(id) ON DELETE CASCADE;


--
-- Name: cake_templates cake_templates_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_templates
    ADD CONSTRAINT cake_templates_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id);


--
-- Name: cake_templates cake_templates_parent_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cake_templates
    ADD CONSTRAINT cake_templates_parent_template_id_fkey FOREIGN KEY (parent_template_id) REFERENCES public.cake_templates(id);


--
-- Name: consent_events consent_events_document_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consent_events
    ADD CONSTRAINT consent_events_document_version_id_fkey FOREIGN KEY (document_version_id) REFERENCES public.legal_document_versions(id);


--
-- Name: content_attestations content_attestations_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_attestations
    ADD CONSTRAINT content_attestations_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: content_attestations content_attestations_document_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_attestations
    ADD CONSTRAINT content_attestations_document_version_id_fkey FOREIGN KEY (document_version_id) REFERENCES public.legal_document_versions(id);


--
-- Name: credit_transactions credit_transactions_action_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_transactions
    ADD CONSTRAINT credit_transactions_action_id_fkey FOREIGN KEY (action_id) REFERENCES public.credit_costs(id);


--
-- Name: credit_transactions credit_transactions_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_transactions
    ADD CONSTRAINT credit_transactions_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: credit_transactions credit_transactions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_transactions
    ADD CONSTRAINT credit_transactions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: credit_transactions credit_transactions_pack_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_transactions
    ADD CONSTRAINT credit_transactions_pack_id_fkey FOREIGN KEY (pack_id) REFERENCES public.credit_packs(id);


--
-- Name: customer_invites customer_invites_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_invites
    ADD CONSTRAINT customer_invites_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: customer_invites customer_invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_invites
    ADD CONSTRAINT customer_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.baker_appusers(id);


--
-- Name: customer_invites customer_invites_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_invites
    ADD CONSTRAINT customer_invites_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE;


--
-- Name: customer_invites customer_invites_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_invites
    ADD CONSTRAINT customer_invites_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.cake_templates(id) ON DELETE SET NULL;


--
-- Name: customers customers_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: customers customers_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customers
    ADD CONSTRAINT customers_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: deletion_requests deletion_requests_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deletion_requests
    ADD CONSTRAINT deletion_requests_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: design_sessions design_sessions_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_sessions
    ADD CONSTRAINT design_sessions_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: design_sessions design_sessions_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_sessions
    ADD CONSTRAINT design_sessions_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE SET NULL;


--
-- Name: design_sessions design_sessions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_sessions
    ADD CONSTRAINT design_sessions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL;


--
-- Name: design_sessions design_sessions_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_sessions
    ADD CONSTRAINT design_sessions_status_id_fkey FOREIGN KEY (status_id) REFERENCES public.design_session_statuses(id);


--
-- Name: device_tokens device_tokens_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tokens
    ADD CONSTRAINT device_tokens_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: element_candidates element_candidates_element_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_candidates
    ADD CONSTRAINT element_candidates_element_id_fkey FOREIGN KEY (element_id) REFERENCES public.cake_elements(id) ON DELETE SET NULL;


--
-- Name: element_candidates element_candidates_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_candidates
    ADD CONSTRAINT element_candidates_job_id_fkey FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;


--
-- Name: element_craft_guide element_craft_guide_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_craft_guide
    ADD CONSTRAINT element_craft_guide_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: element_craft_guide element_craft_guide_element_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_craft_guide
    ADD CONSTRAINT element_craft_guide_element_id_fkey FOREIGN KEY (element_id) REFERENCES public.cake_elements(id) ON DELETE CASCADE;


--
-- Name: element_tags element_tags_element_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_tags
    ADD CONSTRAINT element_tags_element_id_fkey FOREIGN KEY (element_id) REFERENCES public.cake_elements(id) ON DELETE CASCADE;


--
-- Name: element_tags element_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.element_tags
    ADD CONSTRAINT element_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: flavour_dietary_conflicts flavour_dietary_conflicts_flavour_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flavour_dietary_conflicts
    ADD CONSTRAINT flavour_dietary_conflicts_flavour_id_fkey FOREIGN KEY (flavour_id) REFERENCES public.flavours(id) ON DELETE CASCADE;


--
-- Name: flavour_dietary_conflicts flavour_dietary_conflicts_requirement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.flavour_dietary_conflicts
    ADD CONSTRAINT flavour_dietary_conflicts_requirement_id_fkey FOREIGN KEY (requirement_id) REFERENCES public.dietary_requirements(id);


--
-- Name: jobs jobs_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jobs
    ADD CONSTRAINT jobs_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.notification_types(id);


--
-- Name: order_audit_log order_audit_log_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_audit_log
    ADD CONSTRAINT order_audit_log_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id);


--
-- Name: order_audit_log order_audit_log_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_audit_log
    ADD CONSTRAINT order_audit_log_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_design_versions order_design_versions_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_design_versions
    ADD CONSTRAINT order_design_versions_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_dietary_requirements order_dietary_requirements_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_dietary_requirements
    ADD CONSTRAINT order_dietary_requirements_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_dietary_requirements order_dietary_requirements_requirement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_dietary_requirements
    ADD CONSTRAINT order_dietary_requirements_requirement_id_fkey FOREIGN KEY (requirement_id) REFERENCES public.dietary_requirements(id);


--
-- Name: order_finished_photos order_finished_photos_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_finished_photos
    ADD CONSTRAINT order_finished_photos_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_reference_photos order_reference_photos_order_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_reference_photos
    ADD CONSTRAINT order_reference_photos_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;


--
-- Name: order_reference_photos order_reference_photos_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.order_reference_photos
    ADD CONSTRAINT order_reference_photos_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.baker_appusers(id);


--
-- Name: orders orders_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.baker_appusers(id);


--
-- Name: orders orders_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: orders orders_current_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_current_version_id_fkey FOREIGN KEY (current_version_id) REFERENCES public.order_design_versions(id);


--
-- Name: orders orders_customer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id);


--
-- Name: orders orders_quoted_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_quoted_version_id_fkey FOREIGN KEY (quoted_version_id) REFERENCES public.order_design_versions(id);


--
-- Name: orders orders_status_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.orders
    ADD CONSTRAINT orders_status_id_fkey FOREIGN KEY (status_id) REFERENCES public.order_statuses(id);


--
-- Name: patterns patterns_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patterns
    ADD CONSTRAINT patterns_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: payments payments_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: payments payments_baker_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_baker_subscription_id_fkey FOREIGN KEY (baker_subscription_id) REFERENCES public.baker_subscriptions(id);


--
-- Name: payments payments_credit_pack_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_credit_pack_id_fkey FOREIGN KEY (credit_pack_id) REFERENCES public.credit_packs(id);


--
-- Name: print_sheets print_sheets_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.print_sheets
    ADD CONSTRAINT print_sheets_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: role_capabilities role_capabilities_capability_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_capabilities
    ADD CONSTRAINT role_capabilities_capability_key_fkey FOREIGN KEY (capability_key) REFERENCES public.capabilities(key) ON DELETE CASCADE;


--
-- Name: role_capabilities role_capabilities_role_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_capabilities
    ADD CONSTRAINT role_capabilities_role_key_fkey FOREIGN KEY (role_key) REFERENCES public.roles(key) ON DELETE CASCADE;


--
-- Name: subscription_events subscription_events_baker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_events
    ADD CONSTRAINT subscription_events_baker_id_fkey FOREIGN KEY (baker_id) REFERENCES public.bakers(id) ON DELETE CASCADE;


--
-- Name: template_tags template_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_tags
    ADD CONSTRAINT template_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE CASCADE;


--
-- Name: template_tags template_tags_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.template_tags
    ADD CONSTRAINT template_tags_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.cake_templates(id) ON DELETE CASCADE;


--
-- Name: flavours Authenticated users can delete flavours; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can delete flavours" ON public.flavours FOR DELETE USING ((auth.role() = 'authenticated'::text));


--
-- Name: flavours Authenticated users can update flavours; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can update flavours" ON public.flavours FOR UPDATE USING ((auth.role() = 'authenticated'::text));


--
-- Name: cake_template_attrs Manage own template attrs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Manage own template attrs" ON public.cake_template_attrs TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.cake_templates ct
     JOIN public.baker_appusers bu ON ((bu.auth_user_id = auth.uid())))
  WHERE ((ct.id = cake_template_attrs.template_id) AND (ct.baker_id = bu.baker_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.cake_templates ct
     JOIN public.baker_appusers bu ON ((bu.auth_user_id = auth.uid())))
  WHERE ((ct.id = cake_template_attrs.template_id) AND (ct.baker_id = bu.baker_id)))));


--
-- Name: template_tags Manage own template tags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Manage own template tags" ON public.template_tags TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.cake_templates ct
     JOIN public.baker_appusers bu ON ((bu.auth_user_id = auth.uid())))
  WHERE ((ct.id = template_tags.template_id) AND (ct.baker_id = bu.baker_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.cake_templates ct
     JOIN public.baker_appusers bu ON ((bu.auth_user_id = auth.uid())))
  WHERE ((ct.id = template_tags.template_id) AND (ct.baker_id = bu.baker_id)))));


--
-- Name: cake_template_attrs Read template attrs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read template attrs" ON public.cake_template_attrs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.cake_templates ct
     JOIN public.baker_appusers bu ON ((bu.auth_user_id = auth.uid())))
  WHERE ((ct.id = cake_template_attrs.template_id) AND ((ct.baker_id IS NULL) OR (ct.baker_id = bu.baker_id))))));


--
-- Name: template_tags Read template tags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read template tags" ON public.template_tags FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM (public.cake_templates ct
     JOIN public.baker_appusers bu ON ((bu.auth_user_id = auth.uid())))
  WHERE ((ct.id = template_tags.template_id) AND ((ct.baker_id IS NULL) OR (ct.baker_id = bu.baker_id))))));


--
-- Name: admins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;

--
-- Name: cake_templates authenticated insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated insert" ON public.cake_templates FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: cake_elements authenticated read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated read" ON public.cake_elements FOR SELECT TO authenticated USING (true);


--
-- Name: cake_templates authenticated read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "authenticated read" ON public.cake_templates FOR SELECT TO authenticated USING (true);


--
-- Name: baker_appusers baker can delete own contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can delete own contacts" ON public.baker_appusers FOR DELETE USING ((baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.auth_user_id = auth.uid()))));


--
-- Name: cake_elements baker can delete own elements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can delete own elements" ON public.cake_elements FOR DELETE USING ((baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.auth_user_id = auth.uid()))));


--
-- Name: baker_element_exclusions baker can delete own exclusions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can delete own exclusions" ON public.baker_element_exclusions FOR DELETE USING ((baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.auth_user_id = auth.uid()))));


--
-- Name: patterns baker can delete own patterns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can delete own patterns" ON public.patterns FOR DELETE USING ((baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.auth_user_id = auth.uid()))));


--
-- Name: baker_appusers baker can insert own contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can insert own contacts" ON public.baker_appusers FOR INSERT WITH CHECK ((baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.auth_user_id = auth.uid()))));


--
-- Name: cake_elements baker can insert own elements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can insert own elements" ON public.cake_elements FOR INSERT WITH CHECK ((baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.auth_user_id = auth.uid()))));


--
-- Name: baker_element_exclusions baker can insert own exclusions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can insert own exclusions" ON public.baker_element_exclusions FOR INSERT WITH CHECK ((baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.auth_user_id = auth.uid()))));


--
-- Name: patterns baker can insert own patterns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can insert own patterns" ON public.patterns FOR INSERT WITH CHECK ((baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.auth_user_id = auth.uid()))));


--
-- Name: baker_appusers baker can read own contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can read own contacts" ON public.baker_appusers FOR SELECT USING ((baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.auth_user_id = auth.uid()))));


--
-- Name: baker_element_exclusions baker can read own exclusions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can read own exclusions" ON public.baker_element_exclusions FOR SELECT USING ((baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.auth_user_id = auth.uid()))));


--
-- Name: bakers baker can read own row; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can read own row" ON public.bakers FOR SELECT USING ((auth.uid() = auth_user_id));


--
-- Name: cake_elements baker can update own elements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can update own elements" ON public.cake_elements FOR UPDATE USING ((baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.auth_user_id = auth.uid()))));


--
-- Name: patterns baker can update own patterns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can update own patterns" ON public.patterns FOR UPDATE USING ((baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.auth_user_id = auth.uid()))));


--
-- Name: bakers baker can update own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker can update own profile" ON public.bakers FOR UPDATE USING ((auth.uid() = auth_user_id)) WITH CHECK ((auth.uid() = auth_user_id));


--
-- Name: cake_elements baker customers can read baker elements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker customers can read baker elements" ON public.cake_elements FOR SELECT USING (((baker_id IS NOT NULL) AND (is_active = true) AND (baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.is_active = true)))));


--
-- Name: patterns baker customers can read baker patterns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "baker customers can read baker patterns" ON public.patterns FOR SELECT USING (((baker_id IS NOT NULL) AND (is_active = true) AND (baker_id IN ( SELECT bakers.id
   FROM public.bakers
  WHERE (bakers.is_active = true)))));


--
-- Name: baker_appusers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.baker_appusers ENABLE ROW LEVEL SECURITY;

--
-- Name: baker_element_exclusions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.baker_element_exclusions ENABLE ROW LEVEL SECURITY;

--
-- Name: baker_flavour_dietary_conflicts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.baker_flavour_dietary_conflicts ENABLE ROW LEVEL SECURITY;

--
-- Name: baker_flavour_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.baker_flavour_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: baker_flavours; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.baker_flavours ENABLE ROW LEVEL SECURITY;

--
-- Name: baker_storefront_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.baker_storefront_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: baker_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.baker_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: baker_template_exclusions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.baker_template_exclusions ENABLE ROW LEVEL SECURITY;

--
-- Name: baker_testimonials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.baker_testimonials ENABLE ROW LEVEL SECURITY;

--
-- Name: baker_upload_shares; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.baker_upload_shares ENABLE ROW LEVEL SECURITY;

--
-- Name: baker_uploads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.baker_uploads ENABLE ROW LEVEL SECURITY;

--
-- Name: bakers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bakers ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_outbox; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_outbox ENABLE ROW LEVEL SECURITY;

--
-- Name: billing_periods; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.billing_periods ENABLE ROW LEVEL SECURITY;

--
-- Name: cake_elements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cake_elements ENABLE ROW LEVEL SECURITY;

--
-- Name: cake_shapes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cake_shapes ENABLE ROW LEVEL SECURITY;

--
-- Name: cake_shapes cake_shapes readable by authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cake_shapes readable by authenticated" ON public.cake_shapes FOR SELECT TO authenticated USING (true);


--
-- Name: cake_shapes cake_shapes writable by authenticated; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "cake_shapes writable by authenticated" ON public.cake_shapes TO authenticated USING (true) WITH CHECK (true);


--
-- Name: cake_template_attrs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cake_template_attrs ENABLE ROW LEVEL SECURITY;

--
-- Name: cake_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cake_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: cake_textures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cake_textures ENABLE ROW LEVEL SECURITY;

--
-- Name: cake_textures cake_textures_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cake_textures_read ON public.cake_textures FOR SELECT TO authenticated USING (true);


--
-- Name: cake_textures cake_textures_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cake_textures_write ON public.cake_textures TO authenticated USING (true) WITH CHECK (true);


--
-- Name: cancellation_reasons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cancellation_reasons ENABLE ROW LEVEL SECURITY;

--
-- Name: capabilities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.capabilities ENABLE ROW LEVEL SECURITY;

--
-- Name: consent_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.consent_events ENABLE ROW LEVEL SECURITY;

--
-- Name: content_attestations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.content_attestations ENABLE ROW LEVEL SECURITY;

--
-- Name: bakers create baker on onboarding; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "create baker on onboarding" ON public.bakers FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: baker_appusers create own contact; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "create own contact" ON public.baker_appusers FOR INSERT TO authenticated WITH CHECK ((auth_user_id = auth.uid()));


--
-- Name: credit_costs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_costs ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_packs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_packs ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: customer_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customer_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: customers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;

--
-- Name: deletion_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deletion_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: design_session_statuses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.design_session_statuses ENABLE ROW LEVEL SECURITY;

--
-- Name: design_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.design_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: device_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.device_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: dietary_requirements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dietary_requirements ENABLE ROW LEVEL SECURITY;

--
-- Name: element_action_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.element_action_types ENABLE ROW LEVEL SECURITY;

--
-- Name: element_candidates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.element_candidates ENABLE ROW LEVEL SECURITY;

--
-- Name: element_craft_guide; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.element_craft_guide ENABLE ROW LEVEL SECURITY;

--
-- Name: element_craft_guide element_craft_guide_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY element_craft_guide_delete ON public.element_craft_guide FOR DELETE TO authenticated USING (true);


--
-- Name: element_craft_guide element_craft_guide_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY element_craft_guide_insert ON public.element_craft_guide FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: element_craft_guide element_craft_guide_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY element_craft_guide_read ON public.element_craft_guide FOR SELECT TO authenticated USING (true);


--
-- Name: element_craft_guide element_craft_guide_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY element_craft_guide_update ON public.element_craft_guide FOR UPDATE TO authenticated USING (true);


--
-- Name: element_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.element_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: element_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.element_types ENABLE ROW LEVEL SECURITY;

--
-- Name: element_types element_types public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "element_types public read" ON public.element_types FOR SELECT USING ((is_active = true));


--
-- Name: flavour_dietary_conflicts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.flavour_dietary_conflicts ENABLE ROW LEVEL SECURITY;

--
-- Name: flavours; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.flavours ENABLE ROW LEVEL SECURITY;

--
-- Name: jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: legal_document_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.legal_document_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: materials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.materials ENABLE ROW LEVEL SECURITY;

--
-- Name: materials materials_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY materials_read ON public.materials FOR SELECT TO authenticated USING (true);


--
-- Name: materials materials_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY materials_write ON public.materials TO authenticated USING (true) WITH CHECK (true);


--
-- Name: meshy_generations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.meshy_generations ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_types ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: nozzles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.nozzles ENABLE ROW LEVEL SECURITY;

--
-- Name: nozzles nozzles_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY nozzles_delete ON public.nozzles FOR DELETE TO authenticated USING (true);


--
-- Name: nozzles nozzles_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY nozzles_insert ON public.nozzles FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: nozzles nozzles_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY nozzles_read ON public.nozzles FOR SELECT TO authenticated USING (true);


--
-- Name: nozzles nozzles_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY nozzles_update ON public.nozzles FOR UPDATE TO authenticated USING (true);


--
-- Name: order_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: order_design_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_design_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: order_dietary_requirements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_dietary_requirements ENABLE ROW LEVEL SECURITY;

--
-- Name: order_finished_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_finished_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: order_reference_photos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_reference_photos ENABLE ROW LEVEL SECURITY;

--
-- Name: order_statuses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.order_statuses ENABLE ROW LEVEL SECURITY;

--
-- Name: orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;

--
-- Name: patterns; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patterns ENABLE ROW LEVEL SECURITY;

--
-- Name: payment_providers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

--
-- Name: print_sheets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.print_sheets ENABLE ROW LEVEL SECURITY;

--
-- Name: cake_elements public can read global active elements; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public can read global active elements" ON public.cake_elements FOR SELECT USING (((baker_id IS NULL) AND (is_active = true)));


--
-- Name: patterns public can read global active patterns; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public can read global active patterns" ON public.patterns FOR SELECT USING (((baker_id IS NULL) AND (is_active = true)));


--
-- Name: role_capabilities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.role_capabilities ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: storefront_themes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.storefront_themes ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_events ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_statuses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_statuses ENABLE ROW LEVEL SECURITY;

--
-- Name: tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;

--
-- Name: template_tags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.template_tags ENABLE ROW LEVEL SECURITY;

--
-- Name: text_styles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.text_styles ENABLE ROW LEVEL SECURITY;

--
-- Name: text_styles text_styles_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY text_styles_read ON public.text_styles FOR SELECT TO authenticated USING (true);


--
-- Name: text_styles text_styles_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY text_styles_write ON public.text_styles TO authenticated USING (true) WITH CHECK (true);


--
-- Name: baker_appusers update own contact; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "update own contact" ON public.baker_appusers FOR UPDATE TO authenticated USING ((auth_user_id = auth.uid()));


--
-- Name: baker_appusers users can read own row; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "users can read own row" ON public.baker_appusers FOR SELECT TO authenticated USING ((auth_user_id = auth.uid()));


--
-- PostgreSQL database dump complete
--




-- ══ POSTAMBLE — added by scripts/dump-schema.mjs, NOT from pg_dump ──────────────────────────────
--
-- Scheduled jobs live in the `cron` schema, so a public-only dump silently drops them.
-- This is the failure that does not announce itself: the restore succeeds, the app works,
-- and notifications grow without bound until someone goes looking.
--
-- Re-running cron.schedule with an existing job name UPDATES it, so this is idempotent.

select cron.schedule('purge-old-notifications', '17 3 * * *', 'SELECT purge_old_notifications(90);');

-- ══ end ─────────────────────────────────────────────────────────────────────────────────────────
