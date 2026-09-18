-- ── Paid customer messages: what a baker chose, and what they have left ──────────────────────────
--
-- Customer updates by SMS and WhatsApp are OPTIONAL and the baker pays for them. Email stays free and
-- always works, so a baker who never recharges loses nothing — which is the whole reason this can be
-- charged for at all without it reading as a toll (plans/message-recharge.md).
--
-- ── WHY A SEPARATE LEDGER AND NOT credit_transactions ────────────────────────────────────────────
--
-- AI credits already have a ledger, and reusing it was the obvious move. Two reasons not to:
--
--   1. A MESSAGE IS A DIFFERENT UNIT, and the baker has to understand what they are buying. "300
--      messages" needs no conversion; "300 credits" needs a table saying what a message costs. The
--      settings screen says "1 message per order", and that only stays true with its own unit.
--   2. credit_transactions carries an ALLOWANCE/WALLET split because a plan grants credits monthly.
--      Messages are purchased only — there is no monthly grant, nothing resets — so half that table's
--      design would sit unused, and its sign/kind constraints and RPCs would have to grow a case
--      that means "not that kind of credit". Changing a table the billing path depends on, to model
--      something it does not model, is the expensive kind of reuse.
--
-- What IS shared is the shape: a ledger that is the source of truth, and a balance that is a SUM
-- rather than a column. A stored balance and a ledger disagree eventually, and the disagreement is
-- always discovered by a baker who paid for messages they cannot send.

-- ── What the baker chose to send ────────────────────────────────────────────────────────────────
create table if not exists baker_message_settings (
  baker_id      uuid primary key references bakers(id) on delete cascade,
  -- Notification type slugs the baker wants on a PAID channel. Everything not listed still goes by
  -- email and push, which cost nothing.
  --
  -- ⚠️ DEFAULTS TO THE TWO THAT STALL AN ORDER IF UNSEEN — a quote nobody sees is an order that dies,
  -- and a cake nobody collects is a cake on the shelf. Everything else (order placed, confirmed,
  -- design updated, completed) asks the customer for nothing and is off unless they turn it on.
  enabled_types text[]      not null default array['quote_issued_customer', 'order_ready_customer'],
  updated_at    timestamptz not null default now()
);

comment on column baker_message_settings.enabled_types is
  'notification_types.slug values the baker pays to send on SMS/WhatsApp. Not a foreign key: a slug '
  'that disappears should make a setting inert, never block a delete of the type or the baker.';

-- ── What a recharge costs ───────────────────────────────────────────────────────────────────────
-- Admin-authored, exactly as credit_packs is: a price that only changes by deploy is in the wrong
-- place (root CLAUDE.md rule 3).
create table if not exists message_packs (
  id          serial primary key,
  pack_key    text    not null unique,
  messages    integer not null check (messages > 0),
  -- ⚠️ BASE price, GST-EXCLUSIVE, like subscription_plans and credit_packs. lib/gst.js: "every price
  -- we STORE is the BASE". Charging the base collects 18% too little and the accounting service
  -- issues an invoice for money nobody took.
  price_paise integer not null check (price_paise > 0),
  label       text    not null,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  updated_at  timestamptz not null default now()
);

-- Sized on SMS (Rs. 0.25/message, the rate on our own MSG91 account) rather than WhatsApp (~Rs. 0.145),
-- because WE choose the channel: pricing on the cheaper one loses money every time the SMS fallback
-- fires. WhatsApp sends are simply better margin. Planning cost Rs. 0.275 — Rs. 0.25 plus 10% for
-- two-segment messages, since our templates run 148-157 characters against a 160 limit.
insert into message_packs (pack_key, messages, price_paise, label, sort_order) values
  ('msg_110',   110,  5000, 'Starter',  1),
  ('msg_225',   225, 10000, 'Standard', 2),
  ('msg_600',   600, 25000, 'Value',    3),
  ('msg_1250', 1250, 50000, 'Bulk',     4)
on conflict (pack_key) do nothing;

-- ── The ledger ──────────────────────────────────────────────────────────────────────────────────
create table if not exists message_transactions (
  id           uuid primary key default gen_random_uuid(),
  baker_id     uuid        not null references bakers(id) on delete cascade,
  kind         text        not null check (kind in ('purchase', 'debit', 'refund', 'adjustment')),
  -- Signed: a purchase adds, a debit subtracts. The balance is sum(messages), so the sign IS the
  -- arithmetic and there is no second place that could disagree about direction.
  messages     integer     not null,
  -- What it was for. A purchase names the pack; a debit names the notification it sent and to whom,
  -- because "where did my messages go" is the question this table exists to answer.
  pack_key     text,
  type_slug    text,
  channel      text        check (channel in ('sms', 'whatsapp')),
  recipient    text,
  -- The payment behind a purchase, so a row can be tied back to an invoice.
  payment_id   text,
  created_at   timestamptz not null default now(),

  constraint message_transactions_sign_matches_kind
    check ((kind = 'debit' and messages < 0) or (kind <> 'debit' and messages <> 0))
);

-- The only two reads: a baker's balance (sum over their rows) and their history (newest first).
create index if not exists message_transactions_baker_idx
  on message_transactions (baker_id, created_at desc);

-- ⚠️ One row per payment, so a webhook delivered twice cannot mint messages twice. Partial, because
-- only a purchase has a payment id and NULLs do not collide in a unique index.
create unique index if not exists message_transactions_payment_idx
  on message_transactions (payment_id) where payment_id is not null;

comment on table message_transactions is
  'Source of truth for a baker''s message balance. The balance is sum(messages), never a stored '
  'column: the two disagree eventually and it is always found by a baker who paid for messages they '
  'cannot send.';
