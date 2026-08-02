// ── The baker's flavour list (resolution) ─────────────────────────────────────
// "What does this baker offer, and what does it cost?" — resolved once, here, so the
// baker's settings screen and the public storefront cannot disagree about the answer.
//
// Two sources, unioned, exactly as GET /api/flavours has always done:
//
//   flavours          the global master list, shared by every baker
//        ↓ overlaid per baker by
//   baker_flavour_settings   sparse: a row exists only where this baker has said
//                            something — switched it off, priced it, renamed it
//
//   baker_flavours    the baker's own recipes. No overlay: they own the row, so the
//                     price sits on it directly. The overlay exists only because
//                     global flavours are shared.
//
// ── "NO ROW" IS A STATE, NOT AN ABSENCE ──────────────────────────────────────
// A global flavour with no settings row is offered, at no stated price, under its global
// name. That is not an edge case to be tidied away: it is what EVERY baker has for a
// flavour added to the global list after they last touched this screen. So `offered`
// defaults true and `pricePerKg` resolves to null, and the answer to "what does it cost"
// is "ask" — never zero, and never a hidden flavour.
//
// ── PRICE VISIBILITY IS APPLIED HERE, NOT IN THE CLIENT ──────────────────────
// `forCustomer()` OMITS pricePerKg entirely when the viewer is not entitled to it, rather
// than sending the number and trusting the storefront not to render it. A price the
// browser never receives cannot be leaked by a component that forgot, or read out of a
// network tab by the bakery down the road. Since that is the whole point of the setting,
// it has to be enforced where the data is assembled.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
// Not an estimate, and not a quote. A per-kg rate prices the CAKE, not the artwork on it,
// so every published figure is a floor. Custom work still goes to the baker for a real
// quote — PRICING_AND_QUOTE_PLAN §1 is untouched by anything here.

import { supabase } from '../services/supabase.js';
import { conflictsForBaker } from './flavourDietary.js';

/** Price visibility values, in increasing order of disclosure. */
export const PRICE_VISIBILITY = ['private', 'verified', 'public'];

/**
 * May a viewer see this baker's prices?
 * `verified` means the customer has proved a phone or email — an authenticated session
 * on the storefront. Anything we do not recognise is treated as 'private': an unknown
 * value must fail closed, or a typo in the column publishes every baker's rates.
 */
export function pricesVisibleTo(baker, { verified = false } = {}) {
  switch (baker?.price_visibility) {
    case 'public':   return true;
    case 'verified': return !!verified;
    default:         return false;
  }
}

/**
 * The baker's full flavour list, with everything resolved. Internal shape — callers
 * decide what a given viewer is allowed to see (see `forCustomer`).
 *
 *   [{ id, source, name, description, sort_order, offered, pricePerKg, conflicts_with }]
 *
 * `name` is already the baker's display_name where they set one, so no caller has to
 * remember the fallback.
 */
export async function resolveFlavours(bakerId) {
  const [{ data: globals }, { data: settings }, { data: custom }] = await Promise.all([
    supabase.from('flavours')
      .select('id, name, description, sort_order, sponge_color, filling_color')
      .eq('is_active', true)
      .order('sort_order').order('name'),
    supabase.from('baker_flavour_settings')
      .select('flavour_id, offered, price_per_kg, display_name')
      .eq('baker_id', bakerId),
    supabase.from('baker_flavours')
      .select('id, name, description, sort_order, price_per_kg, sponge_color, filling_color')
      .eq('baker_id', bakerId).eq('is_active', true)
      .order('sort_order').order('name'),
  ]);

  const overlay = new Map((settings ?? []).map(s => [s.flavour_id, s]));

  const globalRows = (globals ?? []).map(f => {
    const s = overlay.get(f.id);
    return {
      id: f.id,
      source: 'global',
      // The baker's own wording wins where they gave one.
      name: s?.display_name?.trim() || f.name,
      description: f.description,
      sort_order: f.sort_order,
      // No row means offered. See "NO ROW IS A STATE" above.
      offered: s ? s.offered !== false : true,
      pricePerKg: s?.price_per_kg ?? null,
      // Authored globally — Red Velvet is crimson in every kitchen — so there is nothing
      // to overlay here. null means "not authored yet"; the renderer draws a neutral
      // sponge rather than guessing a colour from the name.
      spongeColor:  f.sponge_color  ?? null,
      fillingColor: f.filling_color ?? null,
    };
  });

  const customRows = (custom ?? []).map(f => ({
    id: f.id,
    source: 'baker',
    name: f.name,
    description: f.description,
    sort_order: f.sort_order,
    // A baker's own flavour exists because they made it. There is nothing to switch off
    // — removing it is is_active on the row itself, which this query already filters.
    offered: true,
    pricePerKg: f.price_per_kg ?? null,
    // Their own recipe, so their own colours — there is no global row to inherit from.
    spongeColor:  f.sponge_color  ?? null,
    fillingColor: f.filling_color ?? null,
  }));

  // One map over both kinds, which is why neither branch above has to know which it is.
  const conflicts = await conflictsForBaker(bakerId);
  return [...globalRows, ...customRows].map(f => ({ ...f, conflicts_with: conflicts[f.id] ?? [] }));
}

/**
 * The same list as a CUSTOMER may see it: offered flavours only, and prices only where
 * this baker has said so.
 *
 * `pricePerKg` is absent — not null — when prices are not visible. The distinction is
 * deliberate: null means "offered, ask for a price", and a storefront should say so;
 * absent means the field was never sent, and there is nothing on the client to leak.
 */
export async function flavoursForCustomer(baker, { verified = false } = {}) {
  if (baker?.show_flavours === false) return [];

  const all = await resolveFlavours(baker.id);
  const withPrices = pricesVisibleTo(baker, { verified });

  return all
    .filter(f => f.offered)
    .map(({ offered, pricePerKg, ...rest }) => (
      withPrices ? { ...rest, pricePerKg } : rest
    ));
}
