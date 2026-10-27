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
import { requireAuth } from '../middleware/auth.js';
import { searchHelp } from '../services/helpSearch.js';

const router = Router();

router.post('/help/search', requireAuth, async (req, res) => {
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
    /* `question` travels back so the panel can show what was actually asked against an empty
       result — "we have nothing written about that" reads very differently from a silent panel. */
    res.json({ ok: true, question: text, sections });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
