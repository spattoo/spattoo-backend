-- ── 030: the billing card calls it what the button calls it ─────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────
-- Both metered actions ARE X-Ray, and neither label said so. A baker pressed "X-Ray" on an order
-- and was billed for a "Build guide" and a "Decoration guide" — three names for one product, none
-- of them the one on the button.
--
-- The terminology drifted while the feature was being built (build guide → decoration guide →
-- decoration steps). Settling it here, on the rule that the words a baker is BILLED for must match
-- the words they PRESS. X-Ray is not jargon to them: it is the button, and the report header reads
-- "X-Ray — how to make this cake".
--
-- SELF-EXPLAINING, because billing is the one screen with no surrounding context. "X-Ray" alone
-- would be a bare noun on a price list; the suffix does the same job the report header does.
--
-- ── THE PLURALISATION RULE IS DEAD, AND THAT IS WHY THESE CAN BE PHRASES ─────────────
-- 022 required labels to be "short and countable" because the billing card rendered "14 build
-- guides left this month" by appending an "s". That per-tool countdown was REMOVED — it implied
-- separate budgets when every action draws on one pool — and the card now renders the label
-- verbatim as "{label} — {credits} credits". Verified: no pluralisation of a label remains
-- anywhere in spattoo-core. So a phrase is safe now, where "Build guide from a photos" was not.
--
-- action_key is deliberately NOT renamed. It is a persisted surrogate no baker ever sees, every
-- credit_transactions row is joined through it, and renaming it would buy a tidier string at the
-- cost of a ledger that no longer matches its own history.
update credit_costs set label = 'X-Ray — read a cake photo', updated_at = now()
 where action_key = 'photo_to_xray_estimate' and label <> 'X-Ray — read a cake photo';

update credit_costs set label = 'X-Ray — how to make a decoration', updated_at = now()
 where action_key = 'element_build_guide' and label <> 'X-Ray — how to make a decoration';

-- credit_costs_active_label_uniq (026) still holds: the two labels differ, and both remain
-- distinct from the inactive rows' labels.
