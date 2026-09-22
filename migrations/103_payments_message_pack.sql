-- ── 103: which payments were MESSAGE top-ups ────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- 033 gave payments a `credit_pack_id` so a smart-tool top-up could be told apart from a plan
-- charge, and its header states the reason plainly: "did I pay for that?" is exactly the question a
-- payment history exists to answer. Message packs shipped later (098) and never got the same
-- column, so a message top-up lands in that list as a bare amount — a ₹59 sitting under a ₹2,948.82
-- plan charge with nothing to say what it bought. Found on production 2026-09-22, on the first real
-- message pack ever sold.
--
-- ── WHY A SECOND COLUMN RATHER THAN ONE `pack_id` + A `kind` ────────────────────────
-- credit_pack_id already exists and is a real foreign key. Collapsing both into one nullable id
-- would need a `kind` beside it to say which table that id points at — a foreign key the database
-- cannot enforce, on the row that decides what an invoice says. Two narrow FKs, each NULL on nearly
-- every row, cost less than one unenforceable one.
--
-- ⚠️ `integer`, NOT 033's `smallint`. message_packs.id is `serial` (int4) where credit_packs.id is
-- smallint, and an FK column must match the type it references. Copying 033's smallint here would
-- work for years and then fail on an insert nobody was watching.
alter table payments add column if not exists message_pack_id integer references message_packs (id);

comment on column payments.message_pack_id is
  'Set when this payment bought a message pack; NULL for a subscription charge or an AI credit '
  'top-up. Presence identifies the row as a message top-up and the value names the pack — the count '
  'and label are read from message_packs so they cannot drift.';

-- ── Backfill: the packs already sold ────────────────────────────────────────────────
-- message_transactions is written by the webhook BEFORE the payment row, and a purchase carries
-- both the Razorpay payment id and the pack key — so every top-up already taken can be labelled
-- from the ledger rather than guessed from the amount, which GST makes ambiguous anyway.
--
-- Idempotent: only fills rows still NULL, so re-running this file cannot overwrite a later
-- correction. `kind = 'purchase'` because a debit or refund row also carries a pack_key and joining
-- one would label the payment with a pack it did not buy.
update payments p
   set message_pack_id = mp.id
  from message_transactions mt
  join message_packs mp on mp.pack_key = mt.pack_key
 where mt.payment_id = p.razorpay_payment_id
   and mt.kind = 'purchase'
   and p.message_pack_id is null;
