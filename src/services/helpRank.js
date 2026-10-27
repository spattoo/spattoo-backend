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
 * ⚠️ ONE SECTION PER ARTICLE BY DEFAULT, AND THAT IS THE WHOLE POINT OF THE CAP. The articles are
 * internally similar by construction — "Changing the cake colour" has six sections that all talk
 * about tiers and colour — so an unfiltered top-four is four pieces of the same article, which
 * reads as one answer repeated and hides the three other articles that might have been right.
 *
 * ⚠️ AND BELOW THE FLOOR IT RETURNS NOTHING RATHER THAN THE CLOSEST THING. "What is the weather"
 * has a nearest section; showing it would be the assistant confidently answering a question it
 * cannot. An empty list is what lets the caller say so — and is the signal worth logging, because
 * the help INDEX already asks for exactly that: write the next articles from "the support
 * assistant's unanswered-question log … rather than what we imagine they need".
 */
export function rankSections(scored, { limit = 4, perDoc = 1, floor = ANSWER_FLOOR } = {}) {
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
