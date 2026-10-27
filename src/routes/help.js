/* ── POST /help/search — "how do I do this in Spattoo?" ──────────────────────────────────────────
 *
 * Sandeep: *"baker can ask how can he do something in spattoo"*, and *"lets do help first"*.
 *
 * ⚠️ requireAuth AND NO CAPABILITY, DELIBERATELY. Every other route here names one, so the absence
 * needs its reason: a counter staff member holds `order:view` and not `design:create`, and the
 * person most likely to ask how something works is the one with the fewest permissions. Gating help
 * on a capability hides the manual from whoever needs it most. Signed in is the whole bar.
 *
 * ⚠️ NO CREDITS, ONE EMBEDDING. The reply is the help article's own text — see
 * services/helpSearch.js for why nothing here writes an answer.
 */
import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { requireAuth, attachBakerContext } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { supabase } from '../services/supabase.js';
import { searchHelp } from '../services/helpSearch.js';
import { logQuestion, markAnswered } from '../services/helpLog.js';
import { escalateQuestion } from '../services/helpEscalate.js';

const router = Router();

router.post('/help/search', requireAuth, attachBakerContext, async (req, res) => {
  try {
    const { question, limit } = req.body ?? {};
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }
    /* Capped for the same reason the story search is: the cost is the embedding, and the embedding
       is priced per token. A question is a sentence. */
    const text = question.slice(0, 600);
    const n = Math.min(Math.max(parseInt(limit, 10) || 4, 1), 8);
    const { sections } = await searchHelp(text, { limit: n });

    /* ⚠️ EVERY QUESTION IS RECORDED, NOT ONLY THE ONES THAT FAIL — without the answered ones there
       is no denominator, and "nine complaints" means nothing when you cannot tell it from nine out
       of ninety. The id goes back so the panel can report a verdict against this exact question.
       It never blocks or fails the answer: see services/helpLog.js. */
    const questionId = await logQuestion({
      question: text, sections, bakerId: req.bakerId ?? null, userId: req.user?.id ?? null,
    });

    /* `question` travels back so the panel can show what was actually asked against an empty
       result — "we have nothing written about that" reads very differently from a silent panel. */
    res.json({ ok: true, question: text, sections, questionId });
  } catch (err) {
    serverError(req, res, err);
  }
});

/* ── POST /help/feedback — "that did not answer my question" ─────────────────────────────────────
 *
 * ⚠️ THE ONLY WAY WE CAN LEARN ABOUT THE COMMON FAILURE. Measured over twenty factual questions
 * (2026-10-27): nineteen returned something and roughly seven were actually answered. "Does Spattoo
 * work in Hindi?" returned, at 0.384, the passage explaining why the menu is drawn as a spatula.
 * No score sees that — the article IS about the right subject and simply does not contain the fact.
 * A person has to say so, so this route exists to let them.
 *
 * There is deliberately no "that helped" counterpart. Nobody presses it, so its absence would be
 * unreadable — and the thing being measured is the gap, not applause.
 */
router.post('/help/feedback', requireAuth, async (req, res) => {
  try {
    const { questionId } = req.body ?? {};
    if (!questionId) return res.status(400).json({ error: 'questionId is required' });
    const ok = await markAnswered({ id: questionId, helpful: false, userId: req.user?.id });
    /* 200 either way. The baker has said their piece; whether our row was found is our problem,
       and a red error over a feedback tap teaches them not to tap it again. */
    res.json({ ok: true, recorded: ok });
  } catch (err) {
    serverError(req, res, err);
  }
});

/* ── GET /api/admin/help/questions — the log, read ───────────────────────────────────────────────
 *
 * ⚠️ A LOG NOBODY CAN READ IS NOT A LOG. help/INDEX.md has been written since before the assistant
 * existed on the assumption that this list would exist — it says to write the next articles from
 * "the support assistant's unanswered-question log … rather than what we imagine they need". That
 * is only true if somebody can open it, so this is the read and admin's Baker menu is the door.
 *
 * `baker:support`, the capability the other "how is this baker getting on" reads already use.
 *
 *   ?filter=missed   only what we failed: nothing found, or a baker said it did not answer
 *   ?days=30         how far back (default 30)
 */
router.get('/admin/help/questions', requireAuth, requireCapability('baker:support'), async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - days * 86400000).toISOString();

    let q = supabase
      .from('help_questions')
      .select('id, asked_at, question, result_count, top_score, top_doc_slug, top_heading, helpful, baker_id, escalated_at, escalation_note, escalation_delivery')
      .gte('asked_at', since)
      .order('asked_at', { ascending: false })
      .limit(500);

    /* ⚠️ BOTH HALVES OF "MISSED", because they are different failures with the same remedy. An
       empty result is a gap we can see. `helpful: false` is a gap only a baker could see — a card
       that scored well, came from the right article, and did not contain the answer. */
    if (req.query.filter === 'missed') q = q.or('result_count.eq.0,helpful.is.false');
    /* ⚠️ A SEPARATE FILTER FROM "missed", because they are different queues. A miss is something to
       write about eventually; an escalation is a person waiting for a reply right now. */
    if (req.query.filter === 'escalated') q = q.not('escalated_at', 'is', null);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    /* Counted over the SAME window the rows come from, so the summary and the list cannot disagree
       — and a rate is the only way "nine misses" becomes readable. */
    const rows = data ?? [];
    const summary = {
      asked: rows.length,
      nothingFound: rows.filter(r => r.result_count === 0).length,
      saidUnhelpful: rows.filter(r => r.helpful === false).length,
      escalated:     rows.filter(r => r.escalated_at).length,
      days,
    };
    res.json({ ok: true, questions: rows, summary });
  } catch (err) {
    serverError(req, res, err);
  }
});

/* ── POST /help/escalate — "ask the Spattoo team" ────────────────────────────────────────────────
 *
 * Sandeep: *"lets build that escalation … for now, email."*
 *
 * ⚠️ BAKER-INITIATED, ALWAYS. Never fired by a miss. We already log every question and whether it
 * landed; that is us deciding what to write next. This is somebody asking a person and waiting for
 * an answer, and the two must not be confused — auto-mailing every empty result would fill an
 * inbox with questions nobody is waiting on, and an inbox like that stops being read.
 *
 * ⚠️ IT ANSWERS 200 EVEN WHEN THE EMAIL FAILED. The request is recorded either way (see
 * services/helpEscalate.js): the baker asked the moment they pressed, and showing them an error
 * for our SMTP problem would make them press again or give up, neither of which helps.
 */
router.post('/help/escalate', requireAuth, attachBakerContext, async (req, res) => {
  try {
    const { questionId, note } = req.body ?? {};
    if (!questionId) return res.status(400).json({ error: 'questionId is required' });

    /* The baker row is read HERE rather than in the service, so the service stays about composing
       and sending and can be exercised without a request. */
    let baker = null;
    if (req.bakerId) {
      const { data } = await supabase.from('bakers').select('id, name, email').eq('id', req.bakerId).maybeSingle();
      baker = data ?? null;
    }
    /* The account's own address wins over the bakery's: it is the person who actually asked, and
       the one who will be watching for a reply. */
    const bakerEmail = req.user?.email ?? baker?.email ?? null;

    const { ok, alreadySent } = await escalateQuestion({
      id: questionId, userId: req.user?.id, note, baker, bakerEmail,
    });
    res.json({ ok: true, recorded: ok, alreadySent, replyTo: bakerEmail });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
