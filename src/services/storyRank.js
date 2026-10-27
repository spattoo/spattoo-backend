/* ── Scoring a template by the elements it contains ──────────────────────────────────────────────
 *
 * ⚠️ PURE, AND IN ITS OWN FILE SO IT CAN BE CHECKED WITHOUT THE SERVER. `storyMatch.js` reaches
 * supabase and OpenAI, and importing it pulls `config.js` — which refuses to load unless every
 * runtime secret is present, Redis included. A ranker that cannot be exercised without a Redis URL
 * is a ranker nobody exercises: it never throws, it just puts the wrong cake first, and then the
 * maths and the library are indistinguishable as causes. So the arithmetic lives here, imports
 * nothing, and `scripts/check-story-match.mjs` holds it to its properties.
 */

/* ── Why the score is a noisy-OR and not a sum ───────────────────────────────────────────────────
 *
 * ⚠️ A SUM REWARDS BUSY CAKES. A template carrying twelve decorations has twelve chances to catch a
 * weak similarity, so adding them up ranks "the cake with the most on it" rather than "the cake
 * this story is about". A plain cake with one perfect match must be able to win.
 *
 * ⚠️ AND A MAXIMUM IGNORES CORROBORATION. One lipstick is a hint; a lipstick AND an eyeshadow
 * palette AND a nail polish is the same cake the customer is describing, and should rank above a
 * cake with a single lipstick on it.
 *
 * Noisy-OR gives both: evidence accumulates with diminishing returns and stays bounded below 1, so
 * corroboration lifts a template without letting sheer quantity run away with it.
 */

/** Similarity below which an element is noise rather than evidence. */
export const EVIDENCE_FLOOR = 0.28;
/* ⚠️ ONLY THE BEST FEW COUNT. Past a handful of matched elements a template is not more "about" the
   story, it just has a long parts list — and the tail is exactly where weak, generic matches
   (a border, a scatter) accumulate. */
export const MAX_EVIDENCE = 5;

/** One element's contribution, rescaled so the floor is zero evidence and 1.0 is certainty. */
export function evidenceOf(similarity, floor = EVIDENCE_FLOOR) {
  const s = Number(similarity);
  if (!Number.isFinite(s) || s <= floor) return 0;
  return Math.min(1, (s - floor) / (1 - floor));
}

/**
 * Rank templates by the elements they contain.
 *
 *   hits      [{ id, similarity }]        elements nearest the story, from match_elements
 *   links     [{ template_id, element_id }]  the template_elements join
 *   elements  Map(id → { name })          for explaining the match
 *
 * Returns [{ templateId, score, why: [{ name, similarity }] }], best first.
 */
