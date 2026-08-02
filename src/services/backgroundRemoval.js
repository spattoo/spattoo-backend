import { config } from '../config.js';
import { removeBackground as removeBgVendor } from './removebg.js';

// ── Background removal: ONE chokepoint, swappable provider ───────────────────────────────────────
//
// Every caller goes through cutOutSubject(). The provider is DATA (BG_REMOVAL_PROVIDER), so switching
// from the paid vendor to our own model is a config change on Render, not a code change — and can be
// done per-environment, or rolled back instantly if the self-hosted service misbehaves.
//
// WHY THIS EXISTS RATHER THAN CALLING remove.bg DIRECTLY:
//
// remove.bg is metered (~₹15/image at low volume). "My Decorations" puts an upload button in front of
// every baker AND every customer, so the call volume is user-driven and unbounded — exactly the shape
// that turns a per-image fee into a surprise. We measured the alternative: our own model (silueta,
// 42 MB, 320²) matches the masks we need on real decorations and costs nothing per image. Break-even
// against remove.bg is roughly 100-150 images/month, which this feature will pass immediately.
//
// The service EXISTS (spattoo-bgremover, 2026-07-12). What has not happened is deploying it and
// setting three env vars — BG_REMOVAL_PROVIDER=self, BG_REMOVAL_SERVICE_URL, BG_REMOVAL_SERVICE_TOKEN.
// Until that flip, every cut-out costs ~₹15, which is why the baker-facing route is metered at 15
// credits (migration 036). The flip is what makes that price wrong: our own model costs nothing per
// image, so the credit price should fall to 1-2 — or the action stop being metered at all.
//
// It is a separate service and not an import because silueta needs >300 MB RSS, and loading it inside
// this API OOM-killed the dev box. Inference has a spiky, unbounded memory profile; request handling
// has a tight one. Sharing a process means one upload can take the storefront down.
//
// See features/my-decorations.md for the measurements.

const PROVIDERS = {
  // Paid vendor. Metered per image — the thing we intend to stop paying.
  removebg: async (buffer) => removeBgVendor(buffer),

  // Our own model (silueta), on its OWN Render service — repo: spattoo-bgremover, built 2026-07-12
  // (features/my-decorations.md). This comment said "not built yet" for three weeks after it was;
  // the swap is env-only and has been all along. It is separate
  // because we measured it: >300 MB resident, and loading it in THIS process OOM-killed the API. A
  // private service, so it has no public hostname; the shared token is defence in depth on top.
  self: async (buffer) => {
    const { serviceUrl, serviceToken } = config.bgRemoval;
    if (!serviceUrl) throw new Error('BG_REMOVAL_PROVIDER=self but BG_REMOVAL_SERVICE_URL is not set');
    const res = await fetch(`${serviceUrl}/cutout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
      },
      body: buffer,
    });
    if (!res.ok) throw new Error(`bg-removal service failed: ${res.status} ${await res.text()}`);
    return Buffer.from(await res.arrayBuffer());
  },
};

// Remove the background from image bytes. Returns a transparent PNG Buffer.
export async function cutOutSubject(buffer) {
  const provider = PROVIDERS[config.bgRemoval.provider];
  if (!provider) throw new Error(`unknown BG_REMOVAL_PROVIDER "${config.bgRemoval.provider}"`);
  return provider(buffer);
}
