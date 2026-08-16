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

Each asset is placed INDIVIDUALLY by someone designing their own cake — they pick a lipstick and put
it where they want it. So the unit is the single object a person would place, never a scene or a
grouping of several objects.

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
- List up to 12 decorations. Do NOT bundle things together to fit a smaller number.
- ONE OBJECT PER ENTRY. Never a group, set, collection, pair, arrangement or "assortment".
  A cake with a lipstick, a nail polish bottle and a compact mirror is THREE entries — never one
  "makeup set". If you are about to write a plural or a collective noun in "prompt", you are
  grouping: split it instead.
- One entry per DISTINCT decoration. Three identical lipsticks are ONE entry, not three — each
  entry becomes a reusable library asset that gets placed as many times as wanted.
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
// ── Two gates, because two pipelines want opposite things ─────────────────────────────────────
//
//   'single_subject' (default) — Image → 3D. Meshy reconstructs ONE object and the result is split
//                    into recolourable parts, so anything beside the subject becomes geometry that
//                    should not be there. A decorated cake is correctly turned away here.
//
//   'decorated_cake' — Extract Elements and Build from Inspiration. The whole point is a cake with
//                    things ON it: the model lists the decorations so each can be regenerated.
//                    Under the single-subject prompt a busy makeup cake reads as `multiple_objects`
//                    and is rejected — which turns away exactly the references worth using.
//
// The difference is not strictness. It is what counts as ONE thing: an object, or a cake.
export async function validateCakeImage(imageUrl, purpose = 'single_subject') {
  const SINGLE = `You are a quality gate for a 2D-image → 3D-model pipeline. The 3D model will later be
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

  const DECORATED = `You are a quality gate for a pipeline that reads the DECORATIONS off a reference
cake. A heavily decorated cake is the IDEAL input — the decorations are the entire reason we are
looking at it.

Decide if THIS image qualifies. Return ONLY a JSON object, no explanation:
{
  "ok": <true|false>,
  "category": "<cake|cake_component|topper|multiple_objects|person|scene|other>",
  "reason": "<one short sentence the user will read>"
}

PASS (ok:true) whenever ONE cake is the clear subject, NO MATTER HOW MANY DECORATIONS ARE ON IT.
A cake carrying ten separate items — figures, toppers, objects modelled in fondant — PASSES.
Things sitting ON the cake are part of the cake; they are never "multiple objects".

A MODELLED FIGURE IS A DECORATION, NOT A PERSON. A doll, character or human figure sculpted in
fondant, sugar, icing, marzipan or plastic is one of the decorations we are cataloguing — it is
craft, not a photograph of anybody. Judge the MATERIAL, not the subject: if it is modelled, it
passes.

REJECT (ok:false) ONLY when:
- a REAL human being appears in the photograph — an actual person's face, hands or body, e.g. someone
  holding or standing behind the cake → category "person"
- a PRINTED PHOTOGRAPH of a real person appears on the cake (an edible photo print) → category "person"
- there is no cake at all → category "other"
- several SEPARATE cakes, or a table spread where no single cake is the subject → category "scene"
Keep "reason" friendly and specific (e.g. "This photo has a person in it — upload just the cake").`;

  const prompt = purpose === 'decorated_cake' ? DECORATED : SINGLE;

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

// Read a cake photo and produce a TIER-WISE reconstruction spec — everything needed to rebuild the
// cake from library elements. Controlled vocabularies on type/placement/frosting keep it
// machine-mappable (services/inspirationMatch.js scores each decoration against the element index);
// colours are always hex + a human name.
//
// TWO consumers now, and the second one is why the ratios are not optional:
//   1. "Build from Inspiration" — displays the spec / matches it to library elements.
//   2. X-Ray for photo-only orders — services/xraySpec.js maps this onto a design_snapshot
//      so the existing X-Ray pipeline runs over an order that never touched the 3D designer.
//
// For (2) the tin plan is the highest-value output, and computeTinPlan() splits the order's weight
// across tiers by their RELATIVE volumes (r²·h, or w·d·h). It needs nothing absolute — which is
// fortunate, because absolute size is the one thing an uncalibrated photo cannot give. Hence
// height_ratio + width_ratio: proportions are visible, inches are not. Without width_ratio the tin
// plan falls back to a blind 0.62^i taper, and a wrong tin is a re-bake.
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
      "height_ratio": <this tier's height as a fraction of the WHOLE cake's height, 0..1>,
      "width_ratio": <this tier's width as a fraction of the WIDEST tier's width, 0..1>,
      "frosting": {
        "type": "<buttercream|fondant|ganache|naked|whipped>",
        "finish": "<matte|satin|glossy|textured>",
        "base_color_hex": "<hex>",
        "color_name": "<human colour name>"
      },
      "decorations": [
        {
          "type": "<piping_border|rosette|flower|drip|topper|lettering|ribbon_bow|sprinkles|pearls|fruit|macaron|figurine|photo_print|other>",
          "subtype": "<short, e.g. 'shell','rope','ruffle', or null>",
          "placement": "<top_surface|side|middle_tier|board|rim>",
          "rim_side": "<top|bottom — ONLY when placement is 'rim' (a border/edge); else null>",
          "color_hex": "<hex>",
          "material": "<buttercream|fondant|acrylic|sugar|chocolate|fresh|other, or null>",
          "technique": "<short, e.g. 'star tip (1M)', or null>",
          "text": "<for lettering, the exact text, else null>",
          "count": "<a number, or 'continuous', or 'few'>",
          "notes": "<short, optional>",
          "bbox": "<[x, y, w, h] as fractions 0-1 of the image, tightly around THIS decoration, or null>",
          "tier_width_ratio": "<this decoration's WIDTH as a fraction of the width of the tier it sits on, or null>"
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
- A PHOTOGRAPH printed on the cake (an edible image / photo cake) is type "photo_print". Report it
  like any other decoration — it is a real feature of the cake and the report must not pretend it is
  absent — but describe it ONLY as "printed photograph". Do NOT describe, name, characterise or
  guess at anyone appearing in it: not their age, sex, appearance, expression, relationship, or who
  they might be. "notes" and "text" must contain nothing identifying. If a person appears anywhere
  in the image other than as a printed photo (holding the cake, standing behind it), ignore them
  entirely — they are not part of the cake.
- height_ratio and width_ratio are RELATIVE and always required. Do NOT try to estimate real
  dimensions in inches or centimetres — a photo has no scale reference and any absolute number
  would be a guess. Only the PROPORTIONS between tiers are asked for, and those you can see:
  the widest tier is width_ratio 1.0 and the others are judged against it; the tier heights
  sum to roughly 1.0. A single-tier cake is width_ratio 1.0, height_ratio 1.0.
- "placement" uses the cake's real zones: "top_surface" (flat top), "rim" (the edge where top meets side — a piped border lives here; set rim_side top or bottom), "side" (the vertical wall of a tier), "middle_tier" (the wall of a lower tier on a stacked cake), "board" (the base board the cake sits on).
- One tier object per visible tier, bottom first (index 0). A single-tier cake = tier_count 1, one tier, position "single".
- Group each decoration under the tier it sits on. A shell border around the top edge of the bottom tier belongs to that tier with placement "rim", rim_side "top"; a border where the cake meets the board is placement "rim", rim_side "bottom".
- ALWAYS give colours as hex AND a human name. "palette" = the 3-6 distinct colours used overall.
- Ignore the plate/stand/background; "board" is the cake board only.
- "bbox" locates ONE decoration in the photo so the sheet can show a close-up of it. [x, y, w, h]
  as fractions of the whole image, origin top-left. Crop tightly around the decoration itself, not
  the tier it sits on. For something repeated around the cake (a piped border, sprinkles), box ONE
  clear instance rather than the whole run. Use null when you cannot place it confidently — a
  wrong crop shows the baker a picture of the wrong thing, which is worse than showing none.
- "tier_width_ratio" is how the sheet works out the decoration's REAL size, so it can print a
  template at actual size. Judge it against the tier the decoration sits on: a bow spanning about
  a third of the tier's width is 0.33. Do NOT use the bbox for this — the bbox is measured against
  the photo, and the cake does not fill the photo. Compare the decoration to the CAKE, by eye, the
  way you would say "that bow is about a third as wide as the cake". Use null when the decoration
  is continuous around the cake (a piped border, sprinkles) or when you cannot judge it — a
  template printed at the wrong size is worse than no template, because the baker cuts to it.`;

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
  // Returns { analysis, usage, model } rather than the bare analysis, because a METERED caller has
  // to record what the call cost and cannot know that from the request alone. `model` is the id the
  // API actually served (dated, e.g. gpt-4o-2024-08-06) — not the one we asked for — so the ledger
  // records what ran rather than what we intended to run.
  return { analysis: JSON.parse(json), usage: data.usage ?? null, model: data.model ?? 'gpt-4o' };
}

