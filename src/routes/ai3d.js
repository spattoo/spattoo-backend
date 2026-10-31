import { Router } from 'express';
import { serverError } from '../lib/httpError.js';
import { putObject } from '../services/r2.js';
import { FOLDER_RETENTION_DAYS } from '../lib/folders.js';
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
// for staff would be trading a live path for an experiment. The two share the `ai3d_generations`
// table (148 gave it `provider` / `mode` / `prompt`) and nothing else.
//
// ⚠️ AND NO PLAN GATE HERE EITHER, FOR THE SAME REASON: every route in this file is mounted under
// `/api/admin`, which server.js gates with `requireAdmin` at the mount, so no baker can reach any
// of them — including `/admin/ai3d/mine`, whose `element:manage` capability reads like it was meant
// for bakers and is covered by the admin boundary regardless. Staff have no subscription to check.
//
// THE BAKER PATH IS BLAZE AND ABOVE. Sandeep: *"generating the 3d elements is allowed from blaze
// and above subscription only."* The rule lives in `lib/generate3d.js` and the baker-facing routes
// will sit OUTSIDE `/api/admin` (the way `uploads` does) and must ask it — `npm run
// check:generate-3d` fails on a generate route outside `/admin` that does not. It matters more here
// than for any other paid flag: this file does not import `services/aiCredits.js`, and `AI_ACTION`
// has no 3D key, so nothing meters a run. The plan flag is the only cost control there is.
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

/* When our copy is swept. Dated from the ROW rather than the object, which is a few minutes early —
   the safe direction: we would call it gone just before R2 does, never just after. */
const RUN_RETENTION_DAYS = FOLDER_RETENTION_DAYS['ai3d/runs'];
const mirrorExpiresAt = (row) => (row.glb_key && row.created_at
  ? new Date(Date.parse(row.created_at) + RUN_RETENTION_DAYS * 86400000).toISOString()
  : null);
const mirrorExpired = (row) => {
  const at = mirrorExpiresAt(row);
  return !!at && Date.parse(at) < Date.now();
};

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
  glbUrl: row.glb_key && !mirrorExpired(row) ? publicUrl(row.glb_key) : null,
  /* ⚠️ A STORED KEY IS NOT THE SAME AS A LIVE OBJECT. `ai3d/runs/` is swept after
     FOLDER_RETENTION_DAYS, and the ROW keeps its glb_key — so reporting `mirrored` straight off the
     column would promise a model R2 deleted, and hand out a URL that 404s with no explanation.
     Computed from the one shared number instead. */
  mirrored: !!row.glb_key && !mirrorExpired(row),
  mirrorExpiresAt: mirrorExpiresAt(row),
  /* Even after the file goes, the row keeps the prompt and both seeds — and the same prompt with
     the same seed returns the same mesh. So an expired generation is not lost, it is one
     regeneration away. Worth saying out loud, because the alternative reading is "your work is
     gone". */
  regeneratable: !!row.prompt && row.model_seed != null,
  modelSeed: row.model_seed ?? null,
  textureSeed: row.texture_seed ?? null,
  // A generation is NOT an element until somebody says so. Null means "generated, yours, not in the
  // catalogue" — which is a state the maker must still be able to see.
  promotedElementId: row.promoted_element_id ?? null,
  sourceImageUrl: row.source_image_key ? publicUrl(row.source_image_key) : null,
  createdAt: row.created_at,
});

/** Ask whichever vendor owns this row. Both services normalise to one shape. */
function poll(row) {
  if (row.provider === 'tripo') return tripo.getTask(row.vendor_task_id);
  return meshy.getAnyTask(row.vendor_task_id, row.mode === 'text' ? 'text' : 'image');
}

