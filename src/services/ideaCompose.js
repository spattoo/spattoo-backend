/* ── Composing a cake idea from the catalogue ────────────────────────────────────────────────────
 *
 * A brief in, a cake SPEC out — element ids, not words. The spec is the contract with the designer
 * (`spattoo-core/src/designer/idea/cakeSpec.js`), and this is the half that fills one in.
 *
 * ⚠️ THE MODEL IS HANDED THE SHELF, NEVER ASKED WHAT BELONGS ON A CAKE. The obvious composer asks
 * "what goes on a Krishna cake", gets flute / matki / peacock feather, and then has to match free
 * text against the library — a reconciliation problem invented out of nothing. Measured on our own
 * assets: the model says "flute", the catalogue says "Ornate Peacock Feather Bansuri". Worse, the
 * list is unconstrained, so most of it does not exist and the cake becomes whatever survived
 * matching. Hand it the parts list and take indices back: every answer is buildable BY
 * CONSTRUCTION, and "bakeable" stops being something we prompt for and hope.
 *
 * ⚠️ THE SHORTLIST IS `retrieve()`, THE ONE THE PHOTO PATH AND THE STORY SEARCH ALREADY USE. It
 * already decides between the pgvector RPC and an in-JS cosine, and on dev the RPC is absent — so a
 * second implementation here would have been written against the branch that never runs. See the
 * note on `retrieve` itself, which says exactly that about `storyMatch.js`.
 *
 * ⚠️ AND THE SHORTLIST IS WIDE. `inspirationMatch` ships `SHORTLIST = 20` and `storyMatch` widens
 * to 80, both to corroborate ONE thing — the best match for a photographed decoration, or enough
 * parts to recognise a template. Composing is the opposite problem: at 20 the choosing has already
 * been done by cosine distance and the model can only rubber-stamp it. 160 leaves it room to
 * compose and still costs a fraction of the catalogue.
 *
 * ⚠️ THE SUBJECT, NOT THE SENTENCE — `subjectOf`, for the reason it was written: embedding "krishna
 * theme cake for a 5 year old boy" ranks on "theme cake", which is in most of the catalogue's
 * descriptions, and buries "krishna", which is in almost none.
 */

import { supabase } from './supabase.js';
import { embedText } from './openai.js';
import { config } from '../config.js';
import { toPublicUrl } from '../lib/publicUrl.js';
import { retrieve } from './inspirationMatch.js';
import { subjectOf, genderOf } from './storyRank.js';
import { elementLines, composePrompt, parseJson, specFromModel,
         placePrompt, groupFromModel } from './ideaComposeMap.js';

/** How much of the library the model gets to choose from. See the note above on why it is wide. */
export const COMPOSE_POOL = 160;

/**
 * Parse a free-text brief into the fields the composer and the planner both want.
 *
 * ⚠️ IT REUSES THE STORY PARSER rather than writing a second one. `subjectOf` already strips the
 * domain noise that poisons an embedding, pulls the ages out, and drops gender words (they describe
 * the person, never the cake); `genderOf` reads the person off the raw sentence. A brief is a
 * story with a cake on the end of it, so the same two functions answer both.
 */
export function briefFrom(text, extra = {}) {
  const { subject, ages } = subjectOf(text ?? '');
  return { subject, ages, gender: genderOf(text ?? ''), occasion: null, weightKg: null, ...extra };
}

/**
 * The parts this baker could actually use, nearest the brief.
 *
 * ⚠️ `retrieve` IS GLOBAL-ONLY TODAY — its RPC filters `baker_id is null`, so a baker's own
 * uploads are invisible to it. That is a real gap for a feature whose claim is "you can make this",
 * and it is a TENANT filter, so widening it is the kind of change that leaks one baker's private
 * library into another's if it is done casually. Left alone here deliberately: the composer works
 * on the global catalogue, and the gap is named rather than quietly half-fixed.
 */
