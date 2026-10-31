-- ── 159: what a baker pays to generate a 3D decoration ──────────────────────────────────────────
--
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- **100 credits.** Sandeep, on the 150 the margin rule implied: *"150 is too high for a baker - i am
-- ok to reduce margin on this generation part."* then *"lets go with 100."*
--
-- ── THE ARITHMETIC, SO THE NEXT PERSON CAN RE-RUN IT RATHER THAN RE-GUESS ───────────────────────
--
--   Tripo, the baker shape (textured, no parts)   20 credits × $0.01   = $0.20
--   × AI_USD_INR (90)                                                  = ₹18.00
--   × 1.33   discard rate — failed runs are free to the baker, so we eat them
--   × 1.09   fx buffer (features/ai-credits.md says 8–10%)
--   + storage ≈ ₹0.02/year                                               negligible
--                                                            landed    ≈ ₹26 per KEPT model
--
--   100 credits × ₹0.799 (the 1000-pack rate, the cheapest a credit sells for) = ₹79.90
--   → 67% gross margin, 3.1× landed.
--
-- ⚠️ BELOW THE 80% TARGET AND ABOVE THE 60% FLOOR, DELIBERATELY. The rule in features/ai-credits.md
-- is ≥80% with a hard floor of 60%. 150 credits would have hit 78%; it also bought a Blaze baker
-- only FIVE models a month out of an 800-credit allowance, which is not a feature anybody would
-- describe as included. 100 gives EIGHT and still clears the floor.
--
-- ⚠️ THE ALLOWANCE IS THE COST CEILING, NOT THE PRICE. A Blaze baker spending their whole 800 on
-- generation and nothing else costs us ₹209 a month against a ₹2,499 subscription — 8.4%, and that
-- is the worst case, not the expectation (the same pool buys X-Ray at 15 and build guides at 20).
--
-- ⚠️ THE 1.33 DISCARD IS BORROWED, NOT MEASURED. It is the illustrative figure from the plan, and
-- for text→3D it may well be worse — a baker who gets the wrong bear runs it again. `provider_cost_inr`
-- is stamped on every debit, so re-tune from real data after the first month rather than defending
-- this estimate. That is the entire reason the price is a ROW and not a constant.
--
-- ⚠️ is_active = false, AND THAT IS THE SWITCH. No baker can generate yet — every ai3d route sits
-- behind the /api/admin mount guard — and an inactive action fails closed with UNKNOWN_ACTION, so
-- nothing can charge anybody by accident before the baker route exists. Flip this to true in the
-- same change that ships that route. Same posture 083 used for edible prints.
BEGIN;

insert into credit_costs (action_key, credits, label, is_active)
values ('decoration_generate_3d', 100, 'Decoration — made in 3D from a description', false)
on conflict (action_key) do update
  set credits = excluded.credits,
      label   = excluded.label,
      updated_at = now();

COMMIT;

-- Expect 100, inactive.
select action_key, credits, label, is_active from credit_costs where action_key = 'decoration_generate_3d';
