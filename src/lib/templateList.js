// ── Which cake templates a baker shows ──────────────────────────────────────────────────────────
// "What designs can I order from this bakery?" — resolved once, here, so the baker's own browse and
// their customers' storefront cannot disagree about the answer.
//
// Two sources, then one filter:
//
//   global templates      baker_id IS NULL — Spattoo's shared library
//   + the baker's own     baker_id = this baker
//   ∩ their catalogue     baker_template_settings.offered — what they have CHOSEN to offer
//
// ⚠️ AN INTERSECTION, NOT A SUBTRACTION, SINCE 2026-09-28. This used to subtract
// `baker_template_exclusions` (absence meant offered); it now intersects the catalogue (absence
// means NOT offered). The polarity is inverted, so an empty result is the correct answer for a
// baker who has curated nothing, rather than a bug — see `offeredTemplateIds`.
//
// Tenant-wide by design: the catalogue is one fact, not two settings, so it governs the baker's own
// browse AND their storefront. What it does NOT govern is Library (GET /api/baker/catalogue), which
// must keep listing everything a baker COULD offer or there would be nothing to curate from.
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
// ⚠️ `search_slugs` IS HERE AND `design` IS NOT, and that pairing is the whole design of this row.
// The list carries what BROWSING needs; the design is fetched by id for the one template somebody
// opens. `search_slugs` is the cheap half of what the design knows — element names, element tags,
// and the words piped on the cake — derived once on save so the browser can search them without
// the megabytes. Measured on dev: 53 bytes a row on average, 133 at worst.
const FIELDS = 'id, name, shape, tier_count, type, offering, baker_id, parent_template_id, thumbnail_url, sort_order, is_active, search_slugs';
const FILTER_JOIN = 'template_tags(tags(slug)), cake_template_attrs(min_weight_kg, min_age, max_age)';

const toPublicUrl = (key) => (key ? `${config.r2.publicUrl}/${key}` : null);

/* `offeredIds` is a Set the CALLER resolved once — never a lookup per row. Absent (admin's
   `allTemplates`, which has no baker to ask about) means "no catalogue is known", and then `offered`
   is omitted rather than guessed: a row saying `offered: false` to a caller that cannot know would be
   a lie a client could act on.

   ⚠️ `source` IS DERIVED, NOT STORED. `baker_id IS NULL` is Spattoo's shared library and anything
   else is this baker's own work — the one fact that decides what a baker may DELETE (their own only;
   `DELETE /baker/templates/:id` is scoped `.eq('baker_id', req.bakerId)` and 404s on a global). It is
   sent as a word because every client was otherwise re-deriving it from `baker_id`, and two of them
   had already done it differently. */
function shape({ template_tags, cake_template_attrs, ...t }, offeredIds = null) {
  /* ⚠️ A SET OR NOTHING. The caller is meant to pass a Set it resolved once, but anything else has
     to mean "no catalogue is known" rather than throw — a number arrived here from `.map(shape)`
     and took the whole route down with a 500. Checking the type is cheaper than trusting every
     future call site to remember what `.map` does with its second argument. */
  const offered = offeredIds instanceof Set ? offeredIds : null;
  const rawAttrs = cake_template_attrs;
  return {
    ...t,
    thumbnail_url: toPublicUrl(t.thumbnail_url),
    tag_slugs: (template_tags ?? []).map(r => r.tags?.slug).filter(Boolean),
    attrs: Array.isArray(rawAttrs) ? (rawAttrs[0] ?? null) : (rawAttrs ?? null),
    source: t.baker_id ? 'mine' : 'spattoo',
    ...(offered ? { offered: offered.has(t.id) } : null),
  };
}

/* ⚠️ `excludedTemplateIds` IS GONE (2026-09-28), along with `baker_template_exclusions`.
   Sandeep: *"there are no bakers existing in prod. so prev logic of exclusions is not valid. its
   only the catalogue that needs to be showed now."* The opt-OUT half was kept alive only because a
   released bundle might still POST an exclusion set — with no production bakers there is no such
   bundle to protect, so the two halves stopped needing to retire in order. Migration 117 drops the
   table; the routes that wrote it went with it. See spattoo-docs/plans/baker-catalogue.md. */

/**
 * The template ids this baker has CHOSEN to offer — their catalogue.
 *
 * ⚠️ THIS IS NOW THE ONLY THING `templatesForBaker` READS (2026-09-28). It was the opt-IN half of a
 * pair, held back until the new endpoints shipped — Sandeep: *"new endpoints. once they are working
 * we wil drop the old."* The opt-OUT half (`excludedTemplateIds`, `baker_template_exclusions`) is
 * deleted, because with no production bakers there was no released bundle left to protect.
 *
 * ⚠️ IT SEEDS NOTHING, SO AN EMPTY ANSWER IS THE NORMAL ANSWER. Migration 115 created no rows.
 * Every baker offers nothing until they curate, and both the storefront gallery and the designer's
 * Catalogue flyout are empty until then. Measured on dev the day this landed: 23 of 24 bakers.
 *
 * ⚠️ THE POLARITY IS THE REVERSE OF THE FUNCTION ABOVE. Absence means not offered: nothing is in a
 * catalogue until it is chosen, a baker's own saved designs included — saving is a working action,
 * selling is a decision. `offered = false` is a DELIBERATE removal, filtered out here exactly like a
 * template never chosen; the distinction is kept in the table for a future auto-add, not for this
 * query.
 */