// Embed text for inspiration-matching retrieval. text-embedding-3-small → 1536-dim vector,
// stored in cake_elements.description_embedding (pgvector) and used for KNN over the library.
// Returns { embedding, usage, model } — same reason as analyzeCake above.
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
  return {
    embedding: data.data[0].embedding, // Float[1536]
    usage: data.usage ?? null,
    model: data.model ?? 'text-embedding-3-small',
  };
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
// ── Generation RECIPES, by what the element will BECOME ───────────────────────────────────────
// One prompt used to serve every element: "photorealistic, shot straight on, no shadow". That is
// right for a printed sticker and wrong for the other two, in opposite directions.
//
//   sticker — printed on edible paper and stuck on. Flat is not a compromise, it is what the baker
//             actually makes. A bold outline helps the cut.
//
//   relief  — a fondant cut-out (placement_config.relief). Here the image stops being a picture:
//             `buildSolidReliefGeometry` traces the ALPHA into a silhouette and extrudes it, and
//             LUMINANCE bakes the normal map. So shading becomes bumps, a dark outline paints a
//             halo on the extruded wall (which is why the wall sampler already insets 2% inward),
//             thin protrusions poke off the wall (hence bake.flattenThin), and interior holes are
//             not cut at all in v1. Every one of those is a prompt instruction, not a bug to fix
//             downstream.
//
//   model   — the input to image-to-3D (Meshy). The exact OPPOSITE of the other two: a straight-on,
//             evenly-lit, flat image gives a reconstruction model ZERO depth cues, so it invents
//             all of them — which is what "it gets the details wrong" actually is. Three-quarter
//             view, soft studio light and a matte surface are what carry shape information.
//
// Shared by all three: complete and whole in frame. A tall subject sent to a square frame came back
// with its legs cut off; composeReference now matches the frame to the crop, and the prompt backs
// that up rather than relying on it alone.
// "Show ONLY the decoration" used to list the cake, board, hands and props. That covers everything
// EXCEPT the thing that actually goes wrong: on a busy cake the neighbouring DECORATIONS come along
// too. A makeup palette asked for as a `model` came back with the nail polish and brush that sat
// beside it — the crop had all three, and nothing here said otherwise. The bbox prompt deliberately
// errs LARGER (clipping a subject is worse than including some cake), composeReference adds more
// margin on top, so a tight crop is not something to rely on. The exclusion has to be stated.
const FRAMING =
  'Show the decoration COMPLETE and WHOLE, entirely within the frame with a small margin around it — ' +
  'never crop, cut off or run any part of it past the edge. ' +
  'EXACTLY ONE OBJECT in the output — never a set, pair, group, collection or arrangement, and no ' +
  'second item placed beside or behind it. ' +
  'Show ONLY that one decoration — remove the cake, the frosting behind it, any board, hands or ' +
  'props, and any OTHER decoration that happens to be nearby.';