// POST /admin/ai3d/generate
// body: { provider, mode, prompt?, sourceImageKey?, parts?, texture? }
router.post('/admin/ai3d/generate', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    /* ⚠️ `parts` DEFAULTS TRUE HERE BECAUSE THE ONLY CALLER TODAY IS THE ADMIN STUDIO, which is
       building catalogue elements that staff finish by hand. The BAKER path, when it exists, sends
       `{ parts: false, texture: true, pbr: true }` — Sandeep: *"if have to choose between parts vs
       colored output, i would choose colored output... something that bakers can use directly."* A
       baker has a customer waiting and cannot sit colouring parts. The two cannot be combined
       (Tripo refuses it); `services/tripo.js` → `appearance()` resolves the fork. */
    const { provider = 'tripo', mode = 'text', prompt, sourceImageKey, parts = true, texture = false,
            pbr = false, lowPoly = false, faceLimit } = req.body ?? {};
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
        ? await tripo.createTextTo3D({ prompt, texture, pbr, parts, lowPoly, faceLimit })
        : await tripo.createImageTo3D({ imageUrl, texture, pbr, parts, lowPoly, faceLimit });
    } else {
      // Meshy splits as a SECOND task on a finished model, so `parts` is not passed here — the
      // studio asks for the split once this one succeeds. One vendor plans it, the other chains it.
      taskId = mode === 'text'
        ? await meshy.createTextTo3DTask({ prompt, targetPolycount: faceLimit })
        // Meshy has no pbr flag of its own — `shouldTexture` covers it, and pbr implies texture.
        : await meshy.createImageTo3DTask({ imageUrl, shouldTexture: texture || pbr, targetPolycount: faceLimit });
    }

    const { data, error } = await supabase
      .from('ai3d_generations')
      .insert({
        created_by: req.user.id,
        provider, mode,
        prompt: prompt ?? null,
        source_image_key: sourceImageKey ?? null,
        wants_parts: !!parts,
        vendor_task_id: taskId,
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
      .from('ai3d_generations').select('*').eq('id', req.params.id).single();
    if (error || !row) return res.status(404).json({ error: 'Not found' });
    /* ⚠️ A FINISHED ROW STILL HAS TO HAND BACK THE MODEL, and the first version did not — it
       returned early here, so reopening yesterday's run showed a status and an empty canvas. The
       model URL is the vendor's, not ours (see the note below on not mirroring every experiment
       into R2), so the only place to get it is the vendor, and that means asking even when there is
       nothing left to update. Cheap: one GET against a task that is already done. */
    if (TERMINAL.includes(row.status)) {
      if (row.glb_key) return res.json(present(row));
      try {
        const done = await poll(row);
        return res.json({ ...present(row), vendorModelUrl: done.modelUrl ?? null,
                          partNames: done.partNames ?? null });
      } catch (e) {
        console.error(`ai3d recall poll error (${row.provider}):`, e.message);
        return res.json(present(row));
      }
    }

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
      // Stored on the first poll that sees them. Without the seed a second attempt is an unrelated
      // model; with it, one answer can change and the rest hold still — the only form of "edit"
      // Tripo offers, since refine_model refuses anything current.
      ...(task.modelSeed   != null && row.model_seed   == null ? { model_seed:   task.modelSeed }   : {}),
      ...(task.textureSeed != null && row.texture_seed == null ? { texture_seed: task.textureSeed } : {}),
    };

    /* ⚠️ MIRROR THE MODEL THE MOMENT IT EXISTS. This used to hand the vendor URL straight back and
       keep no copy, on the argument that "studio runs are experiments that get looked at once and
       thrown away". That is true of STAFF measuring a vendor, and false of a baker who paid credits
       to put something on a cake tomorrow — and the vendor's URL expires either way. Measured on
       dev 2026-10-31: 8 successful runs, ONE with a copy, and that one came through the older
       routes/meshy.js which mirrors and says why.

       Into `ai3d/runs/`, which a lifecycle rule expires after 30 days
       (scripts/set-r2-lifecycle.mjs) — so nothing is lost while it matters and rejects do not
       accumulate for ever. Promotion to an element COPIES the file out of this prefix, so an
       element is never left pointing at an object with an expiry on it.

       ⚠️ A FAILED MIRROR MUST NOT FAIL THE POLL. The generation succeeded, the baker's credits are
       already spent, and the vendor URL still works right now — reporting failure here would turn a
       storage hiccup into a lost model. Logged, left unmirrored, and retried on the next poll
       because `glb_key` is still null. */
    if (task.status === 'SUCCEEDED' && task.modelUrl && !row.glb_key) {
      try {
        const upstream = await fetch(task.modelUrl);
        if (!upstream.ok) throw new Error(`vendor returned ${upstream.status}`);
        const buf = Buffer.from(await upstream.arrayBuffer());
        const glbKey = `ai3d/runs/${row.id}.glb`;
        await putObject(glbKey, buf, 'model/gltf-binary');
        update.glb_key = glbKey;
      } catch (mirrorErr) {
        console.error(`ai3d mirror failed for ${row.id}:`, mirrorErr.message);
      }
    }

    const { data: saved } = await supabase
      .from('ai3d_generations').update(update).eq('id', row.id).select('*').single();

    res.json({ ...present(saved ?? { ...row, ...update }), vendorModelUrl: task.modelUrl ?? null,
               partNames: task.partNames ?? null });
  } catch (err) {
    serverError(req, res, err);
  }
});

