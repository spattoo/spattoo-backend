-- ── 026: an active action's label must be unique ────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- The billing card renders the active actions as a price list — "{label} — {credits} credits" —
-- so two active rows sharing a label show the same job at two different prices, one under the
-- other, and read as a bug rather than as two things.
--
-- That is not hypothetical: photo_to_xray_estimate (15) and element_build_guide (20) both shipped
-- as "Build guide" (fixed in 022; the second is now "Decoration guide"). The seed already said
-- labels must be short and countable, and both were — the rule that actually mattered was never
-- written down, so a comment could not have caught it either.
--
-- SELF-HEALING, on purpose. A unique index cannot be created while the duplicate it forbids is
-- still in the table, so this corrects the known collision FIRST. Applying 026 alone therefore
-- both fixes and enforces, rather than failing halfway and depending on someone having run a
-- separate UPDATE in the right order.
update credit_costs set label = 'Decoration guide', updated_at = now()
 where action_key = 'element_build_guide' and label <> 'Decoration guide';

-- PARTIAL, on is_active: a retired action keeps its history and its label, and may freely collide
-- with whatever replaced it. The constraint is about what a baker can see today, not about what
-- the table has ever held.
create unique index if not exists credit_costs_active_label_uniq
  on credit_costs (label) where is_active;

comment on index credit_costs_active_label_uniq is
  'Two ACTIVE actions must not share a label — the billing card lists them as a price list, so a duplicate reads as one job at two prices. Inactive rows are exempt: they are history.';
