/* ── Answering "how do I …" out of the help articles' own words ──────────────────────────────────
 *
 * Sandeep: *"baker can ask how can he do something in spattoo"*.
 *
 * ⚠️ NOTHING HERE WRITES AN ANSWER. 58 baker articles already exist, step by step, each carrying
 * `checked_against_app`. A model asked to explain a UI will eventually invent "Settings →
 * Advanced", and a confidently wrong instruction is worse than no answer — it also undoes the one
 * thing Spattoo claims over a general AI, which is that it does not make things up. So the only
 * model call is an embedding of the QUESTION; the reply is the article's own text.
 *
 * ⚠️ AND THE DATE TRAVELS WITH IT. A help article that stopped matching the app is a confidently
 * wrong instruction too — just an older one. `checked_against_app` comes back on every section so a
 * caller can say when it was last checked rather than implying it is current.
 */

import { supabase } from './supabase.js';
import { embedText } from './openai.js';
import { cosine, rankSections } from './helpRank.js';

/* ⚠️ `audience` TRAVELS WITH THE SECTION. Two corpora are indexed: the help articles, and the
   website's own FAQ (generated from spattoo-web's lib/faq.ts). The FAQ answers were written for
   somebody deciding whether to SIGN UP, not for a baker mid-task, so the panel says where an
   answer came from rather than passing a sales answer off as instructions.

   The whole corpus is 364 sections. Reading it per question is one query returning a few megabytes
   of float, which is wasteful at scale and completely fine at this one — and it keeps the service
   working on an environment where the pgvector RPC was never created, which is the situation the
   element index is actually in on dev. If this grows, an RPC goes here and the ranking below does
   not change. */
export async function searchHelp(question, { limit = 4, perDoc = 2 } = {}) {
  const text = String(question ?? '').trim();
  if (!text) return { sections: [], question: '' };

  const { embedding, usage } = await embedText(text);
  const { data, error } = await supabase
    .from('help_sections')
    .select('id, doc_slug, doc_title, heading, body, position, audience, checked_against_app, embedding');
  if (error) throw new Error(`help_sections read failed: ${error.message}`);

  const scored = (data ?? []).map((r) => {
    const v = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
    const { embedding: _drop, ...rest } = r;
    return { ...rest, score: v ? cosine(embedding, v) : 0 };
  });

  return { sections: rankSections(scored, { limit, perDoc }), question: text, usage };
}
