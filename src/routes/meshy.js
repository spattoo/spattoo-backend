import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { randomUUID } from 'crypto';
import { supabase } from '../services/supabase.js';
import { putObject } from '../services/r2.js';
import { createImageTo3DTask, getTask } from '../services/meshy.js';
import { validateCakeImage } from '../services/openai.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { config } from '../config.js';

const router = Router();

const TERMINAL = ['SUCCEEDED', 'FAILED'];

// Expand a stored bucket key to a public URL for the client.
function publicUrl(key) {
  return key ? `${config.r2.publicUrl?.replace(/\/+$/, '')}/${key}` : null;
}

// Shape a DB row for the client (adds a fetchable glb_url).
function present(row) {
  return { ...row, glb_url: publicUrl(row.glb_key) };
}

// Reconcile a generation row against a fresh Meshy task object. Shared by the GET poll
// (local-dev / fallback path) and the webhook (prod fast path). IDEMPOTENT: no-ops once
// the row is terminal, so the two paths can't double-download the GLB or double-count credits.
export async function finalizeOrUpdate(row, task) {
  if (TERMINAL.includes(row.status)) return row;

  const status = task?.status;

  if (status === 'SUCCEEDED') {
    const glbSrc = task.model_urls?.glb;
    if (!glbSrc) throw new Error(`Meshy task ${row.meshy_task_id} SUCCEEDED but has no glb url`);
    // Copy the Meshy GLB into our own R2 (Meshy URLs expire) so the editor can fetch it.
    const buf = Buffer.from(await (await fetch(glbSrc)).arrayBuffer());
    const glbKey = `meshy/outputs/${randomUUID()}.glb`;
    await putObject(glbKey, buf, 'model/gltf-binary');
    const update = {
      status:           'SUCCEEDED',
      progress:         100,
      glb_key:          glbKey,
      thumbnail_url:    task.thumbnail_url ?? null,
      consumed_credits: task.consumed_credits ?? null,
      updated_at:       new Date().toISOString(),
    };
    const { data } = await supabase
      .from('meshy_generations').update(update).eq('id', row.id).select('*').single();
    return data ?? { ...row, ...update };
  }

  if (status === 'FAILED' || status === 'CANCELED') {
    const update = {
      status:     'FAILED',
      error:      task.task_error?.message ?? `Meshy task ${status}`,
      updated_at: new Date().toISOString(),
    };
    const { data } = await supabase
      .from('meshy_generations').update(update).eq('id', row.id).select('*').single();
    return data ?? { ...row, ...update };
  }

  // PENDING / IN_PROGRESS — just refresh progress.
  const update = {
    status:     status === 'IN_PROGRESS' ? 'IN_PROGRESS' : row.status,
    progress:   typeof task?.progress === 'number' ? task.progress : row.progress,
    updated_at: new Date().toISOString(),
  };
  const { data } = await supabase
    .from('meshy_generations').update(update).eq('id', row.id).select('*').single();
  return data ?? { ...row, ...update };
}

// POST /admin/meshy/generate — run the validation gate, then create a Meshy task.
// body: { sourceImageKey, force? }. Gate rejection returns 200 { ok:false, ... } (no credits spent).
router.post('/admin/meshy/generate', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { sourceImageKey, force } = req.body ?? {};
    if (!sourceImageKey) return res.status(400).json({ error: 'sourceImageKey is required' });

    const imageUrl = publicUrl(sourceImageKey);

    // Cheap GPT-4o gate before spending Meshy credits. Admin-only `force` override.
    if (!force) {
      const verdict = await validateCakeImage(imageUrl);
      if (!verdict.ok) {
        return res.json({ ok: false, reason: verdict.reason, category: verdict.category });
      }
    }

    const taskId = await createImageTo3DTask({ imageUrl });

    const { data, error } = await supabase
      .from('meshy_generations')
      .insert({
        created_by:       req.user.id,
        source_image_key: sourceImageKey,
        meshy_task_id:    taskId,
        status:           'PENDING',
      })
      .select('*')
      .single();
    if (error) return serverError(req, res, error);

    res.json({ ok: true, ...present(data) });
  } catch (err) {
    serverError(req, res, err);
  }
});

// GET /admin/meshy/:id — return the row. If still non-terminal, do a live Meshy poll-and-update
// (the local-dev path, since the account-global webhook can't reach localhost; also covers a
// missed/delayed webhook in prod).
router.get('/admin/meshy/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data: row, error } = await supabase
      .from('meshy_generations').select('*').eq('id', req.params.id).single();
    if (error || !row) return res.status(404).json({ error: 'Not found' });

    if (!TERMINAL.includes(row.status)) {
      try {
        const task = await getTask(row.meshy_task_id);
        const updated = await finalizeOrUpdate(row, task);
        return res.json(present(updated));
      } catch (pollErr) {
        // Polling failure shouldn't 500 the client mid-wait — return the last-known row.
        console.error('Meshy poll error:', pollErr.message);
      }
    }
    res.json(present(row));
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
