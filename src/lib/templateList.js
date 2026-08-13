// ── Which cake templates a baker shows ──────────────────────────────────────────────────────────
// "What designs can I order from this bakery?" — resolved once, here, so the baker's own browse and
// their customers' storefront cannot disagree about the answer.
//
// Three sources, in one rule:
//
//   global templates      baker_id IS NULL — Spattoo's shared library
//   + the baker's own     baker_id = this baker
//   − their exclusions    baker_template_exclusions, which only ever holds GLOBAL ids, so
//                         filtering by id can never drop a baker's own template
//
// Hidden tenant-wide by design: a global template a baker has switched off is gone from their own
// browse AND from their storefront, because "I don't make that" is one fact, not two settings.
//
// ── WHY THIS IS A MODULE AND NOT A SECOND COPY ──────────────────────────────────────────────────
// The storefront's facet chooser needs this list for an ANONYMOUS visitor, and GET /api/templates
// is behind requireAuth + design:create. The obvious move — write the same three lines again in a
// public route — is how lib/flavourList.js came to exist: two copies of "what does this baker
// offer" had already drifted by the time anyone looked, and that was one function, not a catalogue.
//
// ── WHAT A TEMPLATE IS, AND IS NOT ──────────────────────────────────────────────────────────────
// A template is a design somebody AUTHORED. It says the baker is willing and able to make it — not
// that they ever have, and for a global template not even that they designed it. Nothing built on
// this list may describe these as work the baker has done. See plans/storefront-facets.md.

import { supabase } from '../services/supabase.js';
import { config } from '../config.js';

const FIELDS = 'id, name, shape, tier_count, type, offering, baker_id, parent_template_id, design, thumbnail_url, sort_order, is_active';
const FILTER_JOIN = 'template_tags(tags(slug)), cake_template_attrs(min_weight_kg, min_age, max_age)';

const toPublicUrl = (key) => (key ? `${config.r2.publicUrl}/${key}` : null);

function shape({ template_tags, cake_template_attrs, ...t }) {
  const rawAttrs = cake_template_attrs;
  return {
    ...t,
    thumbnail_url: toPublicUrl(t.thumbnail_url),
    tag_slugs: (template_tags ?? []).map(r => r.tags?.slug).filter(Boolean),
    attrs: Array.isArray(rawAttrs) ? (rawAttrs[0] ?? null) : (rawAttrs ?? null),
  };
}

/** The global ids this baker has switched off. Never contains one of their own. */
export async function excludedTemplateIds(bakerId) {
  const { data } = await supabase
    .from('baker_template_exclusions')
    .select('template_id')
    .eq('baker_id', bakerId);
  return (data ?? []).map(e => e.template_id);
}

/**
 * Every template this baker offers.
 *
 * `bakerId` must already be resolved and trusted — this interpolates it into a PostgREST filter, so
 * a raw request parameter reaching here would inject `.or()` syntax (SEC-10). Callers resolve it
 * from a session or from a slug lookup, never from the query string.
 */
export async function templatesForBaker(bakerId, { type = null } = {}) {
  let query = supabase
    .from('cake_templates')
    .select(`${FIELDS}, ${FILTER_JOIN}`)
    .eq('is_active', true)
    .order('sort_order');

  if (type) query = query.eq('type', type);
  query = query.or(`baker_id.is.null,baker_id.eq.${bakerId}`);

  const excluded = await excludedTemplateIds(bakerId);
  if (excluded.length) query = query.not('id', 'in', `(${excluded.join(',')})`);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(shape);
}

/** Every template, unscoped. Admin only — no baker filter, no exclusions. */
export async function allTemplates({ type = null, bakerId = null } = {}) {
  let query = supabase
    .from('cake_templates')
    .select(`${FIELDS}, ${FILTER_JOIN}`)
    .eq('is_active', true)
    .order('sort_order');

  if (type) query = query.eq('type', type);
  // Admin may scope to one baker's view. Integer-coerced by the caller for the same SEC-10 reason.
  if (Number.isInteger(bakerId)) query = query.or(`baker_id.is.null,baker_id.eq.${bakerId}`);

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []).map(shape);
}

/**
 * The list as a CUSTOMER may see it, on a public storefront with no session.
 *
 * `design` is dropped. It is the full snapshot — every tier, decoration and texture — and it is
 * what a browsing customer least needs and a competitor most wants. The storefront shows a
 * thumbnail and a name; whoever actually STARTS from a template fetches it by id, at which point
 * they have asked for one rather than been handed all of them.
 */
export async function templatesForStorefront(bakerId) {
  const list = await templatesForBaker(bakerId);
  return list.map(({ design, ...t }) => t);
}