export function rankTemplates({ hits = [], links = [], elements = new Map(), limit = 12 } = {}) {
  const simOf = new Map();
  for (const h of hits) if (h && h.id != null) simOf.set(h.id, Number(h.similarity) || 0);

  const perTemplate = new Map();
  for (const l of links) {
    const sim = simOf.get(l?.element_id);
    if (sim === undefined) continue;                       // this element was not near the story
    const list = perTemplate.get(l.template_id) ?? [];
    list.push({ id: l.element_id, similarity: sim, name: elements.get(l.element_id)?.name ?? null });
    perTemplate.set(l.template_id, list);
  }

  const out = [];
  for (const [templateId, all] of perTemplate) {
    /* ⚠️ TWO SATURNS ARE NOT TWO PIECES OF EVIDENCE. The catalogue carries repeats of the same
       decoration as separate rows — two Racing flags, two Saturns, four Football players — and
       noisy-OR treats each as independent corroboration, so the cake with the most COPIES wins.
       Measured: "cars theme cake" ranked `space theme` (Saturn 0.51, Saturn 0.51, Mercury, Earth,
       Moon) above `car theme` (Sports car 0.57, Racing flag 0.48, Racing flag 0.48, Car wheel) —
       the car cake had the better single match and lost on duplicate planets.
       ⚠️ AND THE PLANETS ARE NOT A RANDOM MISS. Saturn and Mercury are car marques as well as
       planets; the embedding is reading the automotive sense of both. That part is genuine lexical
       ambiguity and no weighting fixes it — but it only beat the right answer because it was
       counted twice. */
    const seen = new Set();
    const best = all
      .sort((a, b) => b.similarity - a.similarity)
      .filter(e => {
        const key = (e.name ?? e.id ?? '').toString().trim().toLowerCase();
        if (!key) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, MAX_EVIDENCE);
    let miss = 1;                                           // probability NOTHING here is evidence
    for (const e of best) miss *= (1 - evidenceOf(e.similarity));
    const score = 1 - miss;
    if (score <= 0) continue;                               // every match was below the floor
    out.push({ templateId, score: +score.toFixed(4), why: best.filter(e => evidenceOf(e.similarity) > 0) });
  }
  /* ⚠️ TIE-BROKEN ON THE ID, so the same library and the same story always come back in the same
     order. A ranked list that reshuffles between identical calls is impossible to test and reads
     as a bug to whoever is looking at it. */
  out.sort((a, b) => (b.score - a.score) || String(a.templateId).localeCompare(String(b.templateId)));
  return out.slice(0, limit);
}

/* ── Reducing a story to its SUBJECT before embedding ────────────────────────────────────────────
 *
 * ⚠️ IN A CATALOGUE OF CAKES, THE WORD "CAKE" CARRIES NO INFORMATION — and leaving it in the query
 * actively ranks the wrong cake. Measured across all 219 element descriptions: "cake" appears in
 * **70%** of them, "topper" in 50%, "theme" in 37%, "decoration" in 36%. Every space element reads
 * `planet, space, space theme, space theme cake, saturn`.
 *
 * So the query "cars theme cake for a 4 year old" matched `space theme` ABOVE `car theme` — not on
 * cars, but on the two words "theme cake", which every space element happens to spell out and the
 * car elements mostly do not. Searching for "cars" alone ranked the car cakes first. The boilerplate
 * was the whole difference.
 *
 * ⚠️ THE LIST IS MEASURED, NOT GUESSED, and the percentage is kept beside each word so a future
 * reader can see why it is here and re-measure rather than re-argue. Anything appearing in roughly
 * an eighth of the catalogue or more cannot tell two cakes apart.
 *
 * ⚠️ MATERIALS AND OCCASIONS ARE DELIBERATELY STRIPPED TOO, even though they are meaningful — just
 * not HERE. "fondant" (32%) and "birthday" (22%) say what a cake is made of and what it is for;
 * neither says what it is ABOUT, and the audience half of the search answers them from tags and
 * attrs, where the coverage is good (75 of 79 templates carry an occasion).
 */
const DOMAIN_NOISE = new Set([
  'cake', 'cakes',        // 70%
  'topper', 'toppers',    // 50%
  'theme', 'themed',      // 37%
  'decoration', 'decorations', 'decorative', 'decor',   // 36% / 13% / 9%
  'fondant',              // 32% — a material, answered elsewhere
  'birthday',             // 22% — an occasion, answered elsewhere
  'edible',               // 16%
  'design', 'designs',    // 12%
  'style', 'styled',      // 11%
  'buttercream',          // 11% — a material, answered elsewhere
  'celebration', 'celebrations',  // 11%
  'embellishment', 'embellishments',  // 10%
  'party',                // 8%
  /* ⚠️ COLOURS ARE AN ATTRIBUTE, AND THEY DILUTE THE SUBJECT. "cars theme cake for a 4 year old,
     blue and red" found NOTHING once the boilerplate went, while "cars" alone found the car cakes:
     the colour words pulled the embedding away from the subject until every similarity fell under
     the evidence floor. Colour is already its own dimension in the catalogue filter, so it is
     answered there — exactly as materials and occasions are. A closed list, because colour names
     are unbounded and this only needs the ones people actually type. */
  'red', 'blue', 'pink', 'green', 'yellow', 'purple', 'orange', 'white', 'black', 'gold',
  'silver', 'brown', 'grey', 'gray', 'cream', 'ivory', 'teal', 'turquoise', 'lilac', 'peach',
  'pastel', 'bright', 'dark', 'light',
]);

/* The words a person uses to ASK, which describe no cake. Kept small for the reason core's own
   filler list states: every addition is a word nobody can search for again. */
const ASKING = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'she', 'her', 'his', 'him', 'they', 'them',
  'want', 'wants', 'need', 'needs', 'looking', 'look', 'like', 'likes', 'love', 'loves',
  'can', 'you', 'please', 'make', 'making', 'generate', 'something', 'some', 'any',
  'would', 'could', 'should', 'have', 'has', 'get', 'give', 'show', 'find', 'our', 'are', 'was',
]);

/* Same rule core uses in templateFilter.js: an age is only an age when it carries a unit, because
   a bare 25 is far more often a silver wedding than a 25-year-old. */
const AGE_PHRASE = /(\d{1,3})\s*(?:years?|yrs?|yo)\b(?:\s+old\b)?/g;

/**
 * The part of a story worth embedding, plus any ages found in it.
 *
 * ⚠️ FALLS BACK TO THE WHOLE STORY IF STRIPPING LEAVES NOTHING. "I need a birthday cake" reduces to
 * the empty string, and embedding nothing finds nothing — where embedding the sentence at least
 * returns weak, honest scores that the caller can decide to ignore.
 */
export function subjectOf(story) {
  const raw = String(story ?? '').toLowerCase();
  const ages = [];
  const rest = raw.replace(AGE_PHRASE, (_, n) => { ages.push(parseInt(n, 10)); return ' '; });
  const words = rest.split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !DOMAIN_NOISE.has(w) && !ASKING.has(w));
  return { subject: words.join(' ') || String(story ?? '').trim(), ages, words };
}
