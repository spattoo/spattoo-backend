import { config } from '../config.js';

const BASE = 'https://api.meshy.ai/openapi/v1/image-to-3d';
const TEXT_BASE = 'https://api.meshy.ai/openapi/v2/text-to-3d';
/* ⚠️ `/print/split`, NOT `/auto-split`. The feature is called Auto Split and the endpoint is not —
   it lives under `print` because Meshy ship it for 3D printing. Guessing the obvious URL returned a
   500 that surfaced as "Internal server error", which is why the route below now hands the vendor's
   own message back to the studio. */
const SPLIT_BASE = 'https://api.meshy.ai/openapi/v1/print/split';

function apiKey() {
  if (!config.meshy.apiKey) {
    throw new Error('MESHY_API_KEY is not set — add it to .env (local) / Render env (prod)');
  }
  return config.meshy.apiKey;
}

// Create an image-to-3D task. `imageUrl` must be a public URL or a base64 data URI.
// Single-stage: returns the task id immediately; generation runs for minutes inside Meshy.
// Caller tracks completion via the webhook (prod) or by polling getTask (local/fallback).
export async function createImageTo3DTask({
  imageUrl,
  shouldTexture = true,
  aiModel = 'latest',
  targetPolycount,
  targetFormats = ['glb'],
}) {
  const body = {
    image_url: imageUrl,
    should_texture: shouldTexture,
    ai_model: aiModel,
    target_formats: targetFormats,
  };
  if (targetPolycount) body.target_polycount = targetPolycount;

  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Meshy create failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  // Meshy returns { result: "<task_id>" }
  return data.result;
}

// Fetch a task's current state: { id, status, progress, model_urls, thumbnail_url,
// consumed_credits, task_error }. status ∈ PENDING|IN_PROGRESS|SUCCEEDED|FAILED|CANCELED.
export async function getTask(taskId) {
  const res = await fetch(`${BASE}/${taskId}`, {
    headers: { 'Authorization': `Bearer ${apiKey()}` },
  });
  if (!res.ok) throw new Error(`Meshy get failed (${res.status}): ${await res.text()}`);
  return res.json();
}


/**
 * Text → 3D, preview stage: GEOMETRY ONLY, no texture.
 *
 * ⚠️ UNTEXTURED IS THE ONE WE WANT, AND IT IS ALSO THE CHEAP ONE. Meshy's two stages are preview
 * (mesh, 20 credits) then refine (texture, 10–15). A Spattoo element only recolours when its
 * meshes carry no texture map — `CakeCanvas` does `if (!mat.map) mat.color = …` — so paying for a
 * texture would buy something we then have to strip. Refine stays unimplemented until somebody
 * wants a fixed-colour element badly enough to ask for it.
 */
export async function createTextTo3DTask({ prompt, artStyle = 'realistic', targetPolycount }) {
  const body = { mode: 'preview', prompt, art_style: artStyle };
  if (targetPolycount) body.target_polycount = targetPolycount;
  const res = await fetch(TEXT_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Meshy text-to-3D create failed (${res.status}): ${await res.text()}`);
  return (await res.json()).result;
}

/**
 * Auto Split — cut a finished model into separate parts.
 *
 * ⚠️ THIS IS THE ENDPOINT THE WHOLE STUDIO EXISTS TO TEST. Meshy documents it for 3D printing, but
 * what it does is semantic segmentation, and crucially it "rebuilds the cut parts and assigns each
 * one a FLAT VERTEX COLOR" rather than preserving the texture — which is structurally what our
 * recolour path wants. `by_parts` cuts along parts named in a prompt, which is the mode worth
 * trying first for a cake decoration: "petals, stem, leaves" is a sentence a baker could write.
 *
 * ⚠️ VERTEX COLOUR IS NOT THE SAME AS A MATERIAL COLOUR, and the difference is not cosmetic. Our
 * recolour writes `mat.color`, which MULTIPLIES with any vertex colour rather than replacing it —
 * so parts that come back flat-shaded may tint instead of recolouring. That is the first thing to
 * look at in the studio once a real split comes back; do not assume it works because the parts
 * separated.
 *
 * ⚠️ THE REQUEST SHAPE IS NOT CONFIRMED AGAINST A LIVE CALL. Taken from Meshy's Auto Split docs;
 * if the first run 400s, read the error and fix it here rather than in the caller.
 */
export async function createAutoSplitTask({ taskId, mode = 'auto', prompt }) {
  /* `layout: assembled` is the default and the one we want — `on_plate` lays the parts out flat for
     a printer bed, which would hand back a decoration in pieces on the floor. */
  const body = { input_task_id: taskId, mode, target_formats: ['glb'], layout: 'assembled' };
  if (prompt) body.prompt = prompt;
  const res = await fetch(SPLIT_BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Meshy auto-split failed (${res.status}): ${await res.text()}`);
  return (await res.json()).result;
}

/** Poll any Meshy task, normalised to the shape `routes/ai3d.js` reads from both vendors. */
export async function getAnyTask(taskId, kind = 'image') {
  const base = kind === 'text' ? TEXT_BASE : kind === 'split' ? SPLIT_BASE : BASE;
  const res = await fetch(`${base}/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (!res.ok) throw new Error(`Meshy get failed (${res.status}): ${await res.text()}`);
  const t = await res.json();
  return {
    raw: t,
    status: t.status ?? 'PENDING',
    progress: typeof t.progress === 'number' ? t.progress : 0,
    modelUrl: t.model_urls?.glb ?? null,
    thumbnailUrl: t.thumbnail_url ?? null,
    credits: typeof t.consumed_credits === 'number' ? t.consumed_credits : null,
    error: t.task_error?.message ?? null,
  };
}
