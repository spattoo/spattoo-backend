// ── Which decorations a template uses ───────────────────────────────────────────────────────────
//
// `template_elements` is DERIVED data: every row is recomputed from the design, never stated by a
// person. This module is the one place that recomputes it, so the three routes that can write a
// design cannot disagree about what the table means.
//
// See migration 110 and plans/catalogue-findability.md (item 6).

import { supabase } from '../services/supabase.js';
import { elementIdsReferencedBy } from './promotionBundle.js';

/**
 * Make `template_elements` match this template's design.
 *
 * ⚠️ DELETE THEN INSERT, not insert-only. `PATCH /admin/templates/:id` has `design` in its allowed
 * list, so a design can change under an existing template — and an element removed from the design
 * must lose its row, or the table goes on describing a cake that no longer exists. Insert-only
 * would be right exactly once, at creation, and wrong forever after. Same semantics as the tag
 * editor's PUT, which replaces the whole set for the same reason.
 *
 * ⚠️ NEVER THROWS. Callers use it for its effect and ignore the result. A template save must not
 * fail because a derived index could not be updated — that trades a real user action for a
 * bookkeeping error — so this follows `auto_tag`'s precedent of failing quietly. The cost is that
 * drift is possible and invisible; the answer to drift is that the table can be rebuilt from
 * nothing by scripts/backfill-template-elements.mjs, which is exactly what "derived" buys.
 *
 * Returns the element ids written, or [] — useful to a caller that wants to log, never required.
 */
export async function syncTemplateElements(templateId, design) {
  if (!templateId) return [];
  try {
    const ids = design ? await elementIdsReferencedBy([design]) : [];

    const { error: delErr } = await supabase
      .from('template_elements')
      .delete()
      .eq('template_id', templateId);
    if (delErr) throw delErr;

    if (!ids.length) return [];

    const { error: insErr } = await supabase
      .from('template_elements')
      .insert(ids.map(element_id => ({ template_id: templateId, element_id })));
    if (insErr) throw insErr;

    return ids;
  } catch (err) {
    // Loud in the log, silent to the caller — see the note above.
    console.error(`[template_elements] sync failed for ${templateId}:`, err?.message ?? err);
    return [];
  }
}

/**
 * The templates that use an element — the question nothing could ask before this table.
 *
 * Asked before editing or retiring an element: a template using a retired one still renders and
 * quietly loses its move/resize caps and clustering, so "what would this break" has no answer in
 * the running system today.
 */
export async function templatesUsingElement(elementId) {
  if (!elementId) return [];
  const { data, error } = await supabase
    .from('template_elements')
    .select('template_id, cake_templates(id, name, baker_id, is_active)')
    .eq('element_id', elementId);
  if (error) throw error;
  return (data ?? []).map(r => r.cake_templates).filter(Boolean);
}
