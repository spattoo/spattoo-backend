// ── Dietary requirements (read-through cache over the dietary_requirements table) ─
// Eggless / vegan / Jain / nut-free / gluten-free / dairy-free live in the DB so they
// are managed data, not a code array — add or retire one by editing rows. This module
// is the ONE place that reads them, with a small in-process cache (the vocabulary is
// tiny and changes rarely). Deliberately the same shape as orderStatuses.js: same
// bounded-lookup problem, same solution, so there is one pattern to learn.
//
// Callers/HTTP speak readable KEYS ('eggless'); order_dietary_requirements stores the
// compact surrogate `id`, so this module bridges key↔id at the DB boundary — magic ids
// stay out of route code while the table that grows with orders stays lean.
// See supabase/dietary_requirements.sql.

import { supabase } from '../services/supabase.js';

let cache = null;          // array of requirement rows, ordered by sort_order
let loadedAt = 0;
const TTL_MS = 5 * 60 * 1000;   // refresh at most every 5 min

async function load() {
  const { data, error } = await supabase
    .from('dietary_requirements')
    .select('id, key, label, kind, sort_order, is_active')
    .eq('is_active', true)
    .order('sort_order');
  if (error) throw new Error(`Failed to load dietary_requirements: ${error.message}`);
  cache = data ?? [];
  loadedAt = Date.now();
  return cache;
}

// All active requirements, in display order. Cached.
export async function getDietaryRequirements() {
  if (!cache || Date.now() - loadedAt > TTL_MS) return load();
  return cache;
}

export async function getValidKeys() {
  return (await getDietaryRequirements()).map(r => r.key);
}

// ── key ↔ surrogate id bridge ─────────────────────────────────────────────────
// Resolve keys to ids for writing. Unknown keys are SKIPPED here rather than thrown,
// because the caller has already rejected them — see validateDietaryKeys, which is
// what turns an unknown key into a 400 before anything is written. Skipping is the
// safe residual behaviour: a requirement is never silently invented.
export async function idsForKeys(keys) {
  const rows = await getDietaryRequirements();
  return (keys ?? [])
    .map(k => rows.find(r => r.key === k)?.id)
    .filter(id => id != null);
}

// Validate a requested set of keys. Returns an error STRING (the house convention —
// see validateOrderBody) or null when the input is acceptable.
//
// Absent and empty are both fine and mean "no requirement stated". That is not the
// same as "no requirement exists", and nothing downstream should render it as though
// the customer confirmed the cake may contain anything.
export async function validateDietaryKeys(keys) {
  if (keys == null) return null;
  if (!Array.isArray(keys)) return 'dietaryRequirementKeys must be an array of keys';
  const valid = await getValidKeys();
  const unknown = [...new Set(keys.filter(k => !valid.includes(k)))];
  if (unknown.length) {
    return `Unknown dietary requirement key(s): ${unknown.join(', ')}. Valid: ${valid.join(', ')}`;
  }
  return null;
}

// Replace the requirement set on an order. Used on create and on edit — a set has no
// natural partial update, and delete-then-insert keeps the stored set exactly equal to
// what the caller asked for rather than accumulating stale rows.
//
// `source` records WHO asserted it — 'customer' or 'baker' (a baker recording what a
// customer told them). It is NOT a claim by Spattoo that the requirement is met; see
// the header of dietary_requirements.sql for why that distinction is load-bearing.
export async function setOrderDietaryRequirements(orderId, keys, source) {
  const ids = await idsForKeys(keys);

  const { error: delErr } = await supabase
    .from('order_dietary_requirements')
    .delete()
    .eq('order_id', orderId);
  if (delErr) throw new Error(delErr.message);

  if (!ids.length) return [];

  const rows = ids.map(requirement_id => ({ order_id: orderId, requirement_id, source }));
  const { error: insErr } = await supabase.from('order_dietary_requirements').insert(rows);
  if (insErr) throw new Error(insErr.message);
  return ids;
}

// Force a reload (e.g. after editing the table). Mostly for tests/ops.
export function invalidateDietaryRequirementCache() {
  cache = null;
}

// ── per-baker availability ────────────────────────────────────────────────────
// Not every bakery does vegan. This flags each requirement with whether THIS baker
// deals in it, so the order form can act on it — see supabase/baker_dietary_options.sql
// for why the two kinds must act differently and why an allergen is never hidden.
//
// Returns the full vocabulary annotated with `offered`, NOT a filtered list. The
// filtering rule differs by kind and belongs on the surface that renders, not here — and
// a route that silently dropped rows would make an un-offered allergen indistinguishable
// from one that doesn't exist, which is the one confusion that could lose an allergy.
export async function requirementsForBaker(bakerId) {
  const all = await getDietaryRequirements();
  if (!bakerId) return all.map(r => ({ ...r, offered: true }));

  const { data, error } = await supabase
    .from('baker_dietary_exclusions')
    .select('requirement_id')
    .eq('baker_id', bakerId);

  // Fail soft, like the flavour conflicts: an unreadable exclusion list must not take
  // out the dietary picker. Defaulting to "offered" shows a customer MORE options than
  // the baker wanted — annoying, and recoverable in the conversation that follows.
  // Defaulting the other way would hide a requirement the bakery actually caters to.
  if (error) return all.map(r => ({ ...r, offered: true }));

  const off = new Set((data ?? []).map(r => r.requirement_id));
  return all.map(r => ({ ...r, offered: !off.has(r.id) }));
}

// Replace-set of the requirements a baker does NOT offer. Mirrors
// PUT /api/baker/flavours/exclusions exactly.
export async function setBakerDietaryExclusions(bakerId, keys) {
  const ids = await idsForKeys(keys);

  const { error: delErr } = await supabase
    .from('baker_dietary_exclusions')
    .delete()
    .eq('baker_id', bakerId);
  if (delErr) throw new Error(delErr.message);

  if (!ids.length) return [];
  const rows = ids.map(requirement_id => ({ baker_id: bakerId, requirement_id }));
  const { error: insErr } = await supabase.from('baker_dietary_exclusions').insert(rows);
  if (insErr) throw new Error(insErr.message);
  return ids;
}
