import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { jobQueue } from '../jobs/queue.js';
import { config } from '../config.js';

function toPublicUrl(key) {
  if (!key) return null;
  if (key.startsWith('http')) return key;
  return `${config.r2.publicUrl}/${key}`;
}

async function runAutoTag(entityType, entityId, thumbnailKey, name) {
  const { data: tags } = await supabase
    .from('tags')
    .select('id, name, slug, category')
    .eq('ai_assignable', true)
    .eq('is_active', true);

  if (!tags?.length) return [];

  const imageUrl = toPublicUrl(thumbnailKey);
  const vocabByCategory = tags.reduce((acc, t) => {
    (acc[t.category] ??= []).push(t.slug);
    return acc;
  }, {});
  const vocabText = Object.entries(vocabByCategory)
    .map(([cat, slugs]) => `${cat}: ${slugs.join(', ')}`)
    .join('\n');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o', max_tokens: 400,
      messages: [{ role: 'user', content: [
        { type: 'image_url', image_url: { url: imageUrl } },
        { type: 'text', text:
          `You are a cake decoration expert. Analyse this image of "${name}".\n` +
          `Assign tags ONLY from this vocabulary:\n${vocabText}\n\n` +
          `Return ONLY a JSON array: [{"slug":"...","confidence":0.0-1.0}]\n` +
          `Only include tags with confidence >= 0.75. Be conservative.`
        },
      ]}],
    }),
  });

  if (!res.ok) throw new Error(`GPT-4o failed: ${await res.text()}`);
  const gpt   = await res.json();
  const raw   = gpt.choices[0].message.content.trim().replace(/^```[a-z]*\n?/i,'').replace(/\n?```$/i,'');
  const slugToTag = Object.fromEntries(tags.map(t => [t.slug, t]));
  const results   = JSON.parse(raw);

  const rows = results
    .filter(r => r.slug && slugToTag[r.slug] && r.confidence >= 0.75)
    .map(r => ({
      ...(entityType === 'element' ? { element_id: entityId } : { template_id: entityId }),
      tag_id: slugToTag[r.slug].id, source: 'ai',
      confidence: Math.min(1, r.confidence),
    }));

  if (!rows.length) return [];

  const table = entityType === 'element' ? 'element_tags' : 'template_tags';
  const conflictCol = entityType === 'element' ? 'element_id,tag_id' : 'template_id,tag_id';
  await supabase.from(table).upsert(rows, { onConflict: conflictCol, ignoreDuplicates: true });

  // Return the full updated tag list for the entity
  const idCol = entityType === 'element' ? 'element_id' : 'template_id';
  const { data: updated } = await supabase
    .from(table)
    .select('tag_id, source, confidence, tags(id, name, slug, category)')
    .eq(idCol, entityId);

  return updated ?? [];
}

const router = Router();

// ── Tags vocabulary ───────────────────────────────────────────────────────────

