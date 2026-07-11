import { Router } from 'express';
import express from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { cutOutSubject } from '../services/backgroundRemoval.js';
import { getEntitlements } from '../services/entitlements.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { reindexElement } from '../services/elementIndex.js';
import { ensureThumbKey } from './elements.js';   // reuse the SAME post-create thumbnail step

const router = Router();

// ── "My Decorations" — a baker's / customer's OWN uploaded elements ──────────────────────────────
//
// These routes are NOT under /api/admin, and that is the whole point: element authoring has always
// been catalog:admin (platform staff, writing the GLOBAL catalog). A baker uploading their own
// decoration is a different act on a different scope, so it gets its own capability (element:manage)
// and its own routes, which can never touch a global row.
//
// THE SECURITY INVARIANT, stated once: ownership is derived from the PRINCIPAL, never from the body.
// The client cannot send baker_id or customer_id. A baker's upload is shared with their tenant; a
// customer's upload is private to them. That single rule is what stops one customer's photo appearing
// in another customer's designer.

// Who owns what this principal creates. The ONE place the rule lives.
function ownershipFor(req) {
  // A customer principal's bakerId comes from their invite (middleware/rbac.js → resolveCustomer), so
  // even a customer's private upload is still inside the right tenant.
  return req.customerId
    ? { baker_id: req.bakerId, customer_id: req.customerId }   // private to this customer
    : { baker_id: req.bakerId, customer_id: null };            // shared with the baker's whole tenant
}

// Count what already exists under this baker — the baker's shared library AND their customers'
// private uploads, because the quota is the BAKER's (both sit in their tenant and both cost storage).
async function usedQuota(bakerId) {
  const { count, error } = await supabase
    .from('cake_elements')
    .select('id', { count: 'exact', head: true })
    .eq('baker_id', bakerId)
    .eq('is_active', true);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// ── POST /api/elements — create one of MY decorations ────────────────────────────────────────────
router.post('/elements', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });

    const { name, element_type_id, image_url, thumbnail_url, placement_config, file_size } = req.body ?? {};
    if (!name?.trim() || !element_type_id || !image_url) {
      return res.status(400).json({ error: 'name, element_type_id and image_url are required' });
    }

    // The type must be one admin has OPTED IN for user upload. This is what stops a baker creating,
    // say, a `cream_piping` element whose placement rules assume things the designer would choke on —
    // and it's data, so the offered kinds are configured, never hardcoded.
    const { data: type, error: typeErr } = await supabase
      .from('element_types')
      .select('id, slug, placement_rules, default_allowed_actions, baker_uploadable')
      .eq('id', element_type_id)
      .maybeSingle();
    if (typeErr) return serverError(req, res, typeErr);
    if (!type || !type.baker_uploadable) {
      return res.status(400).json({ error: 'That decoration kind cannot be uploaded' });
    }

    // Quota. Counted against the BAKER's plan even when a customer uploads (both live in the baker's
    // tenant). null in the plan = unlimited.
    const { ent, active } = await getEntitlements(req.bakerId);
    if (!active) {
      return res.status(402).json({ error: 'This bakery’s subscription is not active.', code: 'SUBSCRIPTION_INACTIVE' });
    }
    const max = ent.max_custom_elements;
    if (max !== null && max !== undefined) {
      const used = await usedQuota(req.bakerId);
      if (used >= max) {
        return res.status(402).json({
          error: `This bakery has used all ${max} of its decoration slots.`,
          code: 'CUSTOM_ELEMENT_LIMIT',
          used, max,
          // The baker can free a slot by removing one; a customer cannot, and must be told to ask.
          canFree: !req.customerId,
        });
      }
    }

    // Placement is INHERITED from the type's admin-authored template — the baker never sees a zone
    // matrix. `placement_rules` is {zones, placement}; the element's own placement_config carries the
    // caller's additions (recolour regions, chosen colours) on top.
    const zones = Array.isArray(type.placement_rules?.zones) ? type.placement_rules.zones : [];
    const inheritedModes = type.placement_rules?.placement ?? {};

    // Only the zones the uploader actually chose, intersected with what the type allows — a client
    // cannot widen its own placement by sending extra zones.
    const requested = Array.isArray(req.body.allowed_zones) ? req.body.allowed_zones : zones;
    const allowedZones = zones.filter(z => requested.includes(z));
    if (!allowedZones.length) {
      return res.status(400).json({ error: 'Choose at least one place on the cake' });
    }

    const builtConfig = { ...inheritedModes };
    for (const z of allowedZones) builtConfig[z] = inheritedModes[z] ?? 'hug';
    // The caller may add ONLY the recolour descriptor — never zones/modes, which are the type's.
    if (placement_config?.recolor) builtConfig.recolor = placement_config.recolor;
    if (placement_config?.r != null) builtConfig.r = placement_config.r;

    const { data, error } = await supabase
      .from('cake_elements')
      .insert({
        name:             name.trim(),
        description:      '',
        image_url,
        thumbnail_url:    thumbnail_url ?? image_url,
        element_type_id,
        allowed_zones:    allowedZones,
        placement_config: builtConfig,
        allowed_actions:  type.default_allowed_actions ?? { resize: true, duplicate: true, color: false, delete: true },
        sort_order:       0,
        file_size:        file_size ?? null,
        is_active:        true,
        ...ownershipFor(req),      // ← server-derived. NEVER from the body.
      })
      .select('id')
      .single();
    if (error) return serverError(req, res, error);

    res.status(201).json({ id: data.id });
    // Same post-create work the admin path does: search index + optimised picker thumbnail.
    reindexElement(data.id).catch(e => console.error('reindex(my-element) failed:', e.message));
    ensureThumbKey(data.id, thumbnail_url ?? image_url);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── DELETE /api/elements/:id — remove one of MINE ────────────────────────────────────────────────
