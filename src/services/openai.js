import { config } from '../config.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// "Extract Elements" phase 1 — find each distinct decoration on a cake photo and, crucially, WHERE
// it is, so we can crop it out and use the real pixels as the reference image for regeneration.
//
// The bbox is the whole point. The previous version of this prompt asked GPT to write a rich
// text description and handed that to a text-only image model — the decoration made a round trip
// through English and came back generic. Now the crop conditions the generation directly, and the
// prompt only has to say what to CLEAN UP (isolate it, drop the cake behind it), not what it looks
// like. Vision models are imprecise at boxes, so we ask for a GENEROUS box and pad it further on
// crop: a little surrounding cake in the reference is harmless (the model is told to exclude it),
// whereas a tight box that clips the decoration is not recoverable.
export async function identifyElements(imageUrl) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openai.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
          {
            type: 'text',
            text: `You are a professional cake decorator cataloguing the decorations on this cake so each
one can be recreated as a reusable library asset.

Return ONLY a JSON object, no explanation:
{
  "cake": {
    "tiers": <1|2|3>,
    "frosting_type": "<buttercream|fondant|naked|ganache>",
    "frosting_color": "<hex colour of the main frosting>",
    "has_drip": <true|false>,
    "drip_color": "<hex colour of drip, or null>"
  },
  "elements": [
    {
      "element": "<rose|leaf|drip|topper|macaron|other>",
      "label": "<short name a baker would use, e.g. 'pink buttercream rosette'>",
      "color_hex": "<dominant hex colour>",
      "material": "<buttercream|fondant|acrylic|sugar|chocolate|other>",
      "bbox": { "x": <0..1>, "y": <0..1>, "w": <0..1>, "h": <0..1> },
      "licensed_ip": <true|false>,
      "ip_note": "<if licensed_ip, name the character/brand in a few words, e.g. 'Boss Baby (DreamWorks)'. Otherwise omit.>",
      "prompt": "<one sentence naming the decoration and its craft, e.g. 'a piped buttercream rosette made with a 1M tip, swirled creamy texture, dusty pink'. Describe ONLY the decoration itself — never the cake it sits on.>"
    }
  ]
}

About "bbox": the axis-aligned box around that ONE decoration, as fractions of the image
(x,y = top-left corner; w,h = width/height; all 0..1). Err on the side of a slightly LARGER box —
clipping part of the decoration is much worse than including a little cake around it.

About "licensed_ip": true when the decoration depicts INTELLECTUAL PROPERTY someone owns — a
recognisable cartoon/film/TV/game character (Boss Baby, Elsa, Spider-Man, Peppa Pig…), a brand or
company logo, a sports team crest, or a film/show title treatment. Judge the SUBJECT, not the craft:
a fondant figurine of a licensed character is licensed_ip, while a generic fondant teddy bear, a
plain star, a bow or a number is NOT. When genuinely unsure, prefer false — a generic decoration
wrongly flagged is a worse outcome than a licensed one slipping through, because a human reviews
these anyway.

Rules:
- Max 5 elements.
- Each PHYSICAL decoration gets its own entry, even if several are the same type in different places.
- Ignore the cake base, the board, plain frosting, sprinkles and pearls — they aren't standalone assets.
- Pick decorations that would actually be reusable on another cake.
- STILL list a licensed decoration (flagged), don't silently omit it — the human wants to see it was seen.`,
          },
        ],
      }],
    }),
  });

  if (!res.ok) throw new Error(`GPT-4o failed: ${await res.text()}`);
  const data = await res.json();
  const raw  = data.choices[0].message.content.trim();
  const json = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(json);
}

