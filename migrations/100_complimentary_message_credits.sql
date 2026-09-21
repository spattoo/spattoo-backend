-- ── 100: an admin can hand a baker message credits, on the house ────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Three ways a baker's message balance could move before this, and none of them is us deciding to
-- give somebody something: they bought a pack (`purchase`), their subscription activated for the
-- first time (`welcome`, 099, once ever), or a notification went out (`debit`). Anything else — a
-- goodwill gesture after a bad week, a promise made on a support call, an onboarding push for a
-- baker who has not tried customer updates — had no way to happen at all.
--
-- ⚠️ A KIND OF ITS OWN, AND NOT ONE OF THE FOUR THAT EXIST. Each of them already means something
-- else, and a baker reads these words in their own history:
--
--   'welcome'      one per bakery, forever (partial unique index, 099). A second gift is not a
--                  second welcome, and the index would refuse it anyway.
--   'adjustment'   a CORRECTION of ours — we got the arithmetic wrong and are putting it right.
--                  099 says so out loud. A gift labelled "adjustment" tells the baker we made a
--                  mistake, which is the opposite of the thing being said.
--   'purchase'     they paid. Labelling a gift as a purchase is a lie about their own money, and
--                  it would net into any "what have I spent" sum we ever write.
--   'refund'       money back for something that went wrong.
--
-- So: 'complimentary'. It reads correctly on its own in a list, which is the whole test.
alter table message_transactions drop constraint if exists message_transactions_kind_check;
alter table message_transactions
  add constraint message_transactions_kind_check
  check (kind in ('purchase', 'debit', 'refund', 'adjustment', 'welcome', 'complimentary'));

-- ── Why, and who said so ────────────────────────────────────────────────────────────────────────
-- ⚠️ THE QUESTION THIS TABLE EXISTS TO ANSWER IS "WHERE DID MY MESSAGES GO" (098), and a gift is the
-- one row where the answer is not in the row itself. A purchase names its pack, a debit names the
-- notification and the recipient; a complimentary grant names nothing, so six weeks later neither
-- the baker nor support can tell whether it was an apology, a promotion or a typo.
--
-- `granted_by` mirrors subscription_events.changed_by_id: the auth user id, no foreign key, because
-- an admin leaving must not cascade away the record of what they did. The email rides along for the
-- same reason — it is the readable half, and it must survive the account it came from.
alter table message_transactions add column if not exists note             text;
alter table message_transactions add column if not exists granted_by       uuid;
alter table message_transactions add column if not exists granted_by_email text;

comment on column message_transactions.note is
  'Why a complimentary grant or an adjustment was made, in an admin''s own words. Never shown to '
  'the customer; shown to the baker only if a ledger screen ever renders it.';

-- ── The baker is told ───────────────────────────────────────────────────────────────────────────
-- Credits that appear with no explanation are credits a baker does not trust and does not spend.
-- Audience 'baker' is the default; stated anyway, because `setMessageSettings` filters on this
-- column and a customer-audience row here would appear in the list of updates a baker can PAY to
-- send — a notification about a gift, charged to the person receiving it.
insert into notification_types (slug, label, audience) values
  ('message_credits_complimentary', 'Message credits — complimentary top-up', 'baker')
on conflict (slug) do nothing;

-- ⚠️ EMAIL ONLY, MATCHING 095's SEED RULE: push is on for exactly the four types buildPush() writes
-- text for, and this is not one of them. `check:push-copy` keeps that list short on purpose — a push
-- interrupts a baker, and a gift is the clearest case of news that can wait for their inbox. No SMS
-- or WhatsApp row at all: those need an approved template we have not asked for, and spending real
-- money to announce a gift of message credits would cost more than the gift.
insert into notification_channels (type_id, channel, enabled)
select id, 'email', true from notification_types
 where slug = 'message_credits_complimentary'
on conflict (type_id, channel) do nothing;

-- Expect: one new type, one channel row, and six allowed kinds.
select slug, audience from notification_types where slug = 'message_credits_complimentary';
select c.channel, c.enabled from notification_channels c
  join notification_types t on t.id = c.type_id
 where t.slug = 'message_credits_complimentary';
