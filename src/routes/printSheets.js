import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth, attachBakerContext } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { requireEntitlement } from '../middleware/entitlements.js';

// ── Saved sheets for the Edible Print Studio ─────────────────────────────────────────────────────
// Schema + the argument behind it: migrations/049_print_sheets.sql
// Design: spattoo-docs/plans/edible-print-studio.md
//
// A sheet is a LAYOUT: which images, where on the A4, how big. The images themselves live in
// baker_uploads and are referenced by id, never copied — see the note on resolution below.
//
// ── GATED TWICE, ON PURPOSE ─────────────────────────────────────────────────────────────────────
// `store:manage` says WHO (a baker or their staff, not a customer), `edible_print_studio` says
// WHETHER THE PLAN INCLUDES IT. The client hides the Chef's Desk entry when the plan does not, and
// that is not a restriction — anyone can post to the route. Same reasoning as the storefront's OTP
// channels being enforced in the handler as well as the UI.

const router = Router();

// A generous ceiling, identical on every plan that has the studio at all. NOT a pricing lever: a
// sheet is a few hundred bytes of json, so a limit that bites is an arbitrary limit that produces
// support tickets and nothing else (the same reasoning max_custom_elements records). It exists so
// the write path is not unbounded, which is a thing to decide now rather than discover later.
const MAX_SHEETS_PER_BAKER = 200;

// What the client may set. `baker_id`, timestamps and `id` are server-owned — a sheet that could
// name its own tenant would be a cross-tenant write dressed up as a save.
const NAME_MAX = 120;

function cleanName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return { error: 'name is required' };
  if (name.length > NAME_MAX) return { error: `name must be ${NAME_MAX} characters or fewer` };
  return { name };
}

// `items` is stored as sent, but it must be an ARRAY of objects — jsonb will happily accept a string
// or a number, and the studio would then load a sheet it cannot render, with no clue why.
function cleanItems(raw) {
  if (raw === undefined) return { items: undefined };          // absent = "don't change it"
  if (!Array.isArray(raw)) return { error: 'items must be an array' };
  if (raw.some(it => !it || typeof it !== 'object' || Array.isArray(it))) {
    return { error: 'each item must be an object' };
  }
  return { items: raw };
}

// ── GET /api/print-sheets ─────────────────────────────────────────────────────────────────────────
// The studio's front door: this bakery's sheets, most recently worked first.
//
// Deliberately WITHOUT `items` — a library screen renders names and dates, and shipping every
// layout to draw a list would grow the response with each sheet for something nobody looks at until
// they open one.
router.get('/print-sheets',
  requireAuth, requireCapability('store:manage'), requireEntitlement('edible_print_studio'), attachBakerContext,
  async (req, res) => {
    try {
      if (!req.bakerId) return res.status(404).json({ error: 'No baker account found' });

      const { data, error } = await supabase
        .from('print_sheets')
        .select('id, name, created_at, updated_at')
        .eq('baker_id', req.bakerId)
        .order('updated_at', { ascending: false });
      if (error) return serverError(req, res, error);

      res.json({ sheets: data ?? [] });
    } catch (err) { serverError(req, res, err); }
  });

// ── GET /api/print-sheets/:id ─────────────────────────────────────────────────────────────────────
// One sheet, with its layout, for reopening.
router.get('/print-sheets/:id',
  requireAuth, requireCapability('store:manage'), requireEntitlement('edible_print_studio'), attachBakerContext,
  async (req, res) => {
    try {
      if (!req.bakerId) return res.status(404).json({ error: 'No baker account found' });

      const { data, error } = await supabase
        .from('print_sheets')
        .select('id, name, items, guide, created_at, updated_at')
        // Scoped by tenant in the QUERY, not checked after fetching — a 404 for another bakery's
        // sheet then costs no thought, and there is no branch to forget.
        .eq('baker_id', req.bakerId)
        .eq('id', req.params.id)
        .maybeSingle();
      if (error) return serverError(req, res, error);
      if (!data) return res.status(404).json({ error: 'Sheet not found' });

      res.json(data);
    } catch (err) { serverError(req, res, err); }
  });