export const GENERATION_INTENTS = ['sticker', 'relief', 'model'];

// How closely the output copies the reference crop.
//
//   reference  images/edits, input_fidelity high — reproduce THAT object. Right when rebuilding a
//              cake you have seen: the gold cap, the exact shade.
//   fresh      images/generations from the description alone. Nothing of the source photo is sent,
//              so the asset inherits none of its angle, wonk or branding — and there is no input
//              image to tokenise, so it costs less. Usually the better catalogue asset, because a
//              faithful copy of one baker's lopsided fondant is not more reusable for being
//              faithful.
export const GENERATION_FIDELITIES = ['reference', 'fresh'];

const RECIPES = {
  sticker:
    `${FRAMING} Fully transparent background, no shadow, soft even studio lighting, ` +
    'photorealistic, shot straight on.',

  relief:
    `${FRAMING} Fully transparent background with a CRISP HARD EDGE — no soft or feathered ` +
    'transparency. Flat even lighting with NO shadows and no directional shading anywhere on the ' +
    'subject. NO dark outline or stroke around the silhouette. One solid connected shape: no ' +
    'holes, gaps or see-through areas inside it, and no thin spikes, whiskers, stems or antennae ' +
    'on the outline. Shot straight on, flat to the camera.',

  model:
    `${FRAMING} Plain light grey background. THREE-QUARTER view from a slightly raised camera, so ` +
    'the form reads as solid and its depth is visible. Soft even studio lighting with no harsh ' +
    'shadows. Matte, clay-like, non-reflective surface. A single object, sitting upright, ' +
    'photographed sharply from front to back.',
};

