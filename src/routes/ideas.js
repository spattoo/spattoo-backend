import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { composeIdea, COMPOSE_POOL } from '../services/ideaCompose.js';

const router = Router();

/* ── Composing a cake idea from a brief ──────────────────────────────────────────────────────────
 *
 * Sandeep: *"make them part of admin. i dont prefer running these mjs"* — the same note that put
 * every other POC behind a door: *"if tomorrow i want to visit it, i wont have this url."*
 *
 * ⚠️ IT RETURNS A BUNDLE, NOT A SPEC, and that is not a convenience. A spec names element IDS; a
 * screen that then had to go and fetch each row would be a second query deciding which rows a
 * design is made of. We already hold them — they were the prompt — so the response carries both,
 * and the studio can build the cake with nothing further.
 *
 * ⚠️ AND THE SHORTLIST IS RETURNED TOO, BEHIND A FLAG. "Why did it pick THAT" is the question
 * every look at a composed cake ends in, and without the 160 rows it was choosing from there is no
 * way to tell a bad model from a thin catalogue. Off by default because it is ~160 rows of JSON
 * nobody reads on a good run.
 *
 * ⚠️ NOT METERED. Every other model call in this app debits the AI-credit ledger; this one does
 * not, because it is behind `catalog:admin` and only staff can reach it. The day a BAKER can ask
 * for an idea, this route is the wrong one — metering belongs at that door, not bolted onto this.
 */
router.post('/admin/ideas/compose', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { brief, pool, includeShortlist } = req.body ?? {};
    const text = String(brief ?? '').trim();
    if (!text) return res.status(400).json({ error: 'brief is required' });
    /* A cap, because `pool` is the one field that decides what this costs: it is the prompt. */
    const k = Math.min(400, Math.max(10, Number(pool) || COMPOSE_POOL));

    const out = await composeIdea(text, { k });
    /* 200 with ok:false for "the catalogue had nothing" or "the model did not return JSON" — both
       are facts about the request, not server faults, and the screen shows them as a message
       rather than a red error. The same shape the help reindex route uses. */
    if (!out.spec) return res.json({ ok: false, reason: out.reason, raw: out.raw ?? null });

    const used = new Set(out.spec.elements.map(e => e.elementId));
    res.json({
      ok: true,
      spec: out.spec,
      elements: out.shortlist.filter(r => used.has(r.id)),
      rejected: out.rejected,
      usage: out.usage,
      pool: k,
      ...(includeShortlist === true
        ? { shortlist: out.shortlist.map(r => ({ id: r.id, name: r.name, similarity: r.similarity })) }
        : {}),
    });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