// GET /admin/ai3d/:id/model — stream the generated GLB through us.
//
// ⚠️ BECAUSE A VENDOR'S CDN DOES NOT OWE US A CORS HEADER. Tripo's does, Meshy's does not: the same
// studio code read a Tripo model happily and got "Failed to fetch" on a Meshy one, so the verdict
// panel went blank for exactly the vendor we were trying to compare. Proxying makes the studio
// vendor-agnostic — it always fetches from its own origin, which it is already authenticated
// against — and it costs one hop on a file nobody downloads twice.
//
// ⚠️ IT ALSO OUTLIVES THE SIGNED URL. Vendor links expire; a run reopened tomorrow would otherwise
// show a status and nothing to draw, which is the fault `recall` was built to fix in the first
// place. Here the server re-asks the vendor each time, so the link is always fresh.
router.get('/admin/ai3d/:id/model', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { data: row, error } = await supabase
      .from('ai3d_generations').select('*').eq('id', req.params.id).single();
    if (error || !row) return res.status(404).json({ error: 'Not found' });

    const url = row.glb_key ? publicUrl(row.glb_key) : (await poll(row)).modelUrl;
    if (!url) return res.status(409).json({ error: 'No model on this run yet' });

    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).json({ error: `vendor returned ${upstream.status}` });
    res.setHeader('Content-Type', 'model/gltf-binary');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    serverError(req, res, err);
  }
});

// ── GET /admin/ai3d/mine — what this person has generated ───────────────────────────────────────
// Sandeep: *"generated but not made a element yet- we should still be showing this to baker (may be
// in my decorations?)."* A generation they paid for must be findable whether or not they promoted
// it — otherwise the only record of it is a browser tab, and closing that loses the money.
//
// ⚠️ SCOPED TO THE MAKER, NOT THE BAKERY. `created_by` is who pressed the button, and a generation
// is a draft rather than a catalogue entry — a half-finished idea does not belong in front of a
// colleague until its maker promotes it.
router.get('/admin/ai3d/mine', requireAuth, requireCapability('element:manage'), async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 30, 1), 100);
    const { data, error } = await supabase
      .from('ai3d_generations')
      .select('*')
      .eq('created_by', req.user.id)
      .eq('status', 'SUCCEEDED')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return serverError(req, res, error);
    const rows = (data ?? []).map(present);
    res.json({
      rows,
      summary: {
        total: rows.length,
        // The two numbers worth seeing: how many are safe from vendor expiry, and how many are
        // still only drafts.
        mirrored:  rows.filter(r => r.mirrored).length,
        unpromoted: rows.filter(r => !r.promotedElementId).length,
      },
    });
  } catch (err) { serverError(req, res, err); }
});

