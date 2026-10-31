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
// ⚠️ THERE ARE TWO KINDS OF ELEMENT AND THEY WANT OPPOSITE THINGS. This file used to say flatly
// that "untextured is the cheaper AND the better option for us" — true for a fondant lion a baker
// recolours, and wrong for a peacock feather, where the colour IS the decoration and nobody
// recolours it. Sandeep, on a Krishna-theme peacock: *"if we only get the mesh and not the
// colors/texture its not practical for user to do that... if have to choose between parts vs
// colored output, i would choose colored output than just mesh with parts. something that bakers
// can use directly."*
//
//   ready to use   texture + pbr, one fused mesh   — the BAKER default. A customer is waiting.
//   recolourable   parts, no maps                  — the catalogue path, finished by staff.
//
// ⚠️ AND YOU CANNOT HAVE BOTH IN ONE REQUEST. Tripo's own docs: *"generate_parts is not compatible
// with texture=true or pbr=true. If you want to generate parts, please set texture=false and
// pbr=false."* So this is a fork, not a pair of knobs — which is why `readyToUse()` below sets all
// three together rather than leaving three booleans for a caller to get into an impossible state.
//
// ⚠️ TRIPO DEFAULTS BOTH TO **true**; the `false` defaults here are OURS. Worth knowing when
// reading their docs against this file — we are switching their behaviour off, not leaving it
// alone, and for the baker path we should not be.
//
// ⚠️ `pbr` IS WHAT MAKES IT NOT LOOK MATTE. Plain `texture` returns a baseColor map only — right
// colours, flat surface. `pbr` adds the metallic-roughness map, which is what carries a peacock's
// iridescence and a flute's sheen. Their docs: if `pbr` is true, `texture` is ignored and treated
// as true. Measured on a real Meshy asset, that map is 1 of the 3 that make it read as metal and
// feather rather than painted plastic.

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

/* ── Keeping the model inside our own budget ────────────────────────────────────────────────────
 *
 * ⚠️ THE FIRST REAL RUN CAME BACK 20x OVER. Measured 2026-10-29, "a fondant bear sitting, with a
 * small pink bow": 13 separate parts, zero textures — structurally perfect — and **501,326
 * triangles in 12.2 MB**. Our decor cap is 25,000 triangles and 1 MB (`admin/lib/glb.js`), and
 * those caps exist because load time is dominated by distinct assets. Half a million triangles for
 * one decoration would undo a day's work on exactly that.
 *
 * ⚠️ `smart_low_poly` IS CAPPED AT 20,000 TRIANGLES BY TRIPO, which is the happy accident here: it
 * lands under our 25,000 without us having to pick a number. Their documented range for
 * `text_to_model` is 1,000–20,000.
 *
 * ⚠️ `quad` IS DELIBERATELY NOT OFFERED. It is listed beside these two and it FORCES THE OUTPUT TO
 * FBX — we need GLB, so a quad mesh would arrive in a format the designer cannot load at all. It
 * costs 5 credits to discover that.
 *
 * ⚠️ AND IT MAY NOT SURVIVE `generate_parts`. Tripo warn that low-poly "is best suited for simple,
 * non-complex inputs" and "complex models may occasionally fail". Whether asking for parts AND low
 * poly together works is unknown; if a run fails, that combination is the first suspect.
 */
