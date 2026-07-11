-- Extract Elements: one row per decoration identified in a source cake photo.
--
-- Flow (two phases, split on the cost curve — identification is one cheap vision call,
-- regeneration is several expensive image generations):
--   phase 1  POST /admin/element-extract/identify  → GPT-4o vision finds each decoration and
--            returns a bounding box; we crop it out of the source with sharp and store the crop.
--            One row per decoration at status 'identified'. NOTHING has been generated yet.
--   phase 2  POST /admin/element-extract/generate  → the admin ticks the decorations worth
--            regenerating; a BullMQ job conditions gpt-image-1.5 on each CROP (not on a text
--            description of it) and writes the isolated, transparent result to output_key.
--   finally  the admin picks the good outputs and clicks "Create element", which deep-links into
--            AddElement with the output image preloaded. element_id is stamped back here on save.
--
-- SCALE — this is a BOUNDED table, not a hot one. It grows only when internal staff run the tool
-- (tens of rows per run, a handful of runs a day at most); it is never touched by customer traffic
-- and never joined in a storefront/designer read path. So `status` is a text CHECK enum, matching
-- its closest sibling `meshy_generations` — NOT a smallint FK to a lookup. The surrogate-FK rule in
-- CLAUDE.md exists to stop text keys bloating every row + index of a table that grows to millions;
-- that cost does not exist here, and inventing a lookup table for 5 values would add a join to every
-- read for no benefit. If this ever becomes baker-facing (self-serve element extraction), revisit:
-- that WOULD make it high-volume and the status should become a surrogate FK then.
--
-- Rows are KEPT after use (soft-delete convention) — they are the provenance trail answering
-- "which photo did this library element come from, and did the regeneration get used at all?".
-- 'rejected' is a status, not a DELETE.

CREATE TABLE element_candidates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid REFERENCES jobs(id) ON DELETE SET NULL,  -- the phase-2 regeneration job (NULL until generate)
  created_by    uuid,                                          -- req.user.id (auth user) who ran the extraction
  source_key    text NOT NULL,                                 -- R2 key of the uploaded cake photo (elements/candidates/<uuid>.jpg, signed upload)
  crop_key      text,                                          -- R2 key of the cropped decoration (elements/candidates/crops/) — the gpt-image reference
  output_key    text,                                          -- R2 key of the regenerated, background-free decoration (elements/candidates/outputs/)
  bbox          jsonb,                                         -- {x,y,w,h} normalised 0..1 against the source image, as GPT returned it
  label         text,                                          -- short human name, e.g. "pink buttercream rosette"
  element_kind  text,                                          -- GPT's coarse type: rose|leaf|drip|topper|macaron|other
  color_hex     text,
  material      text,                                          -- buttercream|fondant|acrylic|sugar|chocolate|other
  prompt        text,                                          -- the regeneration prompt GPT wrote for this decoration
  status        text NOT NULL DEFAULT 'identified'
                  CHECK (status IN ('identified', 'generating', 'ready', 'failed', 'rejected')),
  error         text,                                          -- failure reason when status = 'failed'
  element_id    uuid REFERENCES cake_elements(id) ON DELETE SET NULL,  -- set once this candidate is saved as a real element
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The two real access patterns: "show me every candidate from this extraction run" (the UI polls
-- this while phase 2 runs) and "has this candidate been turned into an element yet?" (provenance).
CREATE INDEX element_candidates_job_idx     ON element_candidates(job_id);
CREATE INDEX element_candidates_source_idx  ON element_candidates(source_key);
CREATE INDEX element_candidates_element_idx ON element_candidates(element_id) WHERE element_id IS NOT NULL;
