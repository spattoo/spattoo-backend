// ── What a template's design implies, kept in step with it ─────────────────────────────────────
//
// Two derived things, from ONE walk of the design:
//
//   template_elements          which catalogue decorations the design uses
//   cake_templates.search_slugs  the words it can be FOUND by, beyond its name and its own tags
//
// Both are DERIVED: every value is recomputed from the design, never stated by a person. This
// module is the one place that recomputes them, so the three routes that can write a design cannot
// disagree about what they mean.
//
// See migrations 110 and 112, and plans/catalogue-findability.md (items 6 and 7).

import { supabase } from '../services/supabase.js';
import { elementIdsReferencedBy } from './promotionBundle.js';

/**
 * The words piped on the cake.
 *
 * ⚠️ TWO KEYS, AND `writings` IS THE ONE THAT CARRIES THEM. A first cut read only `texts[].content`
 * and produced ZERO terms across the whole catalogue — every template's `texts` is empty, because a
 * message on a cake is a `writings[]` entry with a `text` field (useCakeDesign DEFAULT_WRITING).
 * The dry run looked healthy and was silently missing half of what this exists to index; it was
 * caught only because the term count came back exactly equal to the element count.
 * `texts` is still read: it is a real design key, and an older saved design may carry one.
 *
 * ⚠️ SKIPS `'Your Text'` — the content a freshly added TEXT carries. Without it every design whose
 * text block was ever touched answers to "your text". `writings` needs no such guard: its default
 * is an empty string, which is falsy and drops out on its own.
 *
 * ⚠️ AND STRIPS `{name}` / `{number}`. Those are SLOTS a customer fills in (see spattoo-core
 * text-placeholders), not words the template says. "Happy {name}" contributes "happy"; a slot left
 * whole would make every personalised template match a search for "name".
 *
 * ⚠️ `nameBlocks` IS DELIBERATELY NOT READ. Fondant letter blocks spell a PERSON'S NAME, which is
 * the least useful thing to find a catalogue template by and the closest this design comes to
 * personal data. It is geometry here anyway — `{ zone, blocks: [{u, v}] }`, not a string.
 */
function textTermsIn(design) {
  const out = [];
  const add = (raw) => {
    const s = typeof raw === 'string' ? raw.trim() : '';
    if (!s || s === 'Your Text') return;
    const bare = s.replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
    if (bare) out.push(bare.toLowerCase());
  };
  for (const w of design?.writings ?? []) add(w?.text);
  for (const t of design?.texts ?? []) add(t?.content);
  return out;
}

/**
 * What the decorations on the cake are called, and what they are tagged.
 *
 * ⚠️ NAMES CARRY THIS TODAY, and that is measured rather than assumed: every element in use is
 * UNTAGGED in both dev (56 of 56) and prod (48 of 48), avg_tags_per_element 0.00. The tag half
 * below is written and currently yields nothing — it costs one query and starts working the day
 * somebody tags the catalogue, without another deploy.
 *
 * Both the slug and the display name, for the reason `matchesTemplateSearch` already gives: they
 * diverge exactly where somebody is most likely to type.
 */
async function elementTermsFor(elementIds) {
  if (!elementIds.length) return [];
  const out = [];

  const { data: els, error: elErr } = await supabase
    .from('cake_elements').select('id, name').in('id', elementIds);
  if (elErr) throw elErr;
  for (const e of els ?? []) if (e?.name) out.push(String(e.name).toLowerCase());

  const { data: tagRows, error: tagErr } = await supabase
    .from('element_tags').select('tags(slug, name)').in('element_id', elementIds);
  if (tagErr) throw tagErr;
  for (const r of tagRows ?? []) {
    if (r?.tags?.slug) out.push(String(r.tags.slug).toLowerCase());
    if (r?.tags?.name) out.push(String(r.tags.name).toLowerCase());
  }

  return out;
}

/**
 * Make both derived things match this template's design.
 *
 * ⚠️ DELETE THEN INSERT for the join rows, not insert-only. `PATCH /admin/templates/:id` has
 * `design` in its allowed list, so a design can change under an existing template — and an element
 * removed from it must lose its row, or the table goes on describing a cake that no longer exists.
 * Insert-only would be right exactly once, at creation, and wrong forever after. `search_slugs` is
 * overwritten wholesale for the same reason.
 *
 * ⚠️ NEVER THROWS. Callers use it for its effect and ignore the result. A template save must not
 * fail because derived data could not be written — that trades a real user action for a bookkeeping
 * error — so this follows `auto_tag`'s precedent of failing quietly. The cost is that drift is
 * possible and invisible; the answer is that both outputs can be rebuilt from nothing by
 * scripts/backfill-template-elements.mjs, which is exactly what "derived" buys.
 *
 * ⚠️ `search_slugs` IS SEARCHED AND NEVER DRAWN. The filter's chips come from `template_tags`,
 * which a person curated. Folding these terms in there would put every element's name into the
 * funnel as a chip. Search widens; the filter stays legible.
 */
export async function syncTemplateDerived(templateId, design) {
  if (!templateId) return { elementIds: [], terms: [] };
  try {
    const elementIds = design ? await elementIdsReferencedBy([design]) : [];

    const { error: delErr } = await supabase
      .from('template_elements').delete().eq('template_id', templateId);
    if (delErr) throw delErr;

    if (elementIds.length) {
      const { error: insErr } = await supabase
        .from('template_elements')
        .insert(elementIds.map(element_id => ({ template_id: templateId, element_id })));
      if (insErr) throw insErr;
    }

    // Deduped: several sprinkles of the same element, or two texts saying the same thing, are one
    // word to search by. Sorted so a stored row is stable and a diff between two backfills is real.
    const terms = [...new Set([...(await elementTermsFor(elementIds)), ...textTermsIn(design)])].sort();

    const { error: updErr } = await supabase
      .from('cake_templates').update({ search_slugs: terms }).eq('id', templateId);
    if (updErr) throw updErr;

    return { elementIds, terms };
  } catch (err) {
    // Loud in the log, silent to the caller — see the note above.
    console.error(`[template derived] sync failed for ${templateId}:`, err?.message ?? err);
    return { elementIds: [], terms: [] };
  }
}

/**
 * The templates that use an element — the question nothing could ask before `template_elements`.
 *
 * Asked before editing or retiring an element: a template using a retired one still renders and
 * quietly loses its move/resize caps and clustering, so "what would this break" has no answer in
 * the running system otherwise.
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