// Suggest the "craft guide" for a piping element — which real nozzle(s) made it,
// plus buttercream consistency and a technique tip. GROUNDED on the nozzle
// catalog: GPT may only return catalog `id`s, never invented tip numbers. The
// caller hydrates brand/number/name from the DB by id, so model transcription
// errors can't produce a wrong tip.
//   args: { imageUrl, name, description, catalog: [{ id, brand, number, name, category, description, is_common }] }
//   returns: { nozzle_recs: [{ nozzle_id, rank, confidence }], consistency, technique }
export async function suggestCraftGuide({ imageUrl, name, description, catalog }) {
  // Keep the catalog payload lean — name + category already encode the shape,
  // and gpt-4o knows these tips. Dropping the long descriptions roughly halves
  // the per-call token count (it ships on every request → matters for TPM limits).
  const compactCatalog = (catalog ?? []).map(n => ({
    id: n.id,
    brand: n.brand,
    number: n.number,
    name: n.name,
    category: n.category,
    common: !!n.is_common,
  }));

  const prompt = `You are a master cake decorator. Identify which piping nozzle(s) most likely produced the piped buttercream/cream decoration in this image.

You are given the element's name and search keywords (written by our team) and a CATALOG of real nozzles. Choose ONLY from the catalog.

Element name: ${name || '(none)'}
Keywords: ${description || '(none)'}

CATALOG (choose by "id" — never invent tips):
${JSON.stringify(compactCatalog)}

Rules:
- LOOK AT THE SURFACE TEXTURE FIRST, it decides the tip family:
  - Smooth, ridge-free surfaces (a round dome, a smooth peak/kiss, a plain rope or bead) = ROUND / PLAIN tips (e.g. Wilton 12, 1A, 2A; Ateco 80x). A smooth dome or peak is NEVER a star tip.
  - Grooves, ribs, flutes or sharp points running along the shape = STAR / FRENCH tips (e.g. 1M, 18, French).
  - Petal-like ribbons/ruffles = PETAL tips; vein-down leaves = LEAF tips.
- We do NOT know the real cake size, so DO NOT commit to one exact tip size. Recommend the SHAPE plus a SIZE RANGE:
  1. Decide the single best SHAPE (category) for this piping.
  2. For that shape, return the 2-3 catalog tips that span the plausible SIZE range for what you see (size-appropriate — a big dollop → large rounds like 1A and 2A, NOT a tiny #5; a fine bead → small rounds). Mark ALL of these rank "primary" — they are equally-valid size options; the baker picks the size that fits their cake.
  3. If a genuinely DIFFERENT shape is also plausible, add 1-2 of those as rank "secondary" (or "alternative"), again with size options if relevant.
- confidence = 0.0 to 1.0 reflects how sure you are of the SHAPE (so the size variants of one shape share a similar confidence). Do NOT lower confidence just because the exact size is unknown — that's expected.
- Within a shape/size band, prefer tips with "common": true.
- Only include tips that genuinely could have made this shape. Fewer good matches beat many weak ones.
- Also give the buttercream consistency this piping needs (stiff | medium | soft) and ONE short technique tip (tip angle, pressure, motion).

Return ONLY valid JSON, no explanation:
{
  "nozzle_recs": [{ "nozzle_id": "<catalog id>", "rank": "primary|secondary|alternative", "confidence": 0.0 }],
  "consistency": "stiff|medium|soft",
  "technique": "<one short sentence>"
}`;

  const payload = JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 450,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  // Retry on 429 (rate limit), honouring the "try again in Xs" hint so a batch
  // backfill self-throttles under the TPM cap instead of failing.
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      body: payload,
    });
    if (res.ok) break;
    const text = await res.text();
    if (res.status === 429 && attempt < 6) {
      const m = text.match(/try again in ([\d.]+)s/);
      const waitMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 750 : 6000 * (attempt + 1);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`GPT-4o craft-guide failed: ${text}`);
  }
  const data = await res.json();
  const raw  = data.choices[0].message.content.trim();
  const json = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(json);
}

// Cheap pre-flight gate for the image→3D wizard: decide whether an uploaded image is
// a good candidate for Meshy image-to-3D BEFORE spending ~30 credits on a generation.
// PASS only a single cake or single cake component on a plain-ish background; REJECT
// humans, scenes, and multi-object photos (they produce a fused, un-segmentable mesh).
//   returns: { ok: boolean, category: string, reason: string }
export async function validateCakeImage(imageUrl) {
  const prompt = `You are a quality gate for a 2D-image → 3D-model pipeline. The 3D model will later be
split into recolourable parts, so the input image must depict ONE clean subject on a plain background.

Decide if THIS image qualifies. Return ONLY a JSON object, no explanation:
{
  "ok": <true|false>,
  "category": "<cake|cake_component|topper|multiple_objects|person|scene|other>",
  "reason": "<one short sentence the user will read>"
}

PASS (ok:true) ONLY when the image is a single cake, a single cake component, or a single
cake topper/decoration, shown roughly isolated on a plain or simple background.

REJECT (ok:false) when ANY of these is true:
- a person, human/animal face, hands, or body is present  → category "person"
- a busy scene, room, table spread, or several distinct objects → category "scene" or "multiple_objects"
- the subject is not a cake / cake component / edible decoration → category "other"
Keep "reason" friendly and specific (e.g. "This photo has a person in it — upload just the cake").`;

  const payload = JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  // Same 429 backoff as suggestCraftGuide — honour the "try again in Xs" hint.
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      body: payload,
    });
    if (res.ok) break;
    const text = await res.text();
    if (res.status === 429 && attempt < 6) {
      const m = text.match(/try again in ([\d.]+)s/);
      const waitMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 750 : 6000 * (attempt + 1);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`GPT-4o validate-image failed: ${text}`);
  }
  const data = await res.json();
  const raw  = data.choices[0].message.content.trim();
  const json = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(json);
}