function lowPolyFields({ lowPoly, faceLimit }) {
  if (!lowPoly && faceLimit == null) return {};
  return {
    ...(lowPoly ? { smart_low_poly: true } : {}),
    ...(faceLimit != null ? { face_limit: Math.max(500, Math.min(20000, Number(faceLimit))) } : {}),
  };
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
export async function createTextTo3D({ prompt, texture = false, pbr = false, parts = false,
                                       modelVersion, lowPoly = false, faceLimit }) {
  return post({
    type: 'text_to_model',
    prompt,
    ...(modelVersion ? { model_version: modelVersion } : {}),
    ...appearance({ texture, pbr, parts }),
    ...lowPolyFields({ lowPoly, faceLimit }),
  });
}

/**
 * The fork, resolved in ONE place so no caller can ask for an impossible model.
 *
 * ⚠️ PARTS WINS WHEN BOTH ARE ASKED FOR, and it is silent on purpose. Tripo rejects
 * parts+texture outright, so honouring both is not an option — and the caller that set `parts`
 * did so deliberately (it is never the default for a baker), while `texture` may have ridden
 * along from a form that remembered it. Dropping the one that was defaulted is the kinder guess.
 * `check:tripo-appearance` asserts the combination never leaves here.
 */
function appearance({ texture, pbr, parts }) {
  if (parts) return { generate_parts: true, texture: false, pbr: false };
  // Their docs: pbr=true forces texture=true regardless. Sent explicitly so the request says what
  // it means rather than relying on a vendor-side coercion we would have to remember.
  if (pbr) return { texture: true, pbr: true };
  return { texture: !!texture, pbr: false };
}

/** Image → model. `imageUrl` must be publicly reachable — ours live on R2 under `meshy/source/`. */
export async function createImageTo3D({ imageUrl, texture = false, pbr = false, parts = false,
                                        modelVersion, lowPoly = false, faceLimit }) {
  return post({
    type: 'image_to_model',
    file: { type: 'url', url: imageUrl },
    ...(modelVersion ? { model_version: modelVersion } : {}),
    ...appearance({ texture, pbr, parts }),
    ...lowPolyFields({ lowPoly, faceLimit }),
  });
}

/** Split a finished model into parts after the fact — Tripo's plain segmentation task. */
export async function createSegmentation({ taskId }) {
  return post({ type: 'mesh_segmentation', original_model_task_id: taskId });
}

/* ── Named parts, which is the thing `generate_parts` does not give ──────────────────────────────
 *
 * ⚠️ THE GAP THIS CLOSES WAS NEARLY MISSED. `generate_parts` returns a beautifully carved model
 * whose pieces are called `tripo_part_0 … tripo_part_10` — correct geometry, useless labels — and
 * the conclusion drawn from that was "naming is manual work we have to do in RecomposeEditor".
 * Sandeep asked whether Tripo could be told the names. It can, and this is where:
 *
 *   `hint`        a sentence describing the parts, e.g. "a bear with a bow, ears and feet"
 *   `granularity` coarse (2-3 parts) / medium (4-8) / fine (9-52)
 *   → `part_names` comes BACK in the response, comma separated
 *
 * ⚠️ GRANULARITY MATTERS AS MUCH AS NAMING. `generate_parts` gave 13 pieces for one bear — an eye,
 * an ear and a foot each separately — which is far finer than a baker wants to colour. `coarse`
 * and `medium` are the cake-decoration settings; `fine` is for game assets.
 *
 * ⚠️ AND IT COSTS ROUGHLY DOUBLE: smart segmentation on a model is 55 credits against
 * `generate_parts` at 20, so a named element is about $0.65 where an unnamed one is $0.30. Whether
 * that is worth it is a judgement about how much the manual naming step costs us, not a technical
 * question — which is exactly why the studio offers both rather than choosing.
 *
 * ⚠️ THE TASK TYPE IS THE ONE FIELD NOT CONFIRMED AGAINST A LIVE CALL. Tripo's published task list
 * names `mesh_segmentation`; their Smart Segmentation is documented by its PARAMETERS everywhere
 * (source / model_task_id / granularity / hint) and by its type string nowhere public. So this
 * sends the documented parameters under that type, and the route hands Tripo's own refusal back to
 * the studio rather than swallowing it — one call settles it, and the error will name the field.
 */
export async function createSmartSegmentation({ taskId, granularity = 'medium', hint }) {
  return post({
    type: 'mesh_segmentation',
    source: 'model',
    model_task_id: taskId,
    original_model_task_id: taskId,   // the plain task names it this way; sent for both spellings
    granularity,
    ...(hint ? { hint } : {}),
  });
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
    /* Smart segmentation answers with the names it gave the parts — the whole reason to pay for it. */
    partNames: t.output?.part_names ?? t.result?.part_names ?? t.part_names ?? null,
    error: t.status === 'failed' || t.status === 'banned' ? (t.error_msg ?? 'Tripo reported failure') : null,
  };
}