// Returns an ARRAY of PNG buffers, one per variant. `variants` asks the API for n images in ONE
// call rather than n calls: the rate limit counts IMAGES per minute either way, so looping would
// buy nothing and cost n round trips.
export async function generateDecorationImage(
  referenceBuffer, prompt, size = '1024x1024', intent = 'sticker', fidelity = 'reference',
  variants = 1,
) {
  const n = Math.max(1, Math.min(4, Number(variants) || 1));
  // Unknown values fall back rather than throwing — a bad one should produce the previous
  // behaviour, not lose a generation the caller has already paid for.
  const recipe = RECIPES[intent] ?? RECIPES.sticker;
  // `fresh` needs a reference to be ABSENT, so a missing buffer selects it rather than crashing.
  const fresh  = fidelity === 'fresh' || !referenceBuffer;

  // Transparent for the two FLAT intents — a native cut-out, with remove.bg as the fallback if the
  // model ignores it. NOT for `model`: image-to-3D wants a plain backdrop it can separate the
  // subject from, and an alpha channel there is a hard silhouette with nothing behind it — the
  // opposite of the shading cue that recipe asks for.
  const wantsTransparent = intent !== 'model';

  // ── fresh: generate from the description, send nothing of the source ───────────────────────────
  // A different ENDPOINT, not a flag. images/edits always conditions on the image it is given, so
  // "ignore the reference" is not something a prompt can ask for — the only way not to copy the
  // photo is not to send it. That also means no input image to tokenise, which is where the saving
  // comes from.
  if (fresh) {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.openai.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.openai.imageModel,
        prompt: `An isolated product photo of a single cake decoration: ${prompt}. ${recipe}`,
        size,
        quality: config.openai.imageQuality,
        output_format: 'png',
        n,
        ...(wantsTransparent ? { background: 'transparent' } : {}),
      }),
    });
    if (!res.ok) throw new Error(`${config.openai.imageModel} generation failed: ${await res.text()}`);
    return decodeImages(await res.json());
  }

  // ── reference: reproduce THAT object ───────────────────────────────────────────────────────────
  const form = new FormData();
  form.append('model', config.openai.imageModel);
  form.append('image', new Blob([referenceBuffer], { type: 'image/png' }), 'reference.png');
  // "the decoration shown in the reference image" is ambiguous the moment the crop holds more than
  // one — and with input_fidelity high, ambiguity resolves as "copy all of it". Name the single
  // subject, then say plainly that anything else in the frame is not wanted.
  form.append('prompt',
    `Recreate ONE decoration from the reference image as an isolated product photo: ${prompt}. ` +
    'That description names the ONLY subject. The reference may also show other decorations or ' +
    'objects around it — reproduce NONE of them, however prominent they are. ' +
    `Keep the subject's exact shape, colour, texture and craft. ${recipe}`);
  form.append('size', size);
  form.append('quality', config.openai.imageQuality);
  if (wantsTransparent) form.append('background', 'transparent');
  form.append('output_format', 'png');        // must be png/webp — jpeg cannot carry alpha
  form.append('input_fidelity', 'high');      // preserve the reference decoration's identity
  form.append('n', String(n));

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.openai.apiKey}` },   // no Content-Type — FormData sets the boundary
    body: form,
  });

  if (!res.ok) throw new Error(`${config.openai.imageModel} edit failed: ${await res.text()}`);
  return decodeImages(await res.json());
}

// GPT image models always return base64 — `response_format` is a DALL·E-only param and there is no
// url to read. Throws on an empty set rather than returning [], so a caller cannot mistake "the API
// gave us nothing" for "no variants were asked for".
function decodeImages(data) {
  const out = (data?.data ?? []).map(d => d?.b64_json).filter(Boolean).map(b => Buffer.from(b, 'base64'));
  if (!out.length) throw new Error(`${config.openai.imageModel} returned no image data`);
  return out;
}

// Read a decoration's image and write a step-by-step BUILD GUIDE for making it by hand — the
// fondant_figure guide type from FONDANT_BUILD_GUIDE_PLAN.md, generated for a baker's own uploaded
// decoration (which is always a 2D image; 3D elements are admin-authored).
//
// GROUNDED THE SAME WAY suggestCraftGuide IS: the model may not invent a technique it cannot see.
// It is describing ONE object in a picture, not designing a cake.
//
// STEPS USE ROLE TOKENS, never literal colours — "{body}", "{mane}". The actual colours come from
// the order's design at render time, so ONE guide serves every colour variant of the same
// decoration. A guide that said "roll white fondant" would be wrong the first time a baker used
// their lion in brown.
// `focus` switches the reading mode. Absent, the image IS the decoration (a library element's
// thumbnail) and the model should ignore everything else in frame. Present, the image is a whole
// CAKE photo and `focus` names which decoration on it to read — the reference-photo case, where
// the decoration exists nowhere else. Naming the target matters more than it looks: given a cake
// photo and no focus, the model reliably describes the most prominent object, which on a busy
// cake is rarely the one the baker asked about.
// `dimension` — '2d' for a FLAT decoration (rolled out, cut to an outline, layered), '3d' for one
// modelled in the round. Without it the model reaches for 3D by default and describes sculpting a
// figurine: a real generation for a flat sticker came back "roll body into a large oval, pinch and
// extend one end to form a tail", which is a lovely fondant animal and not the decoration on the
// cake. The two crafts share almost no steps, so this is not a nuance — it is the difference
// between a usable guide and a wrong one.
export async function suggestBuildGuide({ imageUrl, name, description, focus = null, dimension = null }) {
  const prompt = `You are a master sugar-artist writing a build guide for ONE decoration, so another baker can make it by hand.

