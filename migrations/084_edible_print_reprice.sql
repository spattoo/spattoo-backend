-- ── 084: an edible print costs less, because it is generated on a cheaper model ──────────────────
--
-- 083 set `edible_print_generate` at 25 credits, priced off gpt-image-2 at ~$0.053 an image. That
-- pin has been removed: measured in `reference` mode — crop the subject from the baker's photo and
-- reproduce it, which is the ONLY mode this feature uses — gpt-image-1.5 was clearly more faithful
-- on both real subjects from the goose cake, holding the plaque's frame geometry and the goose's
-- soft linework where gpt-image-2 redrew both in its own style.
--
-- The mechanism: `input_fidelity: 'high'` exists to preserve a reference's identity, gpt-image-1.5
-- accepts it, gpt-image-2 rejects it outright. See services/openai.js modelSupportsInputFidelity.
--
-- ── 16 credits, from the same rule as before ────────────────────────────────────────────────────
--
--   one image, gpt-image-1.5, medium 1024x1024   ≈ $0.034  =  ₹3.06 landed
--   at the ≥80% target (features/ai-credits.md)  →  ₹15.30  →  16 credits
--   16 credits leaves an 81% margin, the same place 25 sat against the dearer model.
--
-- ⚠️ The PRICE FOLLOWED THE MODEL, which is the point of keeping this in a table. Nothing about the
-- feature changed; a measurement did, and a row moved. Had this been a constant in code it would
-- have taken a deploy, and would probably just have been left at 25.
--
-- Everything 083 recorded still holds and is not repeated here: one press is one image, reuse is
-- free forever because the print lands in the baker's own uploads, and identify is deliberately not
-- a metered action. Still is_active = false — the feature is not built.

update credit_costs
   set credits = 16, updated_at = now()
 where action_key = 'edible_print_generate';

-- Expect 16, still inactive.
select action_key, credits, label, is_active
  from credit_costs
 where action_key = 'edible_print_generate';