export async function shortlistFor(brief, { k = COMPOSE_POOL } = {}) {
  const { embedding } = await embedText(brief.subject || 'cake decoration');
  const hits = await retrieve(embedding, k);
  if (!hits.length) return [];

  /* `retrieve` selects a fixed field list that does not carry `description`, and the description is
     most of what tells a model what a part IS. Fetched here rather than widening `retrieve`: that
     function serves the photo path and the story search, and a field only this caller needs is not
     a reason to change what they ask for. */
  const ids = hits.map(h => h.id);
  const { data: desc } = await supabase
    .from('cake_elements').select('id, description').in('id', ids);
  const byId = new Map((desc ?? []).map(d => [d.id, d.description]));
  /* ⚠️ KEYS BECOME URLS HERE, because the row stores a KEY and anything downstream that wants to
     DRAW the element needs a URL. The designer resolves keys against a storage base it is handed;
     a bundle travelling to a harness, a script or a file has no such base, so it would render a
     cake of invisible parts — which is exactly what the first eval render did, with the console
     full of "Could not load elements/files/2D/….webp". Expanded through the one shared helper
     (`lib/publicUrl.js`), which exists because this was seven near-copies that had already
     drifted. */
  return hits.map(h => ({
    ...h,
    description: byId.get(h.id) ?? '',
    image_url: toPublicUrl(h.image_url),
    thumbnail_url: toPublicUrl(h.thumbnail_url),
  }));
}

/** One chat call, house style: a prose prompt describing the JSON, and a parse on the way back. */
async function callModel(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1200,
      /* ⚠️ NOT ZERO. A cake idea that is the same every time is not an idea, and the feature's whole
         promise is a NEW one. Low enough that it still obeys the parts list. */
      temperature: 0.8,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`compose failed: ${await res.text()}`);
  const data = await res.json();
  return { raw: data.choices?.[0]?.message?.content ?? '', usage: data.usage, model: data.model };
}

/**
 * Brief → spec.
 *
 * Returns `{ spec, rejected, shortlist, usage }`. Never throws for a model that misbehaves — a
 * hallucinated index is an outcome recorded in `rejected`, not an exception, for the same reason
 * a failed WhatsApp send is recorded against a baker rather than ending a run of two hundred.
 */
export async function composeIdea(briefText, { k = COMPOSE_POOL, extra = {} } = {}) {
  const brief = briefFrom(briefText, extra);
  const rows = await shortlistFor(brief, { k });
  if (!rows.length) {
    return { spec: null, rejected: [], shortlist: [], reason: 'nothing in the catalogue matched that brief' };
  }

  const prompt = composePrompt({ brief, lines: elementLines(rows) });
  const { raw, usage, model } = await callModel(prompt);

  const parsed = parseJson(raw);
  if (!parsed.ok) {
    return { spec: null, rejected: [], shortlist: rows, usage, model,
             reason: `the model did not return JSON: ${parsed.error}`, raw: parsed.raw };
  }

  const { spec, rejected } = specFromModel(parsed.value, rows, { brief });
  return { spec, rejected, shortlist: rows, usage, model, promptChars: prompt.length };
}

/** How much of the library one PLACE instruction gets to choose from. */
export const PLACE_POOL = 60;

/**
 * One sentence → one placeable group.
 *
 * "add a coral on the board" → the coral rows, the board, an arrangement and a count. The cake's
 * geometry is nowhere in here: the designer's `arrangeOnSlot` turns the arrangement into positions,
 * because it is the only side that knows how wide this cake is.
 *
 * ⚠️ A NARROWER SHELF THAN COMPOSING, ON PURPOSE. `composeIdea` wants 160 so the model has room to
 * compose; this is a lookup — "which rows are coral" — and the answer is at the top of the ranking
 * or not there at all. 60 keeps the call small and keeps a cricket badge out of a coral question.
 */
export async function placeFromInstruction(instruction, { k = PLACE_POOL } = {}) {
  const text = String(instruction ?? '').trim();
  if (!text) return { group: null, rejected: [], reason: 'say what to place' };

  /* The SUBJECT, not the sentence — the same parser the composer uses, for the same reason:
     embedding "add a coral on the board" ranks on "add" and "board" as much as on "coral". */
  const brief = briefFrom(text);
  const rows = await shortlistFor({ ...brief, subject: brief.subject || text }, { k });
  if (!rows.length) return { group: null, rejected: [], reason: 'nothing in the catalogue matched that' };

  const prompt = placePrompt({ instruction: text, lines: elementLines(rows) });
  const { raw, usage, model } = await callModel(prompt);

  const parsed = parseJson(raw);
  if (!parsed.ok) {
    return { group: null, rejected: [], shortlist: rows, usage, model,
             reason: `the model did not return JSON: ${parsed.error}`, raw: parsed.raw };
  }

  const { group, rejected } = groupFromModel(parsed.value, rows);
  if (!group) {
    return { group: null, rejected, shortlist: rows, usage, model,
             reason: 'none of the parts it named can go there' };
  }
  /* Only the rows the group actually uses travel back — the caller draws them, and shipping 60
     when it needs four is the same mistake the eval bundles made. */
  const used = new Set(group.elementIds);
  return { group, rejected, elements: rows.filter(r => used.has(r.id)), usage, model, pool: rows.length };
}
