/* ── Finding cakes you ALREADY HAVE, from a sentence ─────────────────────────────────────────────
 *
 * Sandeep: *"we should show the existing templates first (that match the query), then try to build a
 * new one"* — and then the sharper point: *"cant we check the elements in a template? and there is
 * every possibility we miss tagging a template. or mis-tag it."*
 *
 * ⚠️ HE IS RIGHT, AND THE LIBRARY PROVES IT. Three makeup cakes exist. Their tags say Birthday,
 * Modern, **Princess** and **1st Birthday** — not one says beauty, and there is no beauty theme tag
 * to say it with. Their ELEMENTS say lipstick, eyeshadow palette, makeup brushes, nail polish. The
 * elements describe those cakes correctly and the tags do not. Measured across the catalogue: only
 * 27 of 79 templates carry a theme tag at all, and four of the twelve themes have none.
 *
 * So this does not search tags, and it does not search names. It embeds the sentence, finds the
 * ELEMENTS nearest to it — the same `match_elements` index that already serves the photo path — and
 * rolls those up to the templates that contain them, through `template_elements` (323 rows,
 * covering 77 of 79 templates). "She loves doing her nails and lipstick" then finds "makeup theme
 * cake", a phrase that appears in neither its name nor its tags, because the cake CONTAINS a nail
 * polish and a lipstick.
 *
 * ⚠️ TAGS ARE NOT DELETED, THEY ARE DEMOTED TO A DIFFERENT QUESTION. Elements say what a cake is
 * ABOUT; they cannot say who it is FOR. Age range, gender and occasion live in `attrs` and tags and
 * are well covered (75 of 79 carry an occasion). So: elements for the subject, tags and attrs for
 * the audience — which also means a mis-tag like "Princess" on a makeup cake stops mattering,
 * because it was never carrying the subject.
 *
 * ⚠️ AND NO GENERATIVE MODEL RUNS HERE. One embedding call, `text-embedding-3-small`, priced at
 * $0.02 per million tokens against a story of about fifty. This half spends no AI credits and needs
 * no metering; that begins only when the baker asks for a cake to be BUILT.
 */

import { supabase } from './supabase.js';
import { embedText } from './openai.js';
import { retrieve } from './inspirationMatch.js';
import { rankTemplates, subjectOf } from './storyRank.js';

/* How many elements to pull from the index before rolling up. Wider than the photo path's
   shortlist of 20: there we want the single best element for ONE decoration, here we want enough
   of the library in hand that a template can be corroborated by several of its parts. */
const ELEMENT_POOL = 80;

/** Embed a story, find the elements nearest it, and rank the templates that contain them. */
export async function searchTemplatesByStory(story, { limit = 12, includeInactive = false } = {}) {
  const text = String(story ?? '').trim();
  if (!text) return { templates: [], elements: [], subject: '', ages: [] };

  /* ⚠️ `embedText` RETURNS `{ embedding, usage, model }`, NOT THE VECTOR. Handing the whole object
     to the cosine gives 0.000 against every element in the library — which looks exactly like "we
     stock nothing like that" and is not. The first run of this returned "nothing matched" for all
     eight stories, including one whose subject the catalogue plainly carries. */
  /* ⚠️ THE SUBJECT, NOT THE SENTENCE — see subjectOf. Embedding "cars theme cake for a 4 year old"
     ranks space above cars, because "theme cake" is in 37% and 70% of the catalogue's descriptions
     and "cars" is in almost none. */
  const { subject, ages } = subjectOf(text);
  const { embedding, usage } = await embedText(subject);
  /* ⚠️ THE SAME RETRIEVAL THE PHOTO PATH USES, not a second one. It already decides between the
     pgvector RPC and an in-JS cosine over the whole index, and on dev the RPC does not exist — so
     a fresh implementation here would have been written against the branch that never runs. */
  const hits = await retrieve(embedding, ELEMENT_POOL);

  const ids = hits.map(h => h.id);
  if (!ids.length) return { templates: [], elements: [], subject, ages };

  const elements = new Map(hits.map(h => [h.id, { id: h.id, name: h.name }]));
  const { data: links } = await supabase
    .from('template_elements').select('template_id, element_id').in('element_id', ids);

  const ranked = rankTemplates({ hits, links: links ?? [], elements, limit: limit * 3 });
  /* ⚠️ EVERY RETURN SAYS WHAT IT SEARCHED FOR. This path used to omit `subject`, so the evaluation
     tool printed `embedded: "undefined"` on exactly the queries that found nothing — the one case
     where you most need to know what was asked. A debugging surface that goes blank when it fails
     is worse than none. */
  if (!ranked.length) return { templates: [], elements: [...elements.values()], usage, subject, ages };

  /* ⚠️ THE ACTIVE CHECK IS HERE, NOT IN THE JOIN. `template_elements` has no opinion about whether
     a template is still offered, and a retired cake surfacing in a search is worse than a thin
     result. Fetched after ranking so one query covers however many came back. */
  const { data: tpls } = await supabase
    .from('cake_templates')
    .select('id, name, thumbnail_url, tier_count, shape, is_active')
    .in('id', ranked.map(r => r.templateId));
  const byId = new Map((tpls ?? []).map(t => [t.id, t]));

  const templates = ranked
    .map(r => ({ ...byId.get(r.templateId), score: r.score, why: r.why }))
    .filter(t => t.id && (includeInactive || t.is_active))
    .slice(0, limit);

  return { templates, elements: [...elements.values()], usage, subject, ages };
}