Decoration name: ${name || '(unnamed)'}
Keywords: ${description || '(none)'}

${focus
  ? `The image is a photo of a WHOLE CAKE. Read ONLY this one decoration on it: ${focus}.
Ignore every other decoration, the cake itself, the board and the background. If you cannot find
that decoration in the photo, return an EMPTY steps array and one tip saying so — do not describe
a different decoration instead.`
  : `Look ONLY at the object in the image. Do not describe a cake, a board, or a background.`}

${dimension === '2d'
  ? `THIS IS A FLAT, 2D DECORATION. It is cut from a rolled sheet of fondant and laid on the cake —
it is NOT modelled in the round.

FIRST, LIST EVERY DISTINCT PIECE. Look at the decoration and break it down completely — a palm tree
is a trunk, five leaves, five petals and a flower centre, not "a tree and a flower". A piece that is
repeated counts once but say how many are needed. A compound part (a flower) is broken into ITS
pieces (petals, centre), because each is cut separately.

CUTTING EACH SHAPE IS THE HARD PART AND MOST OF THE GUIDE. A baker does not need to be told how to
put finished pieces next to each other; they need to know how to GET each piece. So:
- Give EVERY distinct piece its own step covering how it is CUT: which colour sheet, what thickness,
  how many, and how the outline is made — freehand with a small knife, with a named cutter, or
  around a paper template traced from the printed shape.
- Do not merge two different shapes into one step to save space. Cutting a leaf and cutting a petal
  are different cuts and get different steps, even when both are green.
- Say how to get the shape RIGHT: cut a paper template first for anything with an outline that is
  hard to judge by eye, work from the widest part inwards, keep the blade upright so the edge is not
  bevelled.
- Only AFTER every piece exists may a step assemble them. Assembly is one or two steps at the end,
  never the body of the guide.
- A COMPOUND PART GETS ITS OWN ASSEMBLY STEP. Five petals and a centre become a flower in a step of
  their own, before the flower goes onto the decoration — a baker builds it in their hand, not on
  the cake, and a guide that jumps from loose petals to a finished piece has hidden the fiddly part.
- Detail is added as further FLAT pieces cut thin and laid on top, or tooled into the surface with a
  Dresden tool, veiner or toothpick — never as balls, cylinders or sculpted limbs.
- Finish with firming up flat, then attaching with water or edible glue.

NEVER say "roll into a ball", "form a cylinder", "attach the legs" or "blend the joints" — there are
no joints on a flat cut-out. A guide that starts from finished shapes and only assembles them has
missed the point entirely.`
  : dimension === '3d'
    ? `THIS IS A 3D DECORATION, modelled in the round from shaped pieces of fondant.`
    : ''}