// Soft-delete (is_active=false): designs already placed on a cake still reference this element, and a
// hard delete would silently rewrite history. The scoped .eq() chain IS the guard — a row that isn't
// yours simply doesn't match, so a wrong-owner id is indistinguishable from a missing one (no
// enumeration oracle), and there is no check/act race.
router.delete('/elements/:id', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });

    let q = supabase
      .from('cake_elements')
      .update({ is_active: false })
      .eq('id', req.params.id)
      .eq('baker_id', req.bakerId)          // never another tenant's
      .not('baker_id', 'is', null);         // and NEVER a global element, whatever else matches

    // A customer may only remove their OWN upload. A baker (no customerId) may remove the tenant's
    // shared ones — but not a customer's private upload, which isn't theirs to delete.
    q = req.customerId
      ? q.eq('customer_id', req.customerId)
      : q.is('customer_id', null);

    const { data, error } = await q.select('id');
    if (error) return serverError(req, res, error);
    if (!data?.length) return res.status(404).json({ error: 'Not found' });

    res.json({ ok: true, id: data[0].id });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── POST /api/elements/remove-bg — cut the background out of an upload ───────────────────────────
// The baker-facing sibling of the admin-only /api/admin/remove-bg. Same job, different principal, and
// gated by element:manage so it can't be used as a free background-removal API by anyone with a login.
//
// Metered today (remove.bg). services/backgroundRemoval.js is the one chokepoint, so pointing this at
// our own model later is an env change — no caller changes.
router.post(
  '/elements/remove-bg',
  requireAuth,
  requireCapability('element:manage'),
  express.raw({ type: '*/*', limit: '10mb' }),
  async (req, res) => {
    try {
      if (!req.body?.length) return res.status(400).json({ error: 'Send the image bytes as the body' });
      const png = await cutOutSubject(req.body);
      res.set('Content-Type', 'image/png').send(png);
    } catch (err) {
      serverError(req, res, err);
    }
  },
);

// ── GET /api/elements/quota — how many decorations are left ──────────────────────────────────────
// So the UI can say "3 of 10 used" BEFORE the user picks a file, rather than failing them after.
router.get('/elements/quota', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    if (!req.bakerId) return res.status(403).json({ error: 'No baker context' });
    const { ent } = await getEntitlements(req.bakerId);
    const max = ent.max_custom_elements ?? null;       // null = unlimited
    const used = await usedQuota(req.bakerId);
    res.json({ used, max, remaining: max == null ? null : Math.max(0, max - used) });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
