import { Router } from 'express';
import { randomUUID } from 'crypto';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { validateCakeImage, identifyElements } from '../services/openai.js';
import { cropRegion } from '../services/imageCrop.js';
import { getObjectBuffer, putObject } from '../services/r2.js';
import { enqueueExtractImage } from '../jobs/processors/extractImage.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { config } from '../config.js';

const router = Router();

const publicUrl = (key) => `${config.r2.publicUrl}/${key}`;

// A candidate as the admin UI wants it: keys expanded to loadable URLs (same convention as the
// elements routes — bare keys in the DB, full URLs at the API boundary).
const toDto = (c) => ({
  id: c.id,
  jobId: c.job_id,
  status: c.status,
  label: c.label,
  elementKind: c.element_kind,
  colorHex: c.color_hex,
  material: c.material,
  bbox: c.bbox,
  error: c.error,
  elementId: c.element_id,
  cropUrl:   c.crop_key   ? publicUrl(c.crop_key)   : null,
  outputUrl: c.output_key ? publicUrl(c.output_key) : null,
  outputKey: c.output_key,   // the AddElement deep-link carries the KEY, not the URL
});

// ── Phase 1: identify ────────────────────────────────────────────────────────────────────────────
// POST /admin/element-extract/identify  { sourceKey }  → { ok, candidates[] }
//
// Cheap and synchronous ON PURPOSE: one vision call (~5s), no image generation, so nothing here
// costs real money. That's what lets the admin see what we found — and tick only the decorations
// worth regenerating — BEFORE we spend anything. Mirrors POST /admin/inspiration/analyze.
router.post('/admin/element-extract/identify', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { sourceKey } = req.body ?? {};
    if (!sourceKey) return res.status(400).json({ error: 'sourceKey is required' });

    // Same gate Meshy and Build-from-Inspiration use: reject people/scenes/non-cakes up front. A
    // 200 with ok:false (not an error) so the UI can just explain why.
    const verdict = await validateCakeImage(publicUrl(sourceKey));
    if (!verdict.ok) return res.json({ ok: false, reason: verdict.reason, category: verdict.category });

    const { cake, elements } = await identifyElements(publicUrl(sourceKey));
    if (!Array.isArray(elements) || elements.length === 0) {
      return res.json({ ok: false, reason: 'No reusable decorations found on this cake.', category: 'none' });
    }

    // Crop each decoration out of the source. The crop is the reference image the regeneration is
    // conditioned on, and it's also what the admin looks at when deciding whether the box is any
    // good — so we do it now, not at generate time.
    const source = await getObjectBuffer(sourceKey);
    const rows = [];
    for (const el of elements) {
      let cropKey = null;
      try {
        const crop = await cropRegion(source, el.bbox);
        cropKey = `elements/candidates/crops/${randomUUID()}.png`;
        await putObject(cropKey, crop, 'image/png');
      } catch (err) {
        // A bad box shouldn't lose the decoration — it can still be regenerated from the prompt
        // alone (lower fidelity), and the admin will see there's no crop preview.
        console.error(`crop failed for "${el.label}":`, err.message);
      }
      rows.push({
        created_by:   req.user?.id ?? null,
        source_key:   sourceKey,
        crop_key:     cropKey,
        bbox:         el.bbox ?? null,
        label:        el.label ?? null,
        element_kind: el.element ?? null,
        color_hex:    el.color_hex ?? null,
        material:     el.material ?? null,
        prompt:       el.prompt ?? null,
        status:       'identified',
      });
    }

    const { data, error } = await supabase.from('element_candidates').insert(rows).select('*');
    if (error) return serverError(req, res, error);

    res.json({ ok: true, cake, candidates: data.map(toDto) });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Phase 2: generate ────────────────────────────────────────────────────────────────────────────
// POST /admin/element-extract/generate  { candidateIds: [] }  → { jobId }
//
// The expensive half — one image generation per candidate, tens of seconds each — so it's a BullMQ
// job, never the request path. Returns immediately; the UI polls GET :jobId below.
router.post('/admin/element-extract/generate', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { candidateIds } = req.body ?? {};
    if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
      return res.status(400).json({ error: 'candidateIds (non-empty array) is required' });
    }

    // Only ever (re)generate candidates that are actually waiting for it — an id the caller made up,
    // or one already mid-flight, must not enqueue work.
    const { data: pending, error: readErr } = await supabase
      .from('element_candidates')
      .select('id')
      .in('id', candidateIds)
      .in('status', ['identified', 'failed', 'rejected']);
    if (readErr) return serverError(req, res, readErr);
    if (!pending?.length) return res.status(400).json({ error: 'No generatable candidates in that list' });

    const ids = pending.map((c) => c.id);

    // A `jobs` row is the durable handle the UI polls (survives a tab close / worker restart);
    // baker_id NULL = a global catalog job with no owning baker (the established convention).
    const { data: job, error: jobErr } = await supabase
      .from('jobs')
      .insert({ type: 'extract_image', payload: { candidateIds: ids }, baker_id: null })
      .select('id')
      .single();
    if (jobErr) return serverError(req, res, jobErr);

    await supabase
      .from('element_candidates')
      .update({ job_id: job.id, status: 'generating', error: null, updated_at: new Date().toISOString() })
      .in('id', ids);

    await enqueueExtractImage(job.id);
    res.json({ jobId: job.id, count: ids.length });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Poll ─────────────────────────────────────────────────────────────────────────────────────────
// GET /admin/element-extract/:jobId → { status, candidates[] }
// The missing piece that made the old extract job unreachable: there was no way to read a result back.
router.get('/admin/element-extract/:jobId', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data: job, error: jobErr } = await supabase
      .from('jobs').select('id, status, error').eq('id', req.params.jobId).single();
    if (jobErr || !job) return res.status(404).json({ error: 'Job not found' });

    const { data: candidates, error } = await supabase
      .from('element_candidates')
      .select('*')
      .eq('job_id', job.id)
      .order('created_at', { ascending: true });
    if (error) return serverError(req, res, error);

    res.json({ status: job.status, error: job.error, candidates: (candidates ?? []).map(toDto) });
  } catch (err) {
    serverError(req, res, err);
  }
});

