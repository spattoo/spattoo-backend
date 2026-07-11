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
// It is NOT self-hosted yet, deliberately: silueta needs >300 MB RSS natively, and loading it inside
// this API took the dev service down with an OOM. It belongs in its OWN Render service — inference has
// a spiky, unbounded memory profile and must never be able to kill request handling. Until that
// service exists, we ship on the vendor so the FLOW can be built and tested end-to-end, and flip the
// env var when the service is up.
//
// See features/my-decorations.md for the measurements.

const PROVIDERS = {
  // Paid vendor. Metered per image — the thing we intend to stop paying.
  removebg: async (buffer) => removeBgVendor(buffer),

  // Our own model, on its own service. Not built yet; the shape is here so the swap is a one-liner
  // and so nobody is tempted to sprinkle a second remove.bg call somewhere else in the meantime.
  self: async (buffer) => {
    if (!config.bgRemoval.serviceUrl) {
      throw new Error('BG_REMOVAL_PROVIDER=self but BG_REMOVAL_SERVICE_URL is not set');
    }
    const res = await fetch(`${config.bgRemoval.serviceUrl}/cutout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
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
