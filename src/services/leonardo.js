import { config } from '../config.js';

// ── Leonardo.Ai: where the remove.bg API went ───────────────────────────────────────────────────
//
// remove.bg's self-service API STOPS ACCEPTING REQUESTS ON 1 DECEMBER 2026, 09:00 CET. The web tool
// moved into Canva; the API moved here, to Leonardo.Ai — also Canva-owned, and a different product
// with a different account, a different key and a different wire format. Keys do not carry over.
//
// ⚠️ CANVA'S OWN API IS NOT THE ANSWER, though it is the obvious guess once you read "moving to
// Canva". It does have background removal (POST /rest/v1/image-transformations), but: it is a
// PREVIEW api whose docs say public apps using it "will not pass the review process"; it needs an
// OAuth token ACTING ON BEHALF OF A USER rather than a service key, so one human's Canva account
// would be authorising every baker's upload; it spends THAT USER's monthly AI credit allowance and
// 429s at the limit; it is capped at 20 requests a minute per user; and the result is a Canva
// ASSET, which the REST API offers no way to download — you would create a design around it and
// export that, polling twice. Checked 2026-10-18 against Canva's published docs.
//
// Shape confirmed against Leonardo's own migration guide (their Node example, not a summary of it):
// one synchronous POST, JSON in, JSON out, no polling. Priced per image, ~$0.1047 at the time of
// writing, and the real figure comes back in `cost` on every response — see costUsd below.
const SYNC_URL = 'https://cloud.leonardo.ai/api/rest/v2/generationssync';

// Their input limit is 25MB for base64; the ~7.45MB figure in their docs is about base64 OUTPUT,
// which is why we do not ask for it (see below). Ours is lower on purpose: our own routes cap the
// upload at 10MB, and base64 inflates by a third, so anything past this never came from us.
const MAX_INPUT_BYTES = 10 * 1024 * 1024;

export function leonardoConfigured() {
  return !!config.leonardo?.apiKey;
}

/**
 * Remove the background from image bytes. Returns `{ png, costUsd }`.
 *
 * @param {Buffer|Uint8Array} imageInput  raw image bytes
 * @throws on any provider failure, with `status` set so the fallback policy can tell OUR outage
 *         from a verdict on the bytes (see services/bgFallbackPolicy.js).
 */
export async function removeBackground(imageInput) {
  if (!config.leonardo?.apiKey) {
    throw new Error('LEONARDO_API_KEY is not set — create one at app.leonardo.ai → API Access');
  }
  const bytes = Buffer.isBuffer(imageInput) ? imageInput : Buffer.from(imageInput);
  if (bytes.length > MAX_INPUT_BYTES) {
    // A 413 from them costs a round trip and reads as an outage to the breaker. Refuse it here,
    // as a verdict on the bytes, which is what it is.
    throw Object.assign(new Error(`image is ${(bytes.length / 1048576).toFixed(1)}MB; the limit is 10MB`), { status: 400 });
  }

  let res;
  try {
    res = await fetch(SYNC_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.leonardo.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: 'remove-bg',
        // ⚠️ WITHOUT THIS, EVERY CUSTOMER'S PHOTO IS SAVED TO OUR LEONARDO LIBRARY. Their default
        // is to keep results; remove.bg kept nothing, and keeping nothing is what we promised the
        // people uploading pictures of their own kitchens.
        ephemeral: true,
        public: false,
        parameters: {
          // png, explicitly: the whole point is the alpha channel, and `auto` could answer jpg.
          format: 'png',
          size: 'auto',
          guidances: { image_reference: [{ image: { type: 'BASE64', data: bytes.toString('base64') } }] },
        },
        // ⚠️ NOT `base64: true`, DELIBERATELY. Inline output is capped at ~7.45MB OF PIXELS — a
        // 2048² cut-out is 16MB decoded and the call simply fails. The URL has no such cap, and it
        // costs one extra GET of a link that expires anyway.
      }),
      signal: AbortSignal.timeout(config.leonardo.timeoutMs),
    });
  } catch (err) {
    // No HTTP response: refused, DNS, socket hang-up, or our own deadline. `status: null` is what
    // failureKind() reads as "unavailable" — the case where falling back is right.
    throw Object.assign(new Error(`leonardo unreachable: ${err.name}: ${err.message}`), { status: null });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // ⚠️ Never log the request: it carries the key AND the whole image as base64.
    throw Object.assign(new Error(`leonardo failed: ${res.status} ${body.slice(0, 300)}`), { status: res.status });
  }

  const parsed = await res.json().catch(() => null);
  const url = parsed?.results?.[0]?.url;
  if (!url) {
    // A 200 with nothing in it is still a failure, and it is OURS to notice: their `blockedCount`
    // reports images their safety filter refused, which is a verdict on the bytes rather than an
    // outage — falling back to another vendor for it would pay twice for the same answer.
    const blocked = Number(parsed?.blockedCount) > 0;
    throw Object.assign(
      new Error(blocked
        ? 'leonardo refused the image (blocked by their content filter)'
        : `leonardo returned no result: ${JSON.stringify(parsed).slice(0, 300)}`),
      { status: blocked ? 422 : 502 },
    );
  }

  const img = await fetch(url, { signal: AbortSignal.timeout(config.leonardo.timeoutMs) })
    .catch(err => { throw Object.assign(new Error(`leonardo result fetch failed: ${err.message}`), { status: null }); });
  if (!img.ok) {
    throw Object.assign(new Error(`leonardo result fetch failed: ${img.status}`), { status: img.status });
  }

  return {
    png: Buffer.from(await img.arrayBuffer()),
    // What this image ACTUALLY cost, from their response rather than from a price we remember. It
    // is in dollars; nothing here converts it, because an exchange rate written in code is a number
    // that is wrong by a little every day and nobody is watching.
    costUsd: parsed?.cost?.amount != null ? Number(parsed.cost.amount) : null,
  };
}
