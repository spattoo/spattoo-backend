-- ── Handing a question the assistant could not answer to a person ───────────────────────────────
--
-- Sandeep: *"lets build that escalation. should we just send email to the person? thats a good
-- starting point. we can later build a mechanism so someone from spattoo joins the chat with
-- baker. for now, email."*
--
-- ⚠️ EVERY BOUGHT SUPPORT BOT ASSUMES THIS EXISTS, and ours did not. Intercom, Zendesk and the
-- rest all answer from your help centre and hand off to a human when they cannot — the hand-off is
-- the part that makes an imperfect bot acceptable rather than infuriating. Measured 2026-10-27:
-- roughly seven of twenty factual questions were actually answered. Without a way out, the other
-- thirteen are a dead end.
--
-- ⚠️ IT HANGS OFF THE QUESTION, NOT OFF A NEW TABLE. help_questions already holds what was asked,
-- what we showed and whether the baker said it missed. An escalation is one more fact about that
-- same question, and a separate table would mean joining to answer "what did they actually see?"
-- — which is the first thing anybody replying needs.

BEGIN;

ALTER TABLE public.help_questions
  -- When a person was asked to step in. NULL for every question that did not need one, which is
  -- most of them.
  ADD COLUMN IF NOT EXISTS escalated_at timestamp with time zone,
  -- What the baker added in their own words when handing it over. Optional: the question itself is
  -- usually enough, and demanding a second description before letting somebody ask for help is how
  -- a help channel goes unused.
  ADD COLUMN IF NOT EXISTS escalation_note text,
  -- Whether the alert actually left the building. 'sent' | 'failed' | NULL.
  --
  -- ⚠️ RECORDED SEPARATELY FROM escalated_at, because they are different facts and only one of them
  -- is the baker's. The baker asked for help the moment they pressed the button; whether our SMTP
  -- accepted it is our problem, and conflating the two would lose the request when the send fails.
  ADD COLUMN IF NOT EXISTS escalation_delivery text;

-- The queue a person works from: what has been handed over, newest first.
CREATE INDEX IF NOT EXISTS help_questions_escalated_idx
  ON public.help_questions (escalated_at DESC) WHERE escalated_at IS NOT NULL;

COMMENT ON COLUMN public.help_questions.escalated_at IS
  'Set when the baker asked for a person. The alert email carries the question, what the assistant '
  'showed, and a Reply-To of the baker, so replying in the inbox reaches them directly.';

COMMIT;

-- Verify:
--   select question, escalated_at, escalation_delivery from public.help_questions
--    where escalated_at is not null order by escalated_at desc limit 10;