router.get('/tags', requireAuth, requireCapability('design:create'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tags')
      .select('id, name, slug, category, ai_assignable, sort_order')
      .eq('is_active', true)
      .order('category')
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

router.get('/admin/tags', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tags')
      .select('id, name, slug, category, ai_assignable, sort_order, is_active, created_at')
      .order('category')
      .order('sort_order');
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

router.post('/admin/tags', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { name, slug, category, ai_assignable = false, sort_order = 0 } = req.body;
    if (!name || !slug || !category) {
      return res.status(400).json({ error: 'name, slug and category are required' });
    }
    const { data, error } = await supabase
      .from('tags')
      .insert({ name, slug, category, ai_assignable, sort_order, is_active: true })
      .select('id, name, slug, category, ai_assignable, sort_order, is_active')
      .single();
    if (error) return serverError(req, res, error);
    res.status(201).json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

router.patch('/admin/tags/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const allowed = ['name', 'slug', 'category', 'ai_assignable', 'sort_order', 'is_active'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const { data, error } = await supabase
      .from('tags')
      .update(updates)
      .eq('id', req.params.id)
      .select('id, name, slug, category, ai_assignable, sort_order, is_active')
      .single();
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

router.delete('/admin/tags/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    // Check for existing usage before deleting
    const [{ count: ec }, { count: tc }] = await Promise.all([
      supabase.from('element_tags').select('*', { count: 'exact', head: true }).eq('tag_id', req.params.id),
      supabase.from('template_tags').select('*', { count: 'exact', head: true }).eq('tag_id', req.params.id),
    ]);
    if ((ec ?? 0) + (tc ?? 0) > 0) {
      return res.status(409).json({ error: `Tag is used by ${ec} element(s) and ${tc} template(s). Remove usages first.` });
    }
    const { error } = await supabase.from('tags').delete().eq('id', req.params.id);
    if (error) return serverError(req, res, error);
    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Element tags ──────────────────────────────────────────────────────────────

router.get('/admin/elements/:id/tags', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('element_tags')
      .select('tag_id, source, confidence, tags(id, name, slug, category)')
      .eq('element_id', req.params.id);
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

// Replace all tags for an element
router.put('/admin/elements/:id/tags', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { tagIds = [] } = req.body;
    const elementId = req.params.id;
    await supabase.from('element_tags').delete().eq('element_id', elementId);
    if (tagIds.length > 0) {
      const rows = tagIds.map(tag_id => ({ element_id: elementId, tag_id, source: 'manual', confidence: null }));
      const { error } = await supabase.from('element_tags').insert(rows);
      if (error) return serverError(req, res, error);
    }
    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

// Re-run AI tagging for an element — runs synchronously, returns updated tags
router.post('/admin/elements/:id/retag', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data: el, error } = await supabase
      .from('cake_elements')
      .select('id, name, thumbnail_url')
      .eq('id', req.params.id)
      .single();
    if (error) return res.status(404).json({ error: 'Element not found' });
    if (!el.thumbnail_url) return res.status(400).json({ error: 'Element has no thumbnail to analyse' });

    const tags = await runAutoTag('element', el.id, el.thumbnail_url, el.name);
    res.json({ tags });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Template tags ─────────────────────────────────────────────────────────────

router.get('/admin/templates/:id/tags', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('template_tags')
      .select('tag_id, source, confidence, tags(id, name, slug, category)')
      .eq('template_id', req.params.id);
    if (error) return serverError(req, res, error);
    res.json(data);
  } catch (err) {
    serverError(req, res, err);
  }
});

router.put('/admin/templates/:id/tags', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { tagIds = [] } = req.body;
    const templateId = req.params.id;
    await supabase.from('template_tags').delete().eq('template_id', templateId);
    if (tagIds.length > 0) {
      const rows = tagIds.map(tag_id => ({ template_id: templateId, tag_id, source: 'manual', confidence: null }));
      const { error } = await supabase.from('template_tags').insert(rows);
      if (error) return serverError(req, res, error);
    }
    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

router.post('/admin/templates/:id/retag', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data: tmpl, error } = await supabase
      .from('cake_templates')
      .select('id, name, thumbnail_url')
      .eq('id', req.params.id)
      .single();
    if (error) return res.status(404).json({ error: 'Template not found' });
    if (!tmpl.thumbnail_url) return res.status(400).json({ error: 'Template has no thumbnail to analyse' });

    const tags = await runAutoTag('template', tmpl.id, tmpl.thumbnail_url, tmpl.name);
    res.json({ tags });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Template attrs ────────────────────────────────────────────────────────────

router.get('/admin/templates/:id/attrs', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('cake_template_attrs')
      .select('min_weight_kg, min_age, max_age')
      .eq('template_id', req.params.id)
      .maybeSingle();
    if (error) return serverError(req, res, error);
    res.json(data ?? {});
  } catch (err) {
    serverError(req, res, err);
  }
});

router.put('/admin/templates/:id/attrs', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { min_weight_kg, min_age, max_age } = req.body;
    const attrs = {
      template_id:   req.params.id,
      min_weight_kg: min_weight_kg ?? null,
      min_age:       min_age       ?? null,
      max_age:       max_age       ?? null,
      updated_at:    new Date().toISOString(),
    };
    const { error } = await supabase
      .from('cake_template_attrs')
      .upsert(attrs, { onConflict: 'template_id' });
    if (error) return serverError(req, res, error);
    res.json({ ok: true });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
