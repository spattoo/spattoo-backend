import { supabase } from './supabase.js';
import { putObject } from './r2.js';
import * as meshy from './meshy.js';
import * as tripo from './tripo.js';

// ── Moving a generation forward, in ONE place ────────────────────────────────────────────────────
//
// Asking the vendor where a run has got to, writing what came back, and storing the model the
// moment it exists. Extracted from `routes/ai3d.js`, which did all three inline.
//
// ⚠️ IT WAS EXTRACTED BECAUSE A SECOND CALLER IS THE WHOLE POINT. Until now the only thing that
// advanced a generation was a browser: `Element3DStudio` runs a setInterval and hits
// `GET /admin/ai3d/:id`. That is fine for staff watching a comparison and wrong for a baker — their
// credits are reserved when the run starts, so whether they are charged or refunded would depend on
// keeping a tab open. Close the laptop and the credits sit in limbo: not spent, not returned.
//
// So a job polls too (`jobs/processors/pollAi3d.js`). Two callers, one behaviour — had this been
// copied instead of shared, the job and the screen would answer differently about the same run, and
// the one nobody watches would be the one that drifts.
//
// ⚠️ IT DOES NOT TOUCH CREDITS, deliberately. Charging belongs to whoever reserved, and today
// nobody does — no baker can generate yet. When that route exists, the caller commits or releases
// around this. Metering buried inside a poll helper is how a refund gets missed.

export const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELED'];
const RUN_PREFIX = 'ai3d/runs/';

/** Ask whichever vendor owns this row. Both services normalise to one shape. */
export function poll(row) {
  if (row.provider === 'tripo') return tripo.getTask(row.vendor_task_id);
  return meshy.getAnyTask(row.vendor_task_id, row.mode === 'text' ? 'text' : 'image');
}

/**
 * Poll the vendor and write what came back. Returns `{ row, task, stored, changed }`.
 *
 * Throws only if the VENDOR call fails — a caller decides whether that is fatal. It is not for the
 * studio (the screen keeps its last known state and tries again) and it is not for the job either
 * (a vendor blip must not mark a running generation dead).
 */
export async function advanceGeneration(row) {
  const task = await poll(row);

  const update = {
    status: task.status,
    progress: task.progress,
    updated_at: new Date().toISOString(),
    ...(task.credits != null ? { consumed_credits: task.credits } : {}),
    ...(task.thumbnailUrl ? { thumbnail_url: task.thumbnailUrl } : {}),
    ...(task.error ? { error: task.error } : {}),
    /* Stored on the first poll that sees them. Without the seed a second attempt is an unrelated
       model; with it, one answer can change and the rest hold still — the only form of "edit" Tripo
       offers, since refine_model refuses anything current. */
    ...(task.modelSeed   != null && row.model_seed   == null ? { model_seed:   task.modelSeed }   : {}),
    ...(task.textureSeed != null && row.texture_seed == null ? { texture_seed: task.textureSeed } : {}),
  };

  /* ⚠️ STORE THE MODEL THE MOMENT IT EXISTS, because the asset is ours to serve — we put it in our
     own bucket behind our own CDN, and would even if the vendor kept theirs for ever.
     ⚠️ AND A FAILED STORE MUST NOT FAIL THE ADVANCE. The generation succeeded and the credits are
     spent; a storage hiccup must not become a lost model, nor stop the row reaching SUCCEEDED,
     which is what a waiting caller is watching for. Logged, `glb_key` left null, retried on the
     next poll because the guard below is still true. */
  let stored = false;
  if (task.status === 'SUCCEEDED' && task.modelUrl && !row.glb_key) {
    try {
      const upstream = await fetch(task.modelUrl);
      if (!upstream.ok) throw new Error(`vendor returned ${upstream.status}`);
      const buf = Buffer.from(await upstream.arrayBuffer());
      const glbKey = `${RUN_PREFIX}${row.id}.glb`;
      await putObject(glbKey, buf, 'model/gltf-binary');
      update.glb_key = glbKey;
      stored = true;
    } catch (storeErr) {
      console.error(`ai3d store failed for ${row.id}:`, storeErr.message);
    }
  }

  const { data: saved } = await supabase
    .from('ai3d_generations').update(update).eq('id', row.id).select('*').single();

  return {
    row: saved ?? { ...row, ...update },
    task,
    stored,
    // Did this advance actually move the run on? The job uses it to keep its log honest about how
    // much it did, rather than reporting every row it looked at as progress.
    changed: task.status !== row.status || stored,
  };
}
