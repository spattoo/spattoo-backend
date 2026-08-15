-- ── 063: copy the reference, or take the idea from it ────────────────────────────────────────────
--
-- Generation always ran through images/edits with input_fidelity:'high', conditioned on a crop of
-- the reference photo. That is right when rebuilding a cake you have seen: you want THAT lipstick,
-- the gold cap and the exact shade.
--
-- It is wrong when stocking the catalogue. There the reference is only where the idea came from,
-- and a faithful copy inherits everything wrong with it — the angle it happened to be photographed
-- at, one baker's slightly lopsided fondant, a brand marking. A clean generic lipstick is the more
-- reusable asset, and it costs less: no reference image to tokenise.
--
--   reference  images/edits + the crop, input_fidelity high    (unchanged, still the default)
--   fresh      images/generations from the description alone   (no reference sent)
--
-- Default 'reference' — how all 29 existing candidates were generated, so nothing already run
-- changes meaning. Same reasoning as 062's default.

ALTER TABLE public.element_candidates
  ADD COLUMN IF NOT EXISTS fidelity text NOT NULL DEFAULT 'reference';

-- Constrained for the same reason as `intent`: a typo would fall back silently, and the failure is
-- a believable image made the wrong way — the hardest kind to spot.
ALTER TABLE public.element_candidates
  DROP CONSTRAINT IF EXISTS element_candidates_fidelity_valid;
ALTER TABLE public.element_candidates
  ADD CONSTRAINT element_candidates_fidelity_valid
  CHECK (fidelity IN ('reference', 'fresh'));

COMMENT ON COLUMN public.element_candidates.fidelity IS
  'How closely generation copies the reference crop. reference = images/edits with '
  'input_fidelity high, reproducing THAT object (right when rebuilding a cake you have seen). '
  'fresh = images/generations from the description alone, no reference sent — a clean generic '
  'asset that inherits none of the source photo''s angle, wonk or branding, and costs less because '
  'there is no input image to tokenise. Pairs with `intent`, which picks the prompt recipe.';
