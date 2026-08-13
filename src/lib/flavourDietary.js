// ── Flavour ↔ dietary requirement conflicts (resolution) ──────────────────────
// "You asked for nut-free, but Hazelnut Praline normally contains nuts — please
// confirm with ABC Bakery." This module answers the question behind that sentence:
// for a given baker, which requirements does each flavour conflict with?
//
// It is the ONE place the two-layer resolution lives, so no route re-derives it:
//
//   global baseline (flavour_dietary_conflicts)      "hazelnut contains nuts" — true
//                                                     for every baker, authored once
//        ↓ overridden per baker by
//   sparse override (baker_flavour_dietary_conflicts) conflicts=true  adds one
//                                                     conflicts=false clears one
//        ↓
//   effective set of requirement KEYS per flavour id
//
// A missing override row means "no opinion" — fall through to the baseline. That is
// why the override stores a boolean rather than being a delete-list: a baker who really
// does make a nut-free hazelnut sponge has to be able to say so, or our baseline
// becomes a claim about their kitchen that they cannot correct.
//
// NEVER A GATE. Callers use this to WARN and to name the baker to talk to. Nothing here
// may be used to disable a flavour or reject an order: ToS §3.4 says Spattoo records and
// verifies nothing, B5.9 puts the decision with the baker, C2.3 tells the customer to
// confirm anyway. Blocking on this data would turn that disclaimer into a representation
// — and the data is human-authored, so it will drift and would block real orders.
// See supabase/flavour_dietary.sql.

import { supabase } from '../services/supabase.js';
import { getDietaryRequirements } from './dietaryRequirements.js';
import { captureError } from './telemetry.js';

// ── READS FAIL SOFT, ON PURPOSE ───────────────────────────────────────────────
// The read path hangs off GET /api/flavours, which is what populates the flavour picker
// on the order form. If these tables are unreadable — most obviously because the code
// deployed before supabase/flavour_dietary.sql was run by hand — a thrown error would
// take out the flavour list itself, and nobody could order a cake at all.
//
// Trading a missing WARNING for a broken ORDER FORM is never the right trade: without
// this feature the product is exactly where it was last week, and the ToS has always
// told the customer to confirm with the baker. So a read failure degrades to "nothing
// declared" and is reported to telemetry rather than raised.
//
// WRITES DO NOT fail soft. A silent write failure would tell a baker their declaration
// was saved when it was not, which is worse than an error message.
async function softRead(promise, action) {
  try {
    return await promise;
  } catch (err) {
    captureError(err instanceof Error ? err : new Error(String(err)), {
      action, severity: 'warning', tags: { feature: 'flavour-dietary' },
    });
    return null;
  }
}

// The baseline is global and bounded (flavours × requirements), read on every order-form
// load and changed only when an admin edits it — exactly the shape orderStatuses.js and
// dietaryRequirements.js already cache, so it caches the same way rather than inventing
// a third pattern.
let baselineCache = null;
let baselineLoadedAt = 0;
const TTL_MS = 5 * 60 * 1000;

async function loadBaseline() {
  const { data, error } = await supabase
    .from('flavour_dietary_conflicts')
    .select('flavour_id, requirement_id');
  if (error) throw new Error(`Failed to load flavour_dietary_conflicts: ${error.message}`);
  baselineCache = data ?? [];
  baselineLoadedAt = Date.now();
  return baselineCache;
}

async function getBaseline() {
  if (!baselineCache || Date.now() - baselineLoadedAt > TTL_MS) return loadBaseline();
  return baselineCache;
}

export function invalidateFlavourDietaryCache() {
  baselineCache = null;
}

// requirement id → key, via the existing lookup. Routes and HTTP speak keys; only the
// tables speak surrogate ids, and the translation happens here at the boundary.
async function keyById() {
  const rows = await getDietaryRequirements();
  return new Map(rows.map(r => [r.id, r.key]));
}

async function idByKey() {
  const rows = await getDietaryRequirements();
  return new Map(rows.map(r => [r.key, r.id]));
}

// ── the baseline alone, keyed by global flavour id ────────────────────────────
// Exposed because the baker's settings screen has to show what it is overriding — a
// toggle whose default the baker cannot see is a toggle they cannot reason about.
export async function baselineConflictKeys() {
  const [rows, k] = await Promise.all([
    softRead(getBaseline(), 'flavourDietary.baseline').then(r => r ?? []),
    keyById(),
  ]);
  const out = {};
  for (const r of rows) {
    const key = k.get(r.requirement_id);
    if (!key) continue;                       // requirement retired; ignore, don't invent
    (out[r.flavour_id] ??= []).push(key);
  }
  return out;
}

