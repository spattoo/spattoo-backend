-- ── Which campaign produced this baker ───────────────────────────────────────────────────────────
--
-- Sandeep is running WhatsApp campaigns to bakers scraped from Google Maps (spattoo-leads), 50 at a
-- time, each batch carrying a different message and a different city. The AiSensy package on this
-- account does not surface replies, so the tap on the message button is the ONLY signal that comes
-- back — and a tap is a visit, not a signup.
--
-- ⚠️ A VISIT IS NOT THE NUMBER ANYONE CARES ABOUT. GA4 already counts landings on the marketing
-- site by campaign, and that much needed no schema at all. The question a 50-lead batch is actually
-- asking is "how many of them opened a bakery", and after that "how many of those started paying" —
-- which is `bakers.first_paid_at` (migration 024), on this row. So the tag belongs here, beside it,
-- rather than in a side table that would have to be joined for a strictly one-to-one fact.
--
-- ⚠️ FIRST TOUCH, WRITTEN ONCE, NEVER UPDATED. This records where an account CAME FROM, which is a
-- fact about its birth. A second table with a row per touch is the right shape for multi-touch
-- attribution over months of advertising; it is the wrong shape for the question above, and the
-- cost of getting there later is one migration that nobody is forced to pay today.
--
-- ⚠️ NULL IS THE NORMAL CASE AND MEANS "WE DO NOT KNOW", not "direct". Every baker who exists today
-- gets null, an admin-onboarded baker gets null (nobody campaigned at them), and so does anyone
-- whose tag was lost on the way — the signup journey crosses an email confirmation and a phone OTP,
-- and a baker who confirms their email in a different browser arrives with nothing to carry. Read
-- these columns as a floor on what a campaign produced, never as a census.
--
-- ⚠️ THE VALUES COME FROM A URL, SO THEY ARE NOT TRUSTED. Anyone can type anything into
-- ?c=; the API narrows them to a short slug before they ever reach this table (see
-- routes/bakers.js), because these are read back in admin and a campaign tag is not a place to
-- discover that someone pasted markup.

alter table bakers add column if not exists signup_source   text;
alter table bakers add column if not exists signup_campaign text;

comment on column bakers.signup_source   is
  'Where this account came from, first touch, written once at self-signup. Lowercase slug, e.g. "whatsapp". Null = unknown (admin-onboarded, pre-dates this, or the tag was lost crossing email confirmation).';
comment on column bakers.signup_campaign is
  'Which campaign batch produced this account, first touch, written once at self-signup. Lowercase slug, e.g. "bakers_hyderabad". Null = unknown.';

-- Campaign reporting always asks "this batch, and what became of it", so the index is on the tag
-- and nothing else: the batches are small and few, and a composite with first_paid_at would be a
-- second thing to maintain for a query that reads a handful of rows either way.
create index if not exists bakers_signup_campaign_idx
  on bakers (signup_campaign)
  where signup_campaign is not null;
