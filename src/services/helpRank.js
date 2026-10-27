/* ── Choosing which help sections to show ────────────────────────────────────────────────────────
 *
 * ⚠️ PURE, AND SEPARATE FROM THE SERVICE, for the reason storyRank.js already gives: `config.js`
 * refuses to load without every runtime secret, so anything importing supabase cannot be exercised
 * without a Redis URL. A ranker nobody can run is a ranker that silently returns the wrong article.
 */

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / ((Math.sqrt(na) * Math.sqrt(nb)) || 1);
}

/** Below this a section is not an answer, it is the nearest thing in a corpus that has none. */
export const ANSWER_FLOOR = 0.30;

/**
 * Best sections first, at most `perDoc` from any one article.
 *
 * ⚠️ TWO SECTIONS PER ARTICLE, NOT ONE — AND THE CAP WAS WRONG AT ONE. The cap exists because the
 * articles are internally similar by construction: "Changing the cake colour" has six sections
 * that all talk about tiers and cream, and unfiltered they take every slot, which reads as one
 * answer repeated while hiding the three other articles that might have been right. That reasoning
 * is sound. One was simply too tight.
 *
 * Sandeep asked whether it answered *"Can I use multi color sprinkles on cake?"*. It did not. The
 * answer is step 4 of the Sprinkles section — "Select the + to add a colour, and Colour to change
 * one" — which scored 0.561, SECOND of all 352 sections, five thousandths behind the chooser table
 * at the end of the same article. The cap threw it away and the panel answered with the three
 * next-best things, none of which was about sprinkles.
 *
 * Measured across eight real questions (2026-10-27): every single trade from one to two was an
 * improvement. Each gained a second section from the article that had already won and dropped the
 * weakest unrelated result — including "how do I give a customer a price", whose long-standing
 * wrong first answer (Flavours > Setting your prices) fell out in favour of Sending a quote. With
 * `limit` 4 at least two articles are still always represented, so nothing the cap was built to
 * prevent comes back.
 *
 * ⚠️ AND BELOW THE FLOOR IT RETURNS NOTHING RATHER THAN THE CLOSEST THING. "What is the weather"
 * has a nearest section; showing it would be the assistant confidently answering a question it
 * cannot. An empty list is what lets the caller say so — and is the signal worth logging, because
 * the help INDEX already asks for exactly that: write the next articles from "the support
 * assistant's unanswered-question log … rather than what we imagine they need".
 */
export function rankSections(scored, { limit = 4, perDoc = 2, floor = ANSWER_FLOOR } = {}) {
  const seen = new Map();
  return (scored ?? [])
    .filter(s => s && Number.isFinite(s.score) && s.score >= floor)
    .sort((a, b) => (b.score - a.score)
      || String(a.doc_slug ?? '').localeCompare(String(b.doc_slug ?? ''))
      || (a.position ?? 0) - (b.position ?? 0))
    .filter((s) => {
      const n = seen.get(s.doc_slug) ?? 0;
      if (n >= perDoc) return false;
      seen.set(s.doc_slug, n + 1);
      return true;
    })
    .slice(0, limit)
    .map(s => ({ ...s, score: +s.score.toFixed(4) }));
}