ANY STEP THAT CHANGES A PIECE'S SHAPE MUST SAY HOW THE SHAPE IS MADE AND HOW IT IS HELD.
"Shape the loops", "form the petals", "curve the tail" are not instructions — they name the result
and hide the technique, which is the only part the baker could not have guessed. For every such
step say:
- the MOVEMENT: what is folded, over what, in which direction, how far, and where it is pinched or
  joined;
- what SUPPORTS it while it sets — a ball of rolled kitchen paper or cotton wool inside a loop, a
  former, a dowel, the edge of the bench — because a shape made in the hand collapses the moment it
  is put down;
- roughly how long it must be left before it holds itself, and whether it is attached before or
  after it firms.
A loop is the clearest case: cut the strip, bring the ends to the middle, pinch them together, and
PAD THE LOOP so it does not flatten while it dries. A guide that says "shape the bow loops" has
described a photograph, not a method.

Return ONLY valid JSON, no explanation:
{
  "title": "<short name of the thing being made>",
  "medium": "<fondant|gumpaste|modelling_chocolate|other>",
  "roles": ["<lowercase_token>", …],
  "colours": [{ "role": "<token>", "hex": "<hex you can SEE on this decoration>", "name": "<colour name>" }],
  "materials": [{ "role": "<token>", "label": "<what to prepare, e.g. 'fondant (head)'>" }],
  "parts":     [{ "name": "<part>", "note": "<which roles it uses, e.g. 'outer {body}, inner {inner_ear}'>" }],
  "steps": [
    { "n": 1, "title": "<short step title>",
      "instructions": ["<one imperative sentence>", …],
      "tools": ["<real modelling tool>", …] }
  ],
  "tips":     ["<short practical tip>", …],
  "set_time": "<how long it needs to firm up, e.g. '2–4 hours'>"
}

Rules:
- ROLE TOKENS, NEVER COLOUR NAMES. A role is a recolourable area of the object ("body", "mane",
  "inner_ear"). Write "{body}" inside instructions where the material goes. NEVER write "white
  fondant" or "pink" — the same decoration gets made in other colours, and a colour baked into the
  text would be wrong every other time.
- Steps in the order a hand actually works: bulk shapes first, fine detail and attachment last.
- 4 to 12 steps. Fewer, meatier steps beat many trivial ones.
- EVERY step lists the tools it needs in "tools" — the sheet prints them beside that step, and a
  step with an empty tools array reads as though it needs none. Tools must be real and namable
  (Rolling Pin, Craft Knife, Ball Tool, Dresden Tool, Veiner, Brush (Water), Fondant Smoother,
  Round Cutter, Paper Template).
- "colours" gives ONE hex per role, read off the image. This is the only place a colour may appear:
  the steps stay colour-free so the same guide serves the decoration in any colour, and the sheet
  prints the swatches beside them. Omit a role you cannot see clearly rather than guessing — the
  baker mixes gel paste from these, and a wrong hex wastes a batch.
