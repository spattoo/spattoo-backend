import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { supabase } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCapability } from '../middleware/rbac.js';
import { config } from '../config.js';
import * as meshy from '../services/meshy.js';
import * as tripo from '../services/tripo.js';

// ── 3D Element Studio — one flow, two vendors ───────────────────────────────────────────────────
//
// Sandeep: *"build a studio in admin, where we can switch between tripo and meshy"*.
//
// ⚠️ THIS DOES NOT REPLACE `routes/meshy.js`, AND THAT IS DELIBERATE. That route serves the shipped
// Image → 3D Cake wizard, which bakers are meant to get next; breaking it to add a comparison tool
// for staff would be trading a live path for an experiment. The two share the `meshy_generations`
// table (148 gave it `provider` / `mode` / `prompt`) and nothing else.
//
// ⚠️ NO GPT-4o GATE HERE, UNLIKE THE WIZARD. That gate exists to stop a baker spending credits on a
// photo of a dog. This studio is `catalog:admin` only and its whole purpose is to try things that
// might not work — gating it would block the experiments it exists to run. Staff spend staff
// credits knowingly.
//
// ⚠️ WHAT THE STUDIO IS FOR, so the next person does not mistake it for a feature: AI 3D output is
// ONE fused mesh with the colour baked into a texture atlas, and a Spattoo element only recolours
// when it is separate meshes with no map (`CakeCanvas`, `userData.group`, `if (!mat.map)`). Carving
// that by hand is what `RecomposeEditor` does today, per element. Both vendors now claim to split
// a model themselves. Whether either one produces parts we can actually use is the open question,
// and it is answered by looking at real output, not by reading their docs.

const router = Router();
const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELED'];
const publicUrl = (key) => `${config.r2.publicUrl}/${key}`;

const present = (row) => ({
  id: row.id,
  provider: row.provider,
  mode: row.mode,
  prompt: row.prompt,
  wantsParts: row.wants_parts,
  status: row.status,
  progress: row.progress,
  error: row.error,
  credits: row.consumed_credits,
  thumbnailUrl: row.thumbnail_url,
  glbUrl: row.glb_key ? publicUrl(row.glb_key) : null,
  sourceImageUrl: row.source_image_key ? publicUrl(row.source_image_key) : null,
  createdAt: row.created_at,
});

/** Ask whichever vendor owns this row. Both services normalise to one shape. */
function poll(row) {
  if (row.provider === 'tripo') return tripo.getTask(row.meshy_task_id);
  return meshy.getAnyTask(row.meshy_task_id, row.mode === 'text' ? 'text' : 'image');
}

// POST /admin/ai3d/generate
// body: { provider, mode, prompt?, sourceImageKey?, parts?, texture? }
router.post('/admin/ai3d/generate', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { provider = 'tripo', mode = 'text', prompt, sourceImageKey, parts = true, texture = false } = req.body ?? {};
    if (!['meshy', 'tripo'].includes(provider)) return res.status(400).json({ error: 'provider must be meshy or tripo' });
    if (mode === 'text' && !prompt?.trim()) return res.status(400).json({ error: 'prompt is required for text mode' });
    if (mode === 'image' && !sourceImageKey) return res.status(400).json({ error: 'sourceImageKey is required for image mode' });

    // ⚠️ REFUSE BEFORE SPENDING, AND SAY WHOSE KEY IS MISSING. The services throw by name at call
    // time; catching it here turns a 500 into a sentence an admin can act on.
    const key = provider === 'tripo' ? config.tripo.apiKey : config.meshy.apiKey;
    if (!key) {
      return res.status(503).json({ error: `${provider.toUpperCase()}_API_KEY is not set on this environment` });
    }

    const imageUrl = sourceImageKey ? publicUrl(sourceImageKey) : null;
    let taskId;
    if (provider === 'tripo') {
      taskId = mode === 'text'
        ? await tripo.createTextTo3D({ prompt, texture, parts })
        : await tripo.createImageTo3D({ imageUrl, texture, parts });
    } else {
      // Meshy splits as a SECOND task on a finished model, so `parts` is not passed here — the
      // studio asks for the split once this one succeeds. One vendor plans it, the other chains it.
      taskId = mode === 'text'
        ? await meshy.createTextTo3DTask({ prompt })
        : await meshy.createImageTo3DTask({ imageUrl, shouldTexture: texture });
    }

    const { data, error } = await supabase
      .from('meshy_generations')
      .insert({
        created_by: req.user.id,
        provider, mode,
        prompt: prompt ?? null,
        source_image_key: sourceImageKey ?? null,
        wants_parts: !!parts,
        meshy_task_id: taskId,
        status: 'PENDING',
      })
      .select('*').single();
    if (error) return serverError(req, res, error);

    res.json({ ok: true, ...present(data) });
  } catch (err) {
    serverError(req, res, err);
  }
});