// ── the effective answer for one baker ────────────────────────────────────────
// Returns { [flavourId]: [{ key, declared_by }] } covering BOTH global flavours and the
// baker's own — the override table's exclusive arc means a row points at one or the
// other, and the caller only ever has a flavour id in hand, so both collapse into one
// map here rather than making every caller ask which kind it holds.
//
// WHY EACH ENTRY CARRIES `declared_by` INSTEAD OF BEING A BARE KEY. The two layers must
// be said in different VOICES, so the client cannot be handed a flat list:
//
//   declared_by: 'baker'   → the baker's own statement, and we may quote them:
//                            "ABC Bakery doesn't offer Tiramisu eggless."
//   declared_by: 'spattoo' → our global default, which must stay hedged:
//                            "Hazelnut Praline normally contains nuts. Please confirm."
//
// Flatten the two and one of them is a lie. Rendering the baseline in the baker's voice
// puts a claim in their mouth they never made — and one they may actively dispute, since
// clearing our row is precisely their right of reply. Rendering their own firm "no" as a
// vague "normally contains" is weaker than the truth we hold and sends the customer to
// ask a question the baker has already answered.
//
// (Same reasoning as the order's dietary embed carrying label+kind rather than bare keys:
// what the surface needs in order to render honestly travels with the data.)
//
// Flavours with no conflicts are simply absent. Absence means "nothing declared", NOT
// "verified compatible" — the distinction the whole feature rests on. Callers must not
// render an empty entry as a clean bill of health.
export async function conflictsForBaker(bakerId) {
  const [baseline, overrides, k] = await Promise.all([
    baselineConflictKeys(),
    softRead(
      supabase
        .from('baker_flavour_dietary_conflicts')
        .select('flavour_id, baker_flavour_id, requirement_id, conflicts')
        .eq('baker_id', bakerId)
        .then(({ data, error }) => {
          if (error) throw new Error(`Failed to load baker flavour conflicts: ${error.message}`);
          return data ?? [];
        }),
      'flavourDietary.overrides',
    ).then(r => r ?? []),
    keyById(),
  ]);

  // Start from a copy of the baseline — never mutate the cached object. Map rather than
  // Set because the value (who declared it) matters as much as the membership.
  const out = {};
  for (const [flavourId, keys] of Object.entries(baseline)) {
    out[flavourId] = new Map(keys.map(key => [key, 'spattoo']));
  }

  for (const o of overrides) {
    const flavourId = o.flavour_id ?? o.baker_flavour_id;   // exclusive arc: one is set
    const key = k.get(o.requirement_id);
    if (!flavourId || !key) continue;
    const m = (out[flavourId] ??= new Map());
    // An override always speaks in the baker's voice, including when it CONFIRMS what
    // the baseline already said — they have adopted it as their own statement.
    if (o.conflicts) m.set(key, 'baker'); else m.delete(key);
  }

  return Object.fromEntries(
    Object.entries(out)
      .filter(([, m]) => m.size)
      .map(([id, m]) => [id, [...m].map(([key, declared_by]) => ({ key, declared_by }))])
  );
}

// ── write the baker's declarations ────────────────────────────────────────────
// The caller hands us the EFFECTIVE set it wants per flavour; we store only where that
// differs from the baseline. Two reasons the diff lives here and not in the client:
// storage stays sparse (a row exists only where a baker disagrees with us), and the UI
// gets to speak in plain terms — "this flavour cannot be made nut-free" — without
// knowing what a baseline is or how to diff against one.
//
// `entries`: [{ flavourId, source: 'global'|'baker', requirementKeys: [...] }]
// Replace-set semantics: whatever is sent becomes the whole truth for the flavours named.
// A set has no natural partial update.
//
// Note this is NOT what PUT /api/baker/flavours does any more — that one upserts, because
// its rows carry a price a replace would destroy (migration 037). A conflict set has no
// such payload, so replace stays correct here.
export async function setBakerFlavourConflicts(bakerId, entries) {
  const [baseline, kById] = await Promise.all([baselineConflictKeys(), idByKey()]);

  const rows = [];
  for (const e of entries ?? []) {
    const flavourId = e.flavourId;
    if (!flavourId) continue;
    const wanted = new Set(e.requirementKeys ?? []);
    const base = new Set(baseline[flavourId] ?? []);

    // Only the disagreements are stored. Union of both sides, because a difference can
    // be in either direction: something we assert that they clear, or vice versa.
    for (const key of new Set([...wanted, ...base])) {
      const requirement_id = kById.get(key);
      if (!requirement_id) continue;             // unknown key — rejected upstream
      const conflicts = wanted.has(key);
      if (conflicts === base.has(key)) continue; // agrees with the baseline → no row
      rows.push({
        baker_id: bakerId,
        flavour_id:       e.source === 'baker' ? null : flavourId,
        baker_flavour_id: e.source === 'baker' ? flavourId : null,
        requirement_id,
        conflicts,
      });
    }
  }

  const { error: delErr } = await supabase
    .from('baker_flavour_dietary_conflicts')
    .delete()
    .eq('baker_id', bakerId);
  if (delErr) throw new Error(delErr.message);

  if (!rows.length) return [];
  const { error: insErr } = await supabase
    .from('baker_flavour_dietary_conflicts')
    .insert(rows);
  if (insErr) throw new Error(insErr.message);
  return rows;
}

// ── write the global baseline (admin) ─────────────────────────────────────────
// Replace-set for ONE flavour, so an admin editing chocolate cannot accidentally blank
// vanilla. Invalidates the cache, or every API instance would serve the old baseline
// for up to the TTL after an edit that the admin just watched succeed.
export async function setBaselineConflicts(flavourId, requirementKeys) {
  const kById = await idByKey();
  const ids = [...new Set(requirementKeys ?? [])]
    .map(k => kById.get(k))
    .filter(id => id != null);

  const { error: delErr } = await supabase
    .from('flavour_dietary_conflicts')
    .delete()
    .eq('flavour_id', flavourId);
  if (delErr) throw new Error(delErr.message);

  if (ids.length) {
    const rows = ids.map(requirement_id => ({ flavour_id: flavourId, requirement_id }));
    const { error: insErr } = await supabase.from('flavour_dietary_conflicts').insert(rows);
    if (insErr) throw new Error(insErr.message);
  }

  invalidateFlavourDietaryCache();
  return ids;
}
