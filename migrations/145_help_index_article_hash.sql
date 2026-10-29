-- ── What each indexed article was, so a rebuild can do only the work that changed ───────────────
--
-- Sandeep: *"even if we build it in admin, how do we know the differential?"* and *"is it like we
-- need to rebuild the complete index if there is a change?"*
--
-- Until now the answer to both was bad. The index recorded nothing about WHAT it held, so the only
-- safe rebuild was to delete all 364 rows and re-embed every one — about two minutes, and a window
-- where the table is empty and the assistant answers "nothing is written about that yet" to
-- everyone. The full delete was a consequence of not knowing, never a requirement.
--
-- ⚠️ THE RECORD GOES IN THE DATABASE, NOT IN A FILE. It used to live in spattoo-docs'
-- help/.indexed.json, written by the CLI. A browser cannot write to that repo, so the moment the
-- rebuild moved into admin the file would have gone stale and the docs gate would have started
-- reporting an environment as behind when it was not. Beside the rows it describes, the record is
-- true for whichever door rebuilt it, needs nothing committed, and cannot be forgotten.
--
-- A row per SECTION carries its article's hash, so the article is its own record: delete its rows
-- and the record goes with them, which is exactly right for an article that stops being live.

BEGIN;

ALTER TABLE public.help_sections
  -- sha256 of the article's full file text, first 16 chars. Hashed SERVER-SIDE from what was
  -- uploaded, never in the browser: two hashers are two chances to disagree about encoding, and a
  -- hash that differs by environment would report every article as changed, forever.
  ADD COLUMN IF NOT EXISTS content_hash text,
  -- The filename it came from. `doc_slug` is the frontmatter `id` and the two can differ; a diff
  -- has to name files, because that is what the person uploading them sees.
  ADD COLUMN IF NOT EXISTS source_file  text;

-- The read the diff does: one row per article, cheapest possible.
CREATE INDEX IF NOT EXISTS help_sections_doc_hash_idx
  ON public.help_sections (doc_slug, content_hash);

COMMENT ON COLUMN public.help_sections.content_hash IS
  'sha256(file text) truncated to 16 chars, written at index time. A rebuild compares the uploaded '
  'articles against this and re-embeds only what changed — see services/helpIndexBuild.js.';

COMMIT;

-- Verify — one line per article, with what it was indexed from:
--   select doc_slug, source_file, content_hash, count(*) as sections
--     from public.help_sections group by 1,2,3 order by 1;
