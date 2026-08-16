-- ── 062: what the generated image is FOR ─────────────────────────────────────────────────────────
--
-- One prompt served every generated decoration: "photorealistic, shot straight on, no shadow".
-- That is right for one of the three things an element becomes, and wrong for the other two in
-- opposite directions.
--
--   sticker  printed on edible paper. Flat is not a compromise — it is what the baker makes.
--
--   relief   a fondant cut-out. The image stops being a picture: buildSolidReliefGeometry traces
--            the ALPHA into a silhouette and extrudes it, and LUMINANCE bakes the normal map. So
--            shading becomes bumps, a dark outline paints a halo on the extruded wall, thin
--            protrusions poke off the wall, and interior holes are not cut at all (v1).
--
--   model    the input to image-to-3D. The OPPOSITE of the other two: a straight-on, evenly lit,
--            flat image gives a reconstruction model zero depth cues, so it invents them — which
--            is what "it keeps getting the details wrong" actually is.
--
-- The recipe is not a thing to remember per element. Admin knows which of the three it is at the
-- moment of generation, so the column carries it and services/openai.js selects the prompt.
--
-- Default 'sticker' — the behaviour every existing row was generated with, so nothing that already
-- ran changes meaning.

ALTER TABLE public.element_candidates
  ADD COLUMN IF NOT EXISTS intent text NOT NULL DEFAULT 'sticker';

-- Constrained, not free text. The recipes live in code (GENERATION_INTENTS in services/openai.js);
-- this stops a typo becoming a silent fall-back to the sticker recipe — the failure would be a
-- believable image that is wrong for its purpose, which is the hardest kind to notice.
ALTER TABLE public.element_candidates
  DROP CONSTRAINT IF EXISTS element_candidates_intent_valid;
ALTER TABLE public.element_candidates
  ADD CONSTRAINT element_candidates_intent_valid
  CHECK (intent IN ('sticker', 'relief', 'model'));

COMMENT ON COLUMN public.element_candidates.intent IS
  'What the generated image is FOR, which selects the prompt recipe in services/openai.js: '
  'sticker (printed, flat) | relief (fondant cut-out — alpha becomes the extruded silhouette and '
  'luminance bakes the normal map, so no shading, no dark outline, no thin protrusions, no interior '
  'holes) | model (image-to-3D input — three-quarter view, soft studio light, matte, so the '
  'reconstruction has real depth cues instead of inventing them). Keep in step with '
  'GENERATION_INTENTS.';
