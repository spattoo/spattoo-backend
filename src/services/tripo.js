import { config } from '../config.js';

// ── Tripo (tripo3d.ai) — the second 3D generator ────────────────────────────────────────────────
//
// Shaped deliberately like `services/meshy.js`: create a task, poll a task. The two vendors differ
// in almost every detail and agree on that one thing, so `routes/ai3d.js` can hold a single flow
// and switch vendors at the edges rather than forking per provider.
//
// ⚠️ WHY A SECOND VENDOR AT ALL, AND IT IS NOT PRICE. The expensive part of a generated element is
// not the generation — it is that AI output arrives as ONE fused mesh with the colour baked into a
// texture atlas, and a Spattoo element is only recolourable when it is separate meshes with no
// texture map (`CakeCanvas` → `userData.group`, `if (!mat.map)`). That gap is why `RecomposeEditor`
// exists, and why carving a model is currently manual work per element. Both vendors now claim to
// do that split themselves — Tripo with a Generate Parts add-on, Meshy with Auto Split — so the
// question the studio exists to answer is which one produces parts we can actually use.
//
// ⚠️ PRICE, FOR THE RECORD, from each vendor's own docs on 2026-10-29. Tripo bills a flat
// 1 credit = $0.01: text→model 10 (untextured) / 20 (textured), image→model 20 / 30, Generate Parts
// +20, segmentation 40–85. Meshy bills through plan tiers at roughly $0.015–0.02 a credit:
// text→3D preview 20 + refine 10, image→3D 20–35, Auto Split 10. So Tripo is around half per
// element — which matters far less than whether the parts come back usable.
//
// ⚠️ UNTEXTURED IS THE CHEAPER *AND* THE BETTER OPTION FOR US, which is the opposite of the usual
// trade. Our recolour path refuses a mesh carrying a map, so a texture we would have to strip costs
// credits to make and work to remove.

const BASE = 'https://api.tripo3d.ai/v2/openapi';

function apiKey() {
  // ⚠️ THROWN AT CALL TIME, NEVER AT BOOT. `config.js` records why at length: a vendor key as a
  // start-up condition means a bad rotation 502s the whole API instead of breaking one feature.
  if (!config.tripo.apiKey) {
    throw new Error('TRIPO_API_KEY is not set — add it to .env (local) / Render env (prod)');
  }
  return config.tripo.apiKey;
}

async function post(body) {
  const res = await fetch(`${BASE}/task`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Tripo create failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  // Tripo answers { code: 0, data: { task_id } }; a non-zero code is a failure carrying a 200.
  if (data?.code !== 0 || !data?.data?.task_id) {
    throw new Error(`Tripo create rejected: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.data.task_id;
}

/**
 * Text → model. `parts` asks Tripo to return the model already split.
 *
 * ⚠️ THE PARTS FLAG IS THE ONE FIELD HERE NOT CONFIRMED AGAINST A LIVE CALL. Tripo's pricing page
 * lists "Generate Parts" as a 20-credit add-on but their public task docs do not name the field, so
 * this sends the documented task shape plus `generate_parts`. If the first real run comes back
 * fused, read the response and correct it here — do not paper over it in the UI, because a silent
 * fused model is exactly the state RecomposeEditor was built to rescue by hand.
 */
export async function createTextTo3D({ prompt, texture = false, parts = false, modelVersion }) {
  return post({
    type: 'text_to_model',
    prompt,
    ...(modelVersion ? { model_version: modelVersion } : {}),
    texture,
    ...(parts ? { generate_parts: true } : {}),
  });
}

/** Image → model. `imageUrl` must be publicly reachable — ours live on R2 under `meshy/source/`. */
export async function createImageTo3D({ imageUrl, texture = false, parts = false, modelVersion }) {
  return post({
    type: 'image_to_model',
    file: { type: 'url', url: imageUrl },
    ...(modelVersion ? { model_version: modelVersion } : {}),
    texture,
    ...(parts ? { generate_parts: true } : {}),
  });
}

/** Split a finished model into parts after the fact — Tripo's own segmentation task. */
export async function createSegmentation({ taskId }) {
  return post({ type: 'mesh_segmentation', original_model_task_id: taskId });
}

/**
 * Poll a task, normalised to the same shape `routes/ai3d.js` reads from Meshy:
 * `{ status, progress, modelUrl, thumbnailUrl, credits, error }`.
 *
 * ⚠️ TRIPO'S STATUS VOCABULARY IS ITS OWN (`queued`/`running`/`success`/`failed`/`banned`), so it is
 * translated HERE rather than teaching the route two dialects. The route and the DB speak Meshy's
 * uppercase words because that is what every existing row and the webhook already carry.
 */
export async function getTask(taskId) {
  const res = await fetch(`${BASE}/task/${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${apiKey()}` },
  });
  if (!res.ok) throw new Error(`Tripo get failed (${res.status}): ${await res.text()}`);
  const body = await res.json();
  const t = body?.data ?? {};
  const STATUS = {
    queued: 'PENDING', running: 'IN_PROGRESS', success: 'SUCCEEDED',
    failed: 'FAILED', cancelled: 'CANCELED', banned: 'FAILED', unknown: 'PENDING',
  };
  return {
    raw: t,
    status: STATUS[String(t.status ?? '').toLowerCase()] ?? 'PENDING',
    progress: typeof t.progress === 'number' ? t.progress : 0,
    // Tripo has moved this field across versions; take the first that answers rather than pin one.
    modelUrl: t.output?.pbr_model ?? t.output?.model ?? t.result?.pbr_model?.url ?? t.result?.model?.url ?? null,
    thumbnailUrl: t.output?.rendered_image ?? t.result?.rendered_image?.url ?? null,
    credits: typeof t.consumed_credits === 'number' ? t.consumed_credits : null,
    error: t.status === 'failed' || t.status === 'banned' ? (t.error_msg ?? 'Tripo reported failure') : null,
  };
}