// Read a cake photo and produce a TIER-WISE reconstruction spec for the "Build from Inspiration"
// flow — everything needed to rebuild the cake from library elements. Controlled vocabularies on
// type/placement/frosting keep it machine-mappable for later (matching/composition); colours are
// always hex + a human name. Phase 1 just displays this; nothing is matched yet.
export async function analyzeCake(imageUrl) {
  const prompt = `You are a master cake decorator analysing a cake photo so it can be rebuilt from a parts library.
Describe ONLY what you can actually see. Return ONLY a JSON object, no prose:
{
  "cake": {
    "tier_count": <integer 1-5>,
    "shape": "<round|square|heart|number|sculpted|other>",
    "style": "<short phrase, e.g. 'buttercream lambeth', 'fondant modern'>",
    "board": { "present": <true|false>, "color_hex": "<hex or null>" }
  },
  "tiers": [
    {
      "index": <0-based; 0 = bottom>,
      "position": "<bottom|middle|top|single>",
      "height_ratio": <0..1 relative height, optional>,
      "frosting": {
        "type": "<buttercream|fondant|ganache|naked|whipped>",
        "finish": "<matte|satin|glossy|textured>",
        "base_color_hex": "<hex>",
        "color_name": "<human colour name>"
      },
      "decorations": [
        {
          "type": "<piping_border|rosette|flower|drip|topper|lettering|ribbon_bow|sprinkles|pearls|fruit|macaron|figurine|other>",
          "subtype": "<short, e.g. 'shell','rope','ruffle', or null>",
          "placement": "<top_surface|side|middle_tier|board|rim>",
          "rim_side": "<top|bottom — ONLY when placement is 'rim' (a border/edge); else null>",
          "color_hex": "<hex>",
          "material": "<buttercream|fondant|acrylic|sugar|chocolate|fresh|other, or null>",
          "technique": "<short, e.g. 'star tip (1M)', or null>",
          "text": "<for lettering, the exact text, else null>",
          "count": "<a number, or 'continuous', or 'few'>",
          "notes": "<short, optional>"
        }
      ]
    }
  ],
  "palette": [ { "hex": "<hex>", "name": "<colour name>" } ],
  "confidence": <0.0-1.0>,
  "observations": "<one or two sentences summarising the cake>"
}
Rules:
- Use ONLY the vocabularies above for type/placement/frosting/finish; if unsure, pick the closest.
- "placement" uses the cake's real zones: "top_surface" (flat top), "rim" (the edge where top meets side — a piped border lives here; set rim_side top or bottom), "side" (the vertical wall of a tier), "middle_tier" (the wall of a lower tier on a stacked cake), "board" (the base board the cake sits on).
- One tier object per visible tier, bottom first (index 0). A single-tier cake = tier_count 1, one tier, position "single".
- Group each decoration under the tier it sits on. A shell border around the top edge of the bottom tier belongs to that tier with placement "rim", rim_side "top"; a border where the cake meets the board is placement "rim", rim_side "bottom".
- ALWAYS give colours as hex AND a human name. "palette" = the 3-6 distinct colours used overall.
- Ignore the plate/stand/background; "board" is the cake board only.`;

  const payload = JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  // Same 429 backoff as the other vision calls.
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      body: payload,
    });
    if (res.ok) break;
    const text = await res.text();
    if (res.status === 429 && attempt < 6) {
      const m = text.match(/try again in ([\d.]+)s/);
      const waitMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 750 : 6000 * (attempt + 1);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`GPT-4o analyze-cake failed: ${text}`);
  }
  const data = await res.json();
  const raw  = data.choices[0].message.content.trim();
  const json = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(json);
}

