-- ── 027: a customer may have a phone and no email ───────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHAT WAS BROKEN ─────────────────────────────────────────────────────────────────
-- Every manual order for a phone-only customer returned 500. The API has always accepted
-- either contact method (routes/orders.js POST /orders/manual):
--
--     if (!customer?.phone && !customer?.email)
--       return res.status(400).json({ error: 'customer.phone or customer.email is required' });
--
-- ...and the New Order form marks email optional to match. But upsertCustomer then inserts
-- `email: null`, and customers.email was NOT NULL — so the API's own contract and the table
-- disagreed, and the most ordinary manual order there is (baker takes it over the phone,
-- never learns an email) was the one that could never be saved.
--
-- The NOT NULL was right when customers only ever arrived through the public order form,
-- where email is the identity and the confirmation goes to it. It stopped being right the
-- moment a baker could write down a walk-in.
--
-- FIXING THE DB, NOT THE CODE, IS THE POINT. The alternative — having upsertCustomer
-- fabricate a placeholder like `unknown+<uuid>@spattoo.invalid` — would satisfy the
-- constraint and poison everything downstream: the notification path would address real
-- mail to it, dedupe would treat every walk-in as a distinct person, and any future export
-- or campaign would carry the junk outward. A customer with no email is a fact about the
-- world, and the column should be able to say so.
alter table customers alter column email drop not null;

-- The invariant the API enforces, moved to where it cannot be bypassed. Dropping NOT NULL
-- alone permits a row with NEITHER contact method — a customer nobody can reach, which no
-- code path intends to create and which would surface much later as an order that cannot be
-- confirmed. Every current write goes through upsertCustomer and already satisfies this;
-- the constraint is here so a future one does too.
--
-- NOT VALID: enforced for every new and updated row immediately, without a full-table scan
-- that would block writes. Validate separately once existing rows are known clean:
--
--     select count(*) from customers where email is null and phone is null;   -- expect 0
--     alter table customers validate constraint customers_contact_chk;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'customers_contact_chk') then
    alter table customers add constraint customers_contact_chk
      check (email is not null or phone is not null) not valid;
  end if;
end $$;

comment on column customers.email is
  'Nullable since 027: a baker''s walk-in customer may only ever give a phone number. customers_contact_chk guarantees at least one of email/phone is present.';
