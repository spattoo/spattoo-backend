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
  /* ⚠️ GENDER WORDS COME OUT TOO, now that `genderOf` reads them off the raw story. They describe
     the PERSON, never the cake — "daughter makeup kits" was embedding a word about no cake at all.
     Taking them out sharpens the subject and costs nothing, because the signal was already read. */
  const words = rest.split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !DOMAIN_NOISE.has(w) && !ASKING.has(w) && !GENDER_VOCAB.has(w));
  return { subject: words.join(' ') || String(story ?? '').trim(), ages, words };
}

/* ── Who the cake is FOR ─────────────────────────────────────────────────────────────────────────
 *
 * ⚠️ THIS WAS THE HALF OF MY OWN DESIGN THAT WAS NOT BUILT. The header above says "elements for the
 * subject, tags and attrs for the audience", and only the subject half existed: `subjectOf` pulled
 * "8" out of "a super hero cake for 8 year old boy", handed it back, and nothing used it. A story
 * mentioning an eight-year-old ranked a wedding cake exactly as highly as a children's one.
 *
 * ⚠️ AGE EXCLUDES, GENDER ONLY DEMOTES, and the asymmetry is about what each one means. A design
 * authored for 20–99 is not a cake for an eight-year-old — that is a fact about the cake, and the
 * catalogue filter already excludes on it, so this must agree or the two surfaces disagree about
 * the same template. A gender tag is softer: a cake tagged Girls is not unusable for a boy, it is
 * the wrong first suggestion. Excluding it would also empty the results for any baker whose
 * catalogue leans one way, which is the opposite of helpful.
 */

/* Boys · Girls · Anyone — the three gender tags, by slug. */
const GENDER_WORDS = {
  boys:  ['boy', 'boys', 'son', 'grandson', 'nephew', 'brother', 'husband', 'father', 'dad', 'he', 'him', 'his'],
  girls: ['girl', 'girls', 'daughter', 'granddaughter', 'niece', 'sister', 'wife', 'mother', 'mum', 'mom', 'she', 'her'],
};

/**
 * Who the story is about — read from the words a person actually uses.
 *
 * ⚠️ IT READS THE RAW STORY, NOT THE SUBJECT. `subjectOf` strips "she" and "her" as asking-words,
 * so by then the signal is gone; and the relationship words it does NOT strip ("daughter") were
 * polluting the subject instead — "daughter makeup kits" embeds a word about no cake at all.
 * Reading them here lets `subjectOf` drop them too, which cleans the subject and buys the audience
 * signal from the same words.
 *
 * ⚠️ AND IT REFUSES TO GUESS WHEN A STORY SAYS BOTH. "a cake for my son and daughter" names two
 * people; picking one would quietly file the cake under half the request. Null means "not said",
 * which is the honest reading and leaves every template on equal footing.
 */
export function genderOf(story) {
  const words = new Set(String(story ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean));
  const hits = Object.entries(GENDER_WORDS)
    .filter(([, list]) => list.some(w => words.has(w)))
    .map(([slug]) => slug);
  return hits.length === 1 ? hits[0] : null;
}

/** Every word that carries a gender signal — `subjectOf` drops these once they have been read. */
export const GENDER_VOCAB = new Set([...GENDER_WORDS.boys, ...GENDER_WORDS.girls]);

/* ⚠️ MIRRORS core's `matchesAge` (designer/templateFilter.js), WHICH OWNS THE RULE. Core cannot be
   imported here — spattoo-api does not depend on @spattoo/designer, and taking that dependency for
   five lines would be worse than this. The duplication is real and is why `check:story-match` pins
   the two behaviours core's own comment calls out: a bare number is not an age (handled upstream in
   `subjectOf`), and the ceiling means "18 or older" rather than exactly 18 — testing 18 exactly
   would drop every design whose `min_age` is 20, Couple (20–99) among them. */
export const AGE_CEILING = 18;

export function suitsAge(attrs, n) {
  if (!Number.isInteger(n)) return true;
  if (n >= AGE_CEILING) return !(attrs?.max_age != null && attrs.max_age < AGE_CEILING);
  if (attrs?.min_age != null && attrs.min_age > n) return false;
  if (attrs?.max_age != null && attrs.max_age < n) return false;
  return true;
}

/** How much a gender mismatch costs. Enough to reorder, not enough to bury. */
export const GENDER_PENALTY = 0.35;

/**
 * Apply the audience to a ranked list.
 *
 *   audience  { ages: [8], gender: 'boys' | null }
 *   byId      Map(templateId → { attrs, genders: ['girls'] })
 */
export function applyAudience(ranked, audience, byId) {
  const ages = audience?.ages ?? [];
  const want = audience?.gender ?? null;
  return ranked
    .filter(r => ages.every(n => suitsAge(byId.get(r.templateId)?.attrs, n)))
    .map((r) => {
      const genders = byId.get(r.templateId)?.genders ?? [];
      /* "Anyone" is not a mismatch with anything, and a template with no gender tag has said
         nothing — neither should be penalised for a story that mentions a boy. */
      const mismatch = !!want && genders.length > 0
        && !genders.includes('anyone') && !genders.includes(want);
      return mismatch ? { ...r, score: +(r.score * (1 - GENDER_PENALTY)).toFixed(4), audience: 'other gender' } : r;
    })
    .sort((a, b) => (b.score - a.score) || String(a.templateId).localeCompare(String(b.templateId)));
}
