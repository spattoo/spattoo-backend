-- ── What bakers actually ask, and whether we answered it ────────────────────────────────────────
--
-- Sandeep, after trying it: three factual questions in a row, two of which came back with a
-- confident-looking card that did not contain the answer.
--
-- ⚠️ THE FAILURE THIS EXISTS TO CATCH IS NOT "NO ANSWER". Measured 2026-10-27 over twenty factual
-- questions: nineteen returned something and roughly seven were actually answered. "Does Spattoo
-- work in Hindi?" returned, at 0.384, the passage explaining why the menu is drawn as a spatula.
-- The retrieval score cannot see that — the article IS about the right subject, it simply does not
-- contain the fact. No floor, no threshold and no reranking catches it. A person has to say so.
--
-- ⚠️ SO EVERY QUESTION IS LOGGED, NOT ONLY THE FAILURES. Without the ones we answer there is no
-- denominator, and "nine complaints" means nothing when you cannot tell it from nine out of ninety.
-- Volume is a handful a day; this table is not a cost.
--
-- help/INDEX.md has assumed this table since before the assistant existed: it says to write the
-- next articles from "the support assistant's unanswered-question log … rather than what we
-- imagine they need". This is that log.

BEGIN;

CREATE TABLE IF NOT EXISTS public.help_questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asked_at    timestamp with time zone DEFAULT now() NOT NULL,

  -- Who asked. Kept so a recurring question can be traced to one person hammering it rather than
  -- forty bakers hitting the same gap — those need opposite responses from us.
  --
  -- `bakers`, not `bakeries` — that is the table, and `baker_appusers.baker_id` is what the auth
  -- middleware puts on the request. ON DELETE SET NULL rather than CASCADE: a bakery leaving does
  -- not make the gap in our help any less real, and the question is what this table is for.
  baker_id    uuid REFERENCES public.bakers(id) ON DELETE SET NULL,
  user_id     uuid,

  -- ⚠️ THE BAKER'S OWN WORDS, AND THAT IS THE POINT. Rewriting or normalising them would destroy
  -- the only thing this table is for: how people actually phrase what they want. It may therefore
  -- contain a customer's name ("how do I refund Priya's order") — no worse than the orders table,
  -- which stores customer names by design, but worth knowing before anyone exports it.
  question    text NOT NULL,

  -- What we showed. `result_count` 0 means nothing cleared the answer floor and the panel said so.
  result_count integer NOT NULL DEFAULT 0,
  top_score    real,
  top_doc_slug text,
  top_heading  text,

  -- ⚠️ NULL IS NOT "HELPFUL". It is "nobody said", which is the normal case — most people who get
  -- a good answer simply read it and carry on. Only `false` is evidence, and it is the signal this
  -- whole table was built to capture.
  helpful     boolean,
  answered_at timestamp with time zone
);

-- The two reads this gets: newest first, and "what did we fail at".
CREATE INDEX IF NOT EXISTS help_questions_asked_idx ON public.help_questions (asked_at DESC);
CREATE INDEX IF NOT EXISTS help_questions_unanswered_idx
  ON public.help_questions (asked_at DESC) WHERE result_count = 0 OR helpful IS FALSE;

/* The API writes this as `service_role`; without the grant it applies cleanly and then fails from
   a route in a different environment with nothing pointing back here. check:migration-grants. */
GRANT SELECT, INSERT, UPDATE, DELETE ON public.help_questions TO service_role;

COMMENT ON TABLE public.help_questions IS
  'Every question asked of the help assistant, and whether it landed. Read to decide which help '
  'article to write next — see spattoo-docs/help/INDEX.md.';

COMMIT;

-- Verify:
--   select count(*) filter (where result_count = 0) as nothing_found,
--          count(*) filter (where helpful is false) as marked_unhelpful,
--          count(*) as asked
--     from public.help_questions;