export async function offeredTemplateIds(bakerId) {
  const { data } = await supabase
    .from('baker_template_settings')
    .select('template_id')
    .eq('baker_id', bakerId)
    .eq('offered', true);
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
  /* ── THE CATALOGUE IS THE ONLY ANSWER NOW (cutover completed 2026-09-28) ──────────────────────
   * Sandeep: *"there are no bakers existing in prod. so prev logic of exclusions is not valid. its
   * only the catalogue that needs to be showed now."*
   *
   * This used to resolve "global library + their own, MINUS what they switched off", and the
   * opt-OUT half survived the storefront cutover for one reason only: a released bundle could still
   * POST an exclusion set, which under the new meaning would have offered exactly the templates the
   * baker had switched off. With no production bakers there is no such bundle and no such risk, so
   * the sequencing that kept both halves alive no longer applies.
   *
   * ⚠️ THIS NOW GOVERNS THE BAKER'S BROWSE TOO, NOT ONLY THE STOREFRONT. `GET /api/templates` shares
   * this resolver, so the designer's Catalogue flyout shows the catalogue for a baker and for a
   * signed-in customer alike — which is what the flyout is called and what it should always have
   * been. Two surfaces are deliberately NOT affected:
   *   · Library (`GET /baker/catalogue`) resolves elsewhere and still lists everything a baker
   *     COULD offer, which is what makes curation possible at all.
   *   · The start chooser is customers-only (CakeDesigner.jsx), so a baker whose catalogue is empty
   *     is never blocked from starting a cake — they begin from Library or from scratch.
   */
  const offered = await offeredTemplateIds(bakerId);

  /* ⚠️ EMPTY MEANS EMPTY, AND IT MUST RETURN BEFORE THE QUERY IS BUILT. Absence is the whole
     polarity of this table: a baker who has curated nothing offers nothing. Handing an empty list
     to a PostgREST `in` filter is the classic way that becomes "no filter at all" and serves the
     entire library as though it were their catalogue — the exact inversion this table exists to
     prevent. Migration 115 seeded nothing, so a new baker legitimately lands here: this is the
     common path, not the edge. */
  if (!offered.length) return [];

  let query = supabase
    .from('cake_templates')
    .select(`${FIELDS}, ${FILTER_JOIN}`)
    .eq('is_active', true)
    .order('sort_order')
    .in('id', offered);

  if (type) query = query.eq('type', type);
  /* Still tenant-scoped. `baker_template_settings` is keyed by baker, so a foreign id cannot
     realistically appear — but the scope is what MAKES that true rather than something this query
     is entitled to assume. */
  query = query.or(`baker_id.is.null,baker_id.eq.${bakerId}`);

  const { data, error } = await query;
  if (error) throw error;

  /* Every row here is offered by construction, so the label is a constant. It is still emitted,
     because the shape of a list row must not depend on how it was resolved — and because the
     Catalogue flyout reads `offered` off the row to drive "move back to library". */
  return (data ?? []).map(t => shape(t, new Set(offered)));
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
  /* ⚠️ NOT `.map(shape)`. `Array.map` passes (element, INDEX, array), so a bare reference feeds the
     index into `shape`'s second parameter — which became `offeredIds` when this row learned about
     catalogues. Row 0 got `0` (falsy, harmless) and row 1 got `1`, so `offeredIds.has(...)` threw
     `TypeError: offeredIds.has is not a function` on every list of two or more. It 500'd ONLY here:
     `templatesForBaker` already passes its own lambda, which is why the baker app and the public
     storefront route kept working while a customer's `/api/templates` failed. Sentry caught it;
     the customer saw "No templates yet", because the client turns a failed fetch into an empty
     list. See the guard in `shape` for the other half of this. */
  return (data ?? []).map(t => shape(t));
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
  /* ⚠️ `offered` IS STRIPPED HERE, AND THIS IS THE SEAM THAT EXISTS FOR EXACTLY THIS. A flag saying
     which of a baker's designs are NOT in their catalogue is competitor-facing information about what
     they chose not to sell — the same reasoning that took `design` off this route. `source` stays: a
     customer seeing that a cake is the baker's own work rather than Spattoo's is a point in the
     baker's favour, and the storefront already says whose designs these are.

     CUT OVER 2026-09-28: this now returns only offered templates, so the flag is redundant rather
     than sensitive. The strip stays anyway — it costs nothing, and it keeps the guarantee true by
     construction if a future branch ever returns a mixed list again. */
  const rows = await templatesForBaker(bakerId);

  /* ── ⚠️ PHOTOS ARE HELD BACK FROM THE CUSTOMER, AND THIS LINE IS MEANT TO BE DELETED ───────────
   * A catalogue photo (migration 116, `type = 'photo'`) is a picture of finished work with no
   * design. The baker's Catalogue shows them correctly; the CUSTOMER's gallery cannot yet, and the
   * failure is silent rather than visual: `DesignFacet`'s tile writes `design.kind = 'template'`,
   * but `toOrderPayload` sends no `templateId` and `buildInstructions` never names the template, so
   * the identity of the pick reaches the baker through nothing at all. With no `designSnapshot` the
   * flavour guard in `validateOrderBody` is skipped too — so the order is ACCEPTED, 201, reading
   * `shape: 'round'` (the insert's default) and nothing else. An unfulfillable order that looks
   * successful to the customer is worse than a cake they could not find.
   *
   * The fix is already designed and cheap: `thumbnailUrl = designThumbnailKey ?? refKeys[0]` in
   * routes/orders.js means sending the photo's R2 key as `referenceKeys` makes the photo the
   * order's own thumbnail — the existing reference-image enquiry path, which is exactly what
   * Sandeep specified ("it should take the same existing path (reference image) order path").
   * Delete this filter the day that view lands; nothing else here needs to change. */
  return rows
    .filter(t => t.type !== 'photo')
    .map(({ offered, ...t }) => t);
}