// ── POST /api/print-sheets ────────────────────────────────────────────────────────────────────────
router.post('/print-sheets',
  requireAuth, requireCapability('store:manage'), requireEntitlement('edible_print_studio'), attachBakerContext,
  async (req, res) => {
    try {
      if (!req.bakerId) return res.status(404).json({ error: 'No baker account found' });

      const { name, error: nameErr } = cleanName(req.body?.name);
      if (nameErr) return res.status(400).json({ error: nameErr });
      const { items, error: itemsErr } = cleanItems(req.body?.items);
      if (itemsErr) return res.status(400).json({ error: itemsErr });

      // Counted, not trusted to a constraint — the cap is per baker and SQL cannot say that.
      const { count, error: countErr } = await supabase
        .from('print_sheets')
        .select('id', { count: 'exact', head: true })
        .eq('baker_id', req.bakerId);
      if (countErr) return serverError(req, res, countErr);
      if ((count ?? 0) >= MAX_SHEETS_PER_BAKER) {
        return res.status(409).json({
          error: `You have reached the limit of ${MAX_SHEETS_PER_BAKER} saved sheets. Delete one to save another.`,
          code: 'SHEET_LIMIT_REACHED',
        });
      }

      const { data, error } = await supabase
        .from('print_sheets')
        .insert({
          baker_id: req.bakerId,          // server-resolved — never from the client
          name,
          items: items ?? [],
          guide: req.body?.guide ?? null,
        })
        .select('id, name, created_at, updated_at')
        .single();
      if (error) return serverError(req, res, error);

      res.status(201).json(data);
    } catch (err) { serverError(req, res, err); }
  });

// ── PATCH /api/print-sheets/:id ───────────────────────────────────────────────────────────────────
// Save, or rename. Both are this: a sheet is one row and editing it is editing that row.
router.patch('/print-sheets/:id',
  requireAuth, requireCapability('store:manage'), requireEntitlement('edible_print_studio'), attachBakerContext,
  async (req, res) => {
    try {
      if (!req.bakerId) return res.status(404).json({ error: 'No baker account found' });

      const patch = { updated_at: new Date().toISOString() };

      // A field ABSENT means "leave it"; a field present means "set it". So a rename does not have
      // to send the whole layout back, and an autosave does not have to know the current name.
      if (req.body?.name !== undefined) {
        const { name, error } = cleanName(req.body.name);
        if (error) return res.status(400).json({ error });
        patch.name = name;
      }
      const { items, error: itemsErr } = cleanItems(req.body?.items);
      if (itemsErr) return res.status(400).json({ error: itemsErr });
      if (items !== undefined) patch.items = items;
      if (req.body?.guide !== undefined) patch.guide = req.body.guide;

      const { data, error } = await supabase
        .from('print_sheets')
        .update(patch)
        .eq('baker_id', req.bakerId)
        .eq('id', req.params.id)
        .select('id, name, created_at, updated_at')
        .maybeSingle();
      if (error) return serverError(req, res, error);
      if (!data) return res.status(404).json({ error: 'Sheet not found' });

      res.json(data);
    } catch (err) { serverError(req, res, err); }
  });

// ── DELETE /api/print-sheets/:id ──────────────────────────────────────────────────────────────────
// A hard delete, and that is the whole of it. A sheet holds no content of its own — only ids
// pointing at images that carry their own erasure — so this is a baker tidying their own desk.
// A tombstone would be recording something nobody will ever ask about.
router.delete('/print-sheets/:id',
  requireAuth, requireCapability('store:manage'), requireEntitlement('edible_print_studio'), attachBakerContext,
  async (req, res) => {
    try {
      if (!req.bakerId) return res.status(404).json({ error: 'No baker account found' });

      const { data, error } = await supabase
        .from('print_sheets')
        .delete()
        .eq('baker_id', req.bakerId)
        .eq('id', req.params.id)
        .select('id')
        .maybeSingle();
      if (error) return serverError(req, res, error);
      if (!data) return res.status(404).json({ error: 'Sheet not found' });

      res.json({ deleted: true });
    } catch (err) { serverError(req, res, err); }
  });

export default router;