// GET /admin/ai3d/:id — poll the vendor while the row is non-terminal, then hand back the row.
router.get('/admin/ai3d/:id', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data: row, error } = await supabase
      .from('meshy_generations').select('*').eq('id', req.params.id).single();
    if (error || !row) return res.status(404).json({ error: 'Not found' });
    if (TERMINAL.includes(row.status)) return res.json(present(row));

    let task;
    try {
      task = await poll(row);
    } catch (pollErr) {
      // ⚠️ A POLL FAILURE IS NOT A ROW FAILURE. The vendor being briefly unreachable must not mark
      // a running generation dead — the studio keeps showing the last known state and tries again.
      console.error(`ai3d poll error (${row.provider}):`, pollErr.message);
      return res.json(present(row));
    }

    const update = {
      status: task.status,
      progress: task.progress,
      updated_at: new Date().toISOString(),
      ...(task.credits != null ? { consumed_credits: task.credits } : {}),
      ...(task.thumbnailUrl ? { thumbnail_url: task.thumbnailUrl } : {}),
      ...(task.error ? { error: task.error } : {}),
    };
    const { data: saved } = await supabase
      .from('meshy_generations').update(update).eq('id', row.id).select('*').single();

    // ⚠️ THE VENDOR URL IS HANDED STRAIGHT BACK, NOT MIRRORED TO R2 — unlike the shipped wizard,
    // which keeps a copy because a baker's element must outlive a vendor's temporary link. Studio
    // runs are experiments that get looked at once and thrown away; copying every one into R2 would
    // fill the bucket with rejects. Anything worth keeping goes through Save-as-Element, which does
    // the copy properly.
    res.json({ ...present(saved ?? { ...row, ...update }), vendorModelUrl: task.modelUrl ?? null });
  } catch (err) {
    serverError(req, res, err);
  }
});

// POST /admin/ai3d/:id/split — Meshy only, as a second task against a finished model.
router.post('/admin/ai3d/:id/split', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { mode = 'auto', prompt } = req.body ?? {};
    const { data: row, error } = await supabase
      .from('meshy_generations').select('*').eq('id', req.params.id).single();
    if (error || !row) return res.status(404).json({ error: 'Not found' });
    if (row.provider !== 'meshy') {
      return res.status(400).json({ error: 'Tripo splits at generation time — re-run with parts on' });
    }
    if (row.status !== 'SUCCEEDED') return res.status(400).json({ error: 'Model is not finished yet' });

    const taskId = await meshy.createAutoSplitTask({ taskId: row.meshy_task_id, mode, prompt });
    const { data } = await supabase
      .from('meshy_generations')
      .insert({
        created_by: req.user.id,
        provider: 'meshy', mode: row.mode,
        prompt: prompt ?? row.prompt,
        source_image_key: row.source_image_key,
        wants_parts: true,
        meshy_task_id: taskId,
        status: 'PENDING',
      })
      .select('*').single();
    res.json({ ok: true, ...present(data) });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
