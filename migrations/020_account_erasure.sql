-- ── 020: account erasure lifecycle (DPDP Act 2023 "Layer 3") ────────────────────────
-- The Data Principal's §12 erasure right for the CONTRACT-based baker relationship (consent
-- withdrawal for consent-based processing is handled by the append-only consent_events log from
-- 019 — a withdrawal is just a new row there). Design + rationale:
-- docs/CONSENT_WITHDRAWAL_AND_ERASURE_PLAN.md.
--
-- Deletion is a LIFECYCLE, never an instant hard DELETE: soft-delete now → retention hold →
-- 48h pre-erasure notice → scheduled erasure/anonymization (BullMQ cron). Statutory records
-- (GST invoices in spattoo-accounting) are NOT erased by this flow.
--
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.

-- ── 1. bakers: erasure state ────────────────────────────────────────────────────────
-- deletion_status is a COMPACT SURROGATE smallint enum (0=active,1=pending_erasure,2=erased),
-- translated at the API boundary (src/constants/accountDeletion.js) — never a text label on the
-- hot bakers row. erase_after is the instant the erasure job may run; the reversal window is
-- [requested, erase_after).
alter table bakers add column if not exists deletion_status       smallint    not null default 0;
alter table bakers add column if not exists deletion_requested_at timestamptz;
alter table bakers add column if not exists erase_after           timestamptz;
alter table bakers add column if not exists notice_sent_at        timestamptz;

-- Hot access pattern is the erasure sweep's EXACT query: "rows due for erasure/notice". A partial
-- index over only pending_erasure rows keeps it tiny (active bakers — the overwhelming majority —
-- are not indexed here).
create index if not exists bakers_pending_erasure_idx
  on bakers (erase_after) where deletion_status = 1;

-- ── 2. deletion_requests: append-only audit of erasure requests ─────────────────────
-- Bounded by delete EVENTS (not a hot per-order table), but modelled for growth all the same.
-- Kept forever as PROOF the request was handled lawfully (like consent_events) — survives the
-- erasure it records. requested_by = auth_user_id of the owner who asked.
create table if not exists deletion_requests (
  id             bigserial   primary key,
  baker_id       uuid        not null references bakers (id) on delete cascade,
  requested_by   uuid        not null,           -- auth_user_id (the owner)
  reason         text,
  ip             inet,
  requested_at   timestamptz not null default now(),
  erase_after    timestamptz not null,           -- snapshot of the window at request time
  notice_sent_at timestamptz,
  cancelled_at   timestamptz,                     -- set if the baker restores before erase_after
  erased_at      timestamptz                      -- set by the erasure job when it completes
);
create index if not exists deletion_requests_baker_idx on deletion_requests (baker_id);

-- ── 3. RBAC: a dedicated capability for account deletion (owner-only) ────────────────
-- Deleting the whole baker is destructive + governance-level; it is NOT folded into
-- 'store:manage'. Granted to `owner` only — staff cannot delete the baker. `admin` is_super
-- holds it implicitly (no explicit grant, per rbac_tables.sql).
insert into capabilities (key, label, description, category, is_sensitive, sort_order) values
  ('account:delete', 'Delete account', 'Request erasure of the baker account & its data', 'baker', true, 17)
on conflict (key) do nothing;

insert into role_capabilities (role_key, capability_key) values
  ('owner', 'account:delete')
on conflict (role_key, capability_key) do nothing;

-- ── 4. Notification type for the 48h pre-erasure notice (Rule 8) ─────────────────────
insert into notification_types (slug, label) values
  ('account_erasure_notice', 'Account erasure — 48h notice')
on conflict (slug) do nothing;