// GET /admin/element-extract/candidates/:id → one candidate.
// This is what the AddElement deep-link (?candidate=<id>) reads: the client gets the regenerated
// image as an EXPANDED url, so it never has to derive an R2 URL from a key itself (keys stay a
// server concern, matching every other route). Also makes the deep link reloadable/shareable.
router.get('/admin/element-extract/candidates/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('element_candidates').select('*').eq('id', req.params.id).single();
    if (error || !data) return res.status(404).json({ error: 'Candidate not found' });
    res.json({ candidate: toDto(data) });
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── Provenance ───────────────────────────────────────────────────────────────────────────────────
// PATCH /admin/element-extract/candidates/:id  { status?, elementId? }
// Called when the admin rejects a result, or when AddElement saves an element that came from a
// candidate — that stamp is what later answers "did any of this GPT output actually get used?".
router.patch('/admin/element-extract/candidates/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { status, elementId } = req.body ?? {};
    const patch = { updated_at: new Date().toISOString() };
    if (elementId) patch.element_id = elementId;
    // Only the admin's own verdict is settable here — lifecycle states ('generating'/'ready') are
    // the worker's to write, and letting a client set them would let the UI lie about a job.
    if (status) {
      if (!['rejected', 'ready'].includes(status)) {
        return res.status(400).json({ error: 'status must be "rejected" or "ready"' });
      }
      patch.status = status;
    }

    const { data, error } = await supabase
      .from('element_candidates').update(patch).eq('id', req.params.id).select('*').single();
    if (error) return serverError(req, res, error);
    res.json({ ok: true, candidate: toDto(data) });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
