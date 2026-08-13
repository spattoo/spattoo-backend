import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────────

// GET /api/patterns
// Returns all patterns. No auth required — the customer-facing CakeDesigner
// fetches this to populate the decoration picker.
router.get('/patterns', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('patterns')
      .select('id, name, slug, placements, tier_count, created_at')
      .order('created_at', { ascending: false });

    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

// POST /api/admin/patterns
// Create a new pattern. Body: { name, slug, placements, tier_count }
router.post('/admin/patterns', requireAuth, async (req, res) => {
  try {
    const { name, slug, placements, tier_count } = req.body;

    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    if (!slug?.trim()) return res.status(400).json({ error: 'slug is required' });
    if (!Array.isArray(placements) || placements.length === 0) {
      return res.status(400).json({ error: 'placements must be a non-empty array' });
    }

    const { data, error } = await supabase
      .from('patterns')
      .insert({
        name:       name.trim(),
        slug:       slug.trim(),
        placements,
        tier_count: tier_count ?? 1,
      })
      .select('id, name, slug, placements, tier_count, created_at')
      .single();

    if (error) {
      const status = error.code === '23505' ? 409 : 500; // 23505 = unique violation on slug
      return res.status(status).json({ error: error.message });
    }

    res.status(201).json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// DELETE /api/admin/patterns/:slug
// Delete a pattern by slug.
router.delete('/admin/patterns/:slug', requireAuth, async (req, res) => {
  try {
    const { slug } = req.params;

    const { error } = await supabase
      .from('patterns')
      .delete()
      .eq('slug', slug);

    if (error) return serverError(req, res, error);
    res.json({ deleted: slug });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