- If the object is clearly NOT hand-modelled — a printed image, a flat decal, an acrylic topper —
  return "medium": "other", an EMPTY steps array, and one tip saying it looks printed or
  pre-made rather than modelled. Do not invent a modelling process for something nobody models.`;

  const payload = JSON.stringify({
    model: 'gpt-4o',
    max_tokens: 1600,
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
    throw new Error(`GPT-4o build-guide failed: ${text}`);
  }
  const data = await res.json();
  const raw  = data.choices[0].message.content.trim();
  const json = raw.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
  return { guide: JSON.parse(json), usage: data.usage ?? null, model: data.model ?? 'gpt-4o' };
}

// ── The stage grid: ONE image showing how a decoration is built ──────────────────────
// The visual half of a decoration guide (spattoo-docs plans/visual-decoration-guide.md, Phase 2).
//
// ONE image, not one per step. That is the whole design, and it is not only a cost decision:
// separate generations DRIFT — the object in panel 3 stops being the object in panel 7 — and a
// guide whose subject changes shape between steps is worse than one with no pictures at all. Drawn
// in a single pass, the stages are the same object by construction.
//
// NO TEXT IN THE IMAGE. Every word on the sheet is rendered by us. Image models are unreliable at
// letterforms and worst at exactly the strings that matter here: a misspelt step title is
// embarrassing, but a mangled hex sends a baker to mix the wrong colour and waste a batch. We
// already have the steps, the colours and a real gel recipe — this supplies only what we cannot
// draw ourselves.
//
// An EDIT rather than a generation, for the same reason generateDecorationImage is: the crop from
// the customer's photo is the ground truth, and input_fidelity high is the difference between
// showing how to build THIS bow and inventing a stock one.
//
// Returns { buffer, usage, model } — usage so the ledger can record what the call actually cost,
// which is what settles whether this fits inside the existing price.
// `steps` — the guide's OWN steps, in order. Without them the model is told only "show this being
// built" and invents its own progression, which is always empty -> partial -> complete: an
// ASSEMBLY story. So a guide whose words said "cut the trunk / cut the leaves / cut the flowers"
// came back as pictures of a palm being put together, and every caption sat under the wrong image.
// The panels have to depict the steps, which means being given them.
// ── The guide sheet: ONE image, one call, the whole thing ────────────────────────────
// A complete step-by-step sheet — panels, numbers, captions, all of it — the way a baker would
// share one. Not a grid we slice, not one image per step. One request, one picture.
//
// AN EARLIER VERSION SPLIT THIS UP: pictures from the model, words rendered by us, panels framed
// out of a derived grid with CSS. It failed, and it was always going to. A generative image model
// does not return an exact N-panel grid at exact positions, so every cell landed across panel
// boundaries — and no amount of prompt wording makes that deterministic. The split also existed to
// dodge a risk (a misspelt hex sending a baker to mix the wrong colour) that was already handled:
// the colours are rendered separately from our own gel table and never read off this image.
//
// The model IS given the guide's own steps, so the sheet illustrates this guide rather than
// inventing its own sequence. How many panels that needs is its business, not ours.
// `quality` overrides the configured default for ONE call. Admin-only in practice: a catalogue
// guide that came out unreadable at low can be rebuilt higher without changing the default for
// every baker. Validated by the caller — an unrecognised value would be rejected by the provider,
// and worse, would be recorded at the wrong price.
export async function generateDecorationStages(referenceBuffer, { title, steps = [], size = '1024x1536', dimension = null, quality = null } = {}) {
  const imageQuality = quality || config.openai.guideImageQuality;
  const readable = (t) => String(t ?? '').replace(/\{(\w+)\}/g, (_, r) => r.replace(/_/g, ' '));
  const stepList = (steps ?? []).map((st, i) => {
    const lines = (st?.instructions ?? []).map(readable).join(' ');
    const tools = (st?.tools ?? []).join(', ');
    return `${i + 1}. ${readable(st?.title ?? '')} — ${lines}${tools ? ` [tools: ${tools}]` : ''}`;
  }).join('\n');

  const flat = dimension === '2d';
  const form = new FormData();
  form.append('model', config.openai.imageModel);
  form.append('image', new Blob([referenceBuffer], { type: 'image/png' }), 'reference.png');
  form.append('prompt',
    `Create a complete step-by-step tutorial sheet showing how to make the fondant decoration in ` +
    `the reference image${title ? ` — "${title}"` : ''}. The kind of illustrated guide a cake ` +
    `decorator would print and follow at the bench.\n\n` +
    (flat
      ? `THE DECORATION IS FLAT — cut from a rolled sheet of fondant like a cookie, NOT modelled in ` +
        `the round. Every panel shows it lying flat on the work surface, photographed from directly ` +
        `above. It must never stand up or look three-dimensional.\n\n` +
        `SHOW THE CUTTING. That is the part a baker cannot work out alone: the blade or cutter ` +
        `following the outline, the piece still in the sheet, the waste fondant around it. A sheet ` +
        `that jumps from rolled fondant to finished shapes has skipped everything that mattered.\n\n`
      : '') +
    `Follow THESE steps, in this order — ONE PANEL EACH:\n${stepList}\n\n` +
    `EVERY STEP GETS ITS OWN PANEL. Do not merge two steps into one picture, do not skip a step ` +
    `because its piece is small, and do not let a step appear only as an object lying in the ` +
    `background of another panel. A step with no panel of its own is a step the baker cannot see.\n\n` +
    // The palm's flower kept losing: five petals and a centre reduced to a few specks beside a
    // trunk, because the model kept every panel at the whole decoration's scale.
    `ZOOM IN FOR SMALL PIECES. A petal, an eye or a spot must FILL its panel — shown at the scale ` +
    `it needs to be understood, not at the scale of the finished decoration. A small part rendered ` +
    `tiny in the corner of its own panel teaches nothing. Close up on the hands and the piece being ` +
    `worked.\n\n` +
    `SHOW THE WHOLE OF EACH STEP. If a step cuts five petals, show five petals being cut and laid ` +
    `out. If it assembles a flower, show the petals going together into the flower. The picture ` +
    `should carry the step on its own, so a baker who reads nothing still knows what to do.\n\n` +
    `LAYOUT: a clean grid of panels, one per step, in reading order — left to right, then down. ` +
    `The finished decoration is the last panel. Use as many panels as the steps need. White ` +
    `background, soft even lighting, photorealistic, shot straight down.\n\n` +
    // ── NO WORDS, NO NUMBERS ─────────────────────────────────────────────────────────
    // Asked twice for numbered panels with captions; got 1, 2, 2, 3 both times, and captions that
    // degraded into "Fold a strip into out to / loop side by gbe pure with pinck we" the harder we
    // pushed for the step's exact wording. Image models garble text — that is the medium, not a
    // phrasing problem, and a third rewording would have been the third attempt at the same wrong
    // premise.
    //
    // So we ask for what the model is genuinely good at and take back what it is not. Every word a
    // baker reads — the step titles, the instructions, the order — is rendered by us from the same
    // `steps` array used above, correctly spelled, correctly numbered, translatable and readable
    // aloud. On screen and in the PDF the two sit together, so nothing is lost by the sheet being
    // silent.
    //
    // A misnumbered sheet is worse than an unnumbered one: the baker stops trusting the order and
    // re-derives it from the pictures, which is what the numbers were supposed to save them.
    `NO TEXT ANYWHERE IN THE IMAGE. No numbers, no captions, no labels, no title, no arrows with ` +
    `words, no writing on the work surface or in the background. The panels tell the story through ` +
    `the pictures alone, in order. Text is printed beside this sheet, not on it.\n\n` +
    `Because there are no captions, EACH PANEL MUST BE SELF-EXPLANATORY: the hands, the tool and ` +
    `the piece must make the action unmistakable on their own — mid-fold, mid-cut, mid-pinch, ` +
    `rather than the tidy result of a step already finished.`);
  form.append('size', size);
  form.append('quality', imageQuality);
  form.append('output_format', 'webp');
  form.append('input_fidelity', 'high');
  form.append('n', '1');

  const res = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.openai.apiKey}` },
    body: form,
  });

  if (!res.ok) throw new Error(`${config.openai.imageModel} stages failed: ${await res.text()}`);
  const data = await res.json();
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${config.openai.imageModel} returned no image data`);
  return {
    buffer: Buffer.from(b64, 'base64'),
    // WHAT WE ASKED FOR, not what came back. Images are billed per image by quality and shape, and
    // /v1/images/edits does not reliably return a usage block — relying on one meant the call
    // recorded NOTHING and a guide costing ~R6.5 was logged at ~R1. The request parameters are
    // known for certain, so the cost is computed from those (services/aiCredits.js imageCostInr).
    // The quality ACTUALLY used, not the configured default — a rebuild at medium costs four
    // times a low one, and the ledger has to say so or the margin figure is fiction.
    image:  { quality: imageQuality, size, n: 1 },
    // Kept when the provider does return it — useful for reconciling against the real invoice,
    // and harmless: imageCostInr takes precedence for an image call.
    usage:  data?.usage ?? null,
    model:  config.openai.imageModel,
  };
}