// POST /admin/ai3d/:id/segment — Tripo smart segmentation: parts WITH names.
//
// ⚠️ SEPARATE FROM `/split` BECAUSE THE TWO VENDORS DO DIFFERENT THINGS. Meshy cuts a finished
// model into printable pieces; Tripo re-segments it and tells you what the pieces ARE. Collapsing
// them into one endpoint would have meant a body where half the fields are ignored depending on a
// provider flag, which is the type-branching rule 2 exists to stop.
router.post('/admin/ai3d/:id/segment', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { granularity = 'medium', hint } = req.body ?? {};
    const { data: row, error } = await supabase
      .from('ai3d_generations').select('*').eq('id', req.params.id).single();
    if (error || !row) return res.status(404).json({ error: 'Not found' });
    if (row.provider !== 'tripo') return res.status(400).json({ error: 'Smart segmentation is Tripo only' });
    if (row.status !== 'SUCCEEDED') return res.status(400).json({ error: 'Model is not finished yet' });

    let taskId;
    try {
      taskId = await tripo.createSmartSegmentation({ taskId: row.vendor_task_id, granularity, hint });
    } catch (vendorErr) {
      /* Same reasoning as the split route: this is a diagnostic, and the vendor's sentence is the
         answer being looked for. The task type here is the one field not confirmed live. */
      return res.status(502).json({ error: vendorErr.message });
    }

    const { data } = await supabase
      .from('ai3d_generations')
      .insert({
        created_by: req.user.id,
        provider: 'tripo', mode: row.mode,
        prompt: hint ?? row.prompt,
        source_image_key: row.source_image_key,
        wants_parts: true,
        vendor_task_id: taskId,
        status: 'PENDING',
      })
      .select('*').single();
    res.json({ ok: true, ...present(data) });
  } catch (err) {
    serverError(req, res, err);
  }
});

// POST /admin/ai3d/:id/split — Meshy only, as a second task against a finished model.
router.post('/admin/ai3d/:id/split', requireAuth, requireCapability('catalog:admin'), async (req, res) => {
  try {
    const { mode = 'auto', prompt } = req.body ?? {};
    const { data: row, error } = await supabase
      .from('ai3d_generations').select('*').eq('id', req.params.id).single();
    if (error || !row) return res.status(404).json({ error: 'Not found' });
    if (row.provider !== 'meshy') {
      return res.status(400).json({ error: 'Tripo splits at generation time — re-run with parts on' });
    }
    if (row.status !== 'SUCCEEDED') return res.status(400).json({ error: 'Model is not finished yet' });

    /* ⚠️ THE VENDOR'S MESSAGE REACHES THE SCREEN HERE, unlike everywhere else in this API. This is
       a staff diagnostic behind `catalog:admin`, and its entire job is to find out what a vendor
       does with a request — a generic "Internal server error" hides the one fact being looked for.
       It cost a round trip to learn that the Auto Split endpoint is `/print/split`. */
    let taskId;
    try {
      taskId = await meshy.createAutoSplitTask({ taskId: row.vendor_task_id, mode, prompt });
    } catch (vendorErr) {
      return res.status(502).json({ error: vendorErr.message });
    }
    const { data } = await supabase
      .from('ai3d_generations')
      .insert({
        created_by: req.user.id,
        provider: 'meshy', mode: row.mode,
        prompt: prompt ?? row.prompt,
        source_image_key: row.source_image_key,
        wants_parts: true,
        vendor_task_id: taskId,
        status: 'PENDING',
      })
      .select('*').single();
    res.json({ ok: true, ...present(data) });
  } catch (err) {
    serverError(req, res, err);
  }
});

export default router;