// Embed text for inspiration-matching retrieval. text-embedding-3-small → 1536-dim vector,
// stored in cake_elements.description_embedding (pgvector) and used for KNN over the library.
export async function embedText(input) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input }),
    });
    if (res.ok) break;
    const text = await res.text();
    if (res.status === 429 && attempt < 6) {
      const m = text.match(/try again in ([\d.]+)s/);
      const waitMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 750 : 6000 * (attempt + 1);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`Embedding failed: ${text}`);
  }
  const data = await res.json();
  return data.data[0].embedding; // Float[1536]
}

// Server-side variant of /elements/suggest (description only): generate the comma-separated
// search-keyword `description` for an element from its image. Used by the element index
// backfill + the ingest safety-net. imageUrl = a public URL or a data URI.
export async function suggestDescription(imageUrl, elementType) {
  const prompt = `You are tagging a cake decoration element for search. Look at the image and return
8 to 12 comma-separated search KEYWORDS (no sentences) covering shape, technique, style, nozzle/tip
type, occasions and alternative names a baker might search. Element type: ${elementType || 'cake decoration'}.
Return ONLY JSON: { "description": "<comma-separated keywords>" }`;

  const payload = JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 160,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      body: payload,
    });
    if (res.ok) break;
    const text = await res.text();
    if (res.status === 429 && attempt < 6) {
      const m = text.match(/try again in ([\d.]+)s/);
      const waitMs = m ? Math.ceil(parseFloat(m[1]) * 1000) + 750 : 6000 * (attempt + 1);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`GPT-4o suggest-description failed: ${text}`);
  }
  const data = await res.json();
  const raw  = data.choices[0].message.content.trim();
  const json = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return (JSON.parse(json).description || '').trim();
}

// "Extract Elements" phase 2 — regenerate ONE decoration as a clean, isolated library asset,
// conditioned on the actual crop from the customer's photo (`/v1/images/edits`, multipart).
//
// Why an EDIT and not a generation: the crop is the ground truth. `input_fidelity: 'high'` tells the
// model to preserve the reference's identity rather than reinterpret it, which is the difference
// between recreating THIS rosette and inventing a stock one. No `mask` — we are not inpainting a
// region, we are re-rendering the whole (already cropped) subject in isolation.
//
// Model choice is env-driven because this family is churning fast: `dall-e-3` was REMOVED from the
// API on 2026-05-12 (this function used to call it, which is why the old extract job could never
// have worked), and `gpt-image-1` is deprecated for 2026-10-23. We default to `gpt-image-1.5`.
// `gpt-image-2` does NOT support `background: 'transparent'` — but that does not block a switch to
// it, because the background cut is not this pipeline's job: an extracted decoration gets its
// background removed by the standard 2D element pipeline (AddElement) if and when it is actually
// saved as an element. A transparent result here is a nice-to-have, not a dependency.
//
// Returns a PNG Buffer (GPT image models ALWAYS return base64 — `response_format` is a DALL·E-only
// param and there is no `url` to read).
export async function generateDecorationImage(cropBuffer, prompt) {
  const form = new FormData();
  form.append('model', config.openai.imageModel);
  form.append('image', new Blob([cropBuffer], { type: 'image/png' }), 'crop.png');
  form.append('prompt',
    `Recreate the decoration shown in the reference image as an isolated product photo: ${prompt}. ` +
    'Keep its exact shape, colour, texture and craft. Show ONLY the decoration — remove the cake, ' +
    'the frosting behind it, any board, hands or props. Fully transparent background, no shadow, ' +
    'soft even studio lighting, photorealistic, shot straight on.');
  form.append('size', '1024x1024');
  form.append('quality', config.openai.imageQuality);
  form.append('background', 'transparent');   // native cut-out; remove.bg is the fallback if ignored
  form.append('output_format', 'png');        // must be png/webp — jpeg cannot carry alpha
  form.append('input_fidelity', 'high');      // preserve the reference decoration's identity
  form.append('n', '1');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.openai.apiKey}` },   // no Content-Type — FormData sets the boundary
    body: form,
  });

  if (!res.ok) throw new Error(`${config.openai.imageModel} edit failed: ${await res.text()}`);
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${config.openai.imageModel} returned no image data`);
  return Buffer.from(b64, 'base64');
}
