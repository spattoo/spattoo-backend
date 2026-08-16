-- ── 064: more than one attempt per element ───────────────────────────────────────────────────────
--
-- One generation per candidate meant every miss cost a full round trip: notice it is wrong, work out
-- which knob, regenerate, wait. Judging four side by side is both faster and better — you are
-- choosing rather than accepting, and four at low quality cost about the same as one at high.
--
-- `output_keys` holds every attempt, newest run replacing the previous set. `output_key` stays as
-- the FIRST of them so nothing that already reads it has to change — the extract job, the admin
-- provenance stamp and the 29 existing rows all keep working untouched.
--
-- Nothing here records a "chosen" variant, deliberately. The admin downloads the one they want and
-- takes it to AddElement; a selection stored here would be state nobody reads, and the screen is a
-- workspace rather than a catalogue.

ALTER TABLE public.element_candidates
  ADD COLUMN IF NOT EXISTS output_keys text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.element_candidates.output_keys IS
  'Every image produced by the most recent generation run, in the order returned. `output_key` is '
  'the first of them and is kept for existing readers. Replaced wholesale on re-generation — these '
  'are attempts to choose between, not a history to keep.';
