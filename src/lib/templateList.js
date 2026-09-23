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

// ⚠️ NO `design`, DELIBERATELY. A list row is what BROWSING needs: a name, a picture, and the
// fields the filters read (tag_slugs and attrs, added by `shape` below). The design is the full
// snapshot — every tier, decoration and texture — so carrying it here grew the response with the
// catalogue AND with how elaborate each cake is, handing over N designs so that ONE could be
// opened.
//
// Whoever actually starts from a template fetches it by id (GET /templates/:id, which keeps its own
// field list). Every caller already handles its absence: the designer's card reads `t.design ??
// null` and fetches by id when it is missing, which is the path a storefront customer has always
// taken. The cost is one small request on the template someone chose, instead of a large one on
// every template they did not.
//
// See plans/template-browsing-at-scale.md — this is Layer 1, and it is what keeps the filters
// client-side and correct.
const FIELDS = 'id, name, shape, tier_count, type, offering, baker_id, parent_template_id, thumbnail_url, sort_order, is_active';
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
 * ⚠️ THIS NO LONGER STRIPS ANYTHING, AND IT STAYS ANYWAY. `design` was dropped here and nowhere
 * else — it is what a browsing customer least needs and a competitor most wants — until the baker's
 * own browse turned out to have the same problem for a different reason (size), and FIELDS stopped
 * selecting it at all. The customer protection is now structural rather than a map over the result.
 *
 * Kept as the named seam for "the customer's view": the storefront asks a different question from
 * the baker's browse even while the answer is the same, and the next thing that must not reach an
 * anonymous visitor then has one obvious place to be removed. Deleting it would put that decision
 * back in a route.
 */
export async function templatesForStorefront(bakerId) {
  return templatesForBaker(bakerId);
}
