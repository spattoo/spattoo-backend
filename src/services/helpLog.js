/* ── Recording what was asked, and whether it landed ─────────────────────────────────────────────
 *
 * ⚠️ LOGGING MUST NEVER COST SOMEBODY THEIR ANSWER. Every function here swallows its own errors.
 * A broken insert, a missing table, a migration not yet applied — none of that is a reason for a
 * baker's question to fail. The log is for us; the answer is for them, and the answer wins.
 *
 * The thing worth catching is in migration 143: the common failure is not an empty panel, it is a
 * confident card that does not contain the answer. Nothing measurable sees that, so `helpful` is
 * set by a person pressing a button and by nothing else.
 */

import { supabase } from './supabase.js';

/** Records the question and what came back. Returns the row id, or null if anything went wrong. */
export async function logQuestion({ question, sections, bakerId = null, userId = null }) {
  try {
    const top = sections?.[0] ?? null;
    const { data, error } = await supabase
      .from('help_questions')
      .insert({
        baker_id: bakerId,
        user_id: userId,
        question: String(question ?? '').slice(0, 600),
        result_count: sections?.length ?? 0,
        top_score: top ? Number(top.score) : null,
        top_doc_slug: top?.doc_slug ?? null,
        top_heading: top?.heading ?? null,
      })
      .select('id')
      .single();
    if (error) return null;
    return data?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Marks an asked question as having answered or not.
 *
 * ⚠️ SCOPED TO THE PERSON WHO ASKED IT. The id travels to the browser and comes back, so without
 * this anybody holding an id could rewrite anybody's verdict — and the whole value of the table is
 * that `helpful: false` means a real baker said so.
 */
export async function markAnswered({ id, helpful, userId }) {
  try {
    if (!id || !userId) return false;
    const { error, count } = await supabase
      .from('help_questions')
      .update({ helpful: !!helpful, answered_at: new Date().toISOString() }, { count: 'exact' })
      .eq('id', id)
      .eq('user_id', userId);
    return !error && (count ?? 0) > 0;
  } catch {
    return false;
  }
}
