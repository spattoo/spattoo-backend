-- ── The help articles, cut into the sections a question actually has an answer in ───────────────
--
-- Sandeep, on what the assistant is for: *"its not just about search templates or load a design,
-- but … baker can ask how can he do something in spattoo"*.
--
-- ⚠️ THE ANSWER IS RETRIEVED, NEVER WRITTEN. 60 help articles already exist in spattoo-docs/help,
-- written for bakers, step by step, each carrying `checked_against_app`. An assistant that generates
-- an answer about a UI will eventually invent "Settings → Advanced", and a confidently wrong
-- instruction is worse than no answer — it is also the exact thing Spattoo's pitch says it does not
-- do. So this table holds the articles' own words and the assistant quotes them.
--
-- ⚠️ A ROW IS A SECTION, NOT A DOCUMENT. Measured: 60 docs, 312 second-level headings, 5.2 per doc
-- — and the headings are task-shaped ("Opening the tier", "Blending two creams into each other").
-- Somebody asking how to change a colour wants that section, not a 76-line article to read through.
-- Embedding whole documents would also blur them: one vector averaging six tasks matches all six
-- weakly and none of them well.
--
-- ⚠️ `checked_against_app` TRAVELS WITH THE ROW, because a stale instruction is a confidently wrong
-- one. The assistant can decline to quote, or say when it was last checked; it cannot do either if
-- the date stays behind in a file.

BEGIN;

CREATE TABLE IF NOT EXISTS public.help_sections (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The article's own `id` from its frontmatter, not the filename: the frontmatter is what the
  -- docs repo treats as the identity, and a file can be renamed.
  doc_slug            text NOT NULL,
  doc_title           text NOT NULL,
  -- NULL for the opening passage before the first `##`, which is usually what the article IS about.
  heading             text,
  body                text NOT NULL,
  -- Order within the article, so a caller can offer "the next step" without re-reading the file.
  position            integer NOT NULL,
  audience            text,
  checked_against_app date,
  embedding           public.vector(1536),
  updated_at          timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT help_sections_doc_position_key UNIQUE (doc_slug, position)
);

-- Same index shape the element library uses, so retrieval behaves the same way.
CREATE INDEX IF NOT EXISTS help_sections_embed_idx
  ON public.help_sections USING hnsw (embedding public.vector_cosine_ops);
CREATE INDEX IF NOT EXISTS help_sections_doc_idx ON public.help_sections (doc_slug);

/* ⚠️ THE API READS THIS AS `service_role`, and a table created without the grant applies cleanly
   and then answers "permission denied" from a route, in a different environment, with nothing
   pointing back here. check:migration-grants exists because that has happened. */
GRANT SELECT, INSERT, UPDATE, DELETE ON public.help_sections TO service_role;

COMMENT ON TABLE public.help_sections IS
  'Baker help articles from spattoo-docs/help, one row per section. Rebuilt wholesale by '
  'scripts/backfill-help-index.mjs — nothing here is authored in the database.';

COMMIT;

-- Verify:
--   select doc_slug, count(*) from public.help_sections group by 1 order by 2 desc limit 5;
