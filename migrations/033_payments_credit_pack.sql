-- ── 033: which payments were credit top-ups ─────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- The payments table records amount, date and status and nothing about WHAT was bought, because
-- until now every row was a subscription charge and there was nothing to distinguish. A credit
-- pack purchase lands in the same list, so a baker sees an unexplained ₹149 sitting beside their
-- plan charges with no way to tell which is which — and "did I pay for that?" is exactly the
-- question a payment history exists to answer.
--
-- ── WHY A PACK ID RATHER THAN A `kind` ENUM ─────────────────────────────────────────
-- A kind column would say "this was a top-up" and stop there, and would need a second column to
-- say WHICH top-up. The pack id carries both: its presence means the row is a top-up, and its
-- value names the pack, so the label comes from credit_packs rather than from a string duplicated
-- into the payments row and left to rot when a pack is renamed.
--
-- NULL on every subscription payment, which is nearly all of them — so this stays a narrow column
-- on a table that is read newest-first per baker, not a widening of the hot path.
--
-- A smallint FK, matching status_id and the rest of the schema: persisted keys are compact
-- surrogates, never text.
alter table payments add column if not exists credit_pack_id smallint references credit_packs (id);

comment on column payments.credit_pack_id is
  'Set when this payment bought an AI credit pack; NULL for a subscription charge. Presence identifies the row as a top-up and the value names the pack — the label is read from credit_packs so it cannot drift.';
