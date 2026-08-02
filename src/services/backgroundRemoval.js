import { config } from '../config.js';
import { captureError } from '../lib/telemetry.js';
import { removeBackground as removeBgVendor } from './removebg.js';
import {
  failureKind, freshBreaker, breakerOpen, afterFailure, afterSuccess,
  freshCap, capReached, afterFallback,
} from './bgFallbackPolicy.js';

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
  // Paid vendor. Metered per image — the thing we intend to stop paying. It reports no confidence
  // of its own, and null means "unknown" rather than "fine".
  removebg: async (buffer) => ({ png: await removeBgVendor(buffer), confidence: null, doubts: null }),

  // Our own model (silueta), on its OWN Render service — repo: spattoo-bgremover, built 2026-07-12
  // (features/my-decorations.md). This comment said "not built yet" for three weeks after it was;
  // the swap is env-only and has been all along. It is separate
  // because we measured it: >300 MB resident, and loading it in THIS process OOM-killed the API. A
  // private service, so it has no public hostname; the shared token is defence in depth on top.
  self: async (buffer) => {
    const { serviceUrl, serviceToken, timeoutMs } = config.bgRemoval;
    if (!serviceUrl) throw new Error('BG_REMOVAL_PROVIDER=self but BG_REMOVAL_SERVICE_URL is not set');
    let res;
    try {
      res = await fetch(`${serviceUrl}/cutout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(serviceToken ? { Authorization: `Bearer ${serviceToken}` } : {}),
        },
        body: buffer,
        // A HUNG service is worse than a dead one: without a deadline the request waits until the
        // platform kills it, the baker watches a spinner for a minute, and the fallback below never
        // gets to fire because nothing ever failed.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // No HTTP response at all — refused, DNS, socket hang-up, or our own timeout. `status: null`
      // is what failureKind() reads as "the service is unavailable".
      throw Object.assign(new Error(`bg-removal service unreachable: ${err.name}: ${err.message}`), { status: null });
    }
    if (!res.ok) {
      throw Object.assign(
        new Error(`bg-removal service failed: ${res.status} ${await res.text().catch(() => '')}`),
        { status: res.status },
      );
    }
    // How much the service trusts its own mask (X-Cutout-*). PHASE 1: we record it and act on
    // nothing. The thresholds behind `low` were drawn from eight test images and one synthetic
    // failure, so wiring a paid retry to them now would be guessing with a budget. Log first, watch
    // what real uploads actually look like, then decide.
    //
    // Absent headers mean an older service, and confidence stays null rather than defaulting to
    // 'high' — not knowing is not the same as being sure.
    return {
      png:        Buffer.from(await res.arrayBuffer()),
      confidence: res.headers.get('x-cutout-confidence') || null,
      doubts:     res.headers.get('x-cutout-doubts') || null,
    };
  },
};

// ── Availability fallback ────────────────────────────────────────────────────────────────────────
// If OUR service cannot answer, remove.bg answers instead. This is not the same thing as the
// quality fallback (a baker pressing "try harder" and knowingly spending credits): nobody chose
// this, there is no result to judge, and the outage is ours. So it is automatic, it is capped, and
// the baker is NOT charged — cutOutSubject reports `fellBack`, and the metered route releases the
// hold on it.
//
// Every rule about when it fires lives in bgFallbackPolicy.js, pure and gated.
//
// Process-local state. A breaker per instance is the right scope: it is tracking whether THIS
// process can reach the service, and Render's instances fail independently.
let breaker = freshBreaker();
let dailyCap = freshCap();

// Exported for the gate and for tests — a module that remembers an outage across cases is a module
// whose second test depends on its first.
export function _resetFallbackState() {
  breaker = freshBreaker();
  dailyCap = freshCap();
}

async function fallbackToVendor(buffer, reason, cause) {
  const now = Date.now();

  // ALERT ON EVERY FALLBACK, loudly. The danger of a fallback that works is that it hides the thing
  // it is compensating for: the storefront looks fine, nobody investigates, and we quietly pay a
  // per-image fee for days. This is the only signal that our own service is down.
  captureError(cause ?? new Error(`bg-removal fell back to remove.bg (${reason})`), {
    action: 'bgRemoval.fallback', severity: 'error',
    extra: { reason, consecutiveFailures: breaker.consecutiveFailures, fallbacksToday: dailyCap.used },
  });

  if (!config.bgRemoval.fallbackToVendor) throw cause ?? new Error(`bg-removal unavailable (${reason})`);
  // A fallback nobody funded is decorative. Easy to reach once the flip to `self` makes the vendor
  // account look unused and someone lets it lapse — so say which of the two things is wrong.
  if (!config.removeBg.apiKey) {
    throw Object.assign(new Error(`bg-removal unavailable (${reason}) and REMOVE_BG_API_KEY is not set`),
      { cause });
  }
  if (capReached(dailyCap, now, config.bgRemoval.fallbackDailyCap)) {
    throw Object.assign(
      new Error(`bg-removal unavailable (${reason}) and the daily vendor fallback cap (${config.bgRemoval.fallbackDailyCap}) is spent`),
      { cause },
    );
  }

  dailyCap = afterFallback(dailyCap, now);
  // Same shape every provider returns. The vendor reports no confidence of its own, and null means
  // "unknown" rather than "fine".
  return { png: await removeBgVendor(buffer), confidence: null, doubts: null };
}

// Remove the background from image bytes.
//
// Returns { png, provider, fellBack, reason, confidence, doubts } — not a bare Buffer.
//
// `provider` is the one that ACTUALLY served, which the credit ledger stamps on the debit: reporting
// the configured provider while the vendor did the work would put a free image and a ₹15 one in the
// same bucket and make the margin dashboard confidently wrong.
//
// `confidence` is 'high' | 'low' | null — how much our own service trusted its mask, or null when
// nothing said (the vendor served, or an older service answered). Recorded, not acted on: see the
// note in the `self` provider.
export async function cutOutSubject(buffer) {
  const name = config.bgRemoval.provider;
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`unknown BG_REMOVAL_PROVIDER "${name}"`);

  // Configured straight at the vendor: there is nothing to fall back TO.
  if (name !== 'self') return { ...(await provider(buffer)), provider: name, fellBack: false, reason: null };

  const now = Date.now();
  if (breakerOpen(breaker, now)) {
    return { ...(await fallbackToVendor(buffer, 'breaker-open', null)), provider: 'removebg', fellBack: true, reason: 'breaker-open' };
  }

  try {
    const served = await provider(buffer);
    breaker = afterSuccess();
    return { ...served, provider: 'self', fellBack: false, reason: null };
  } catch (err) {
    // A 4xx is a verdict on the BYTES, and the vendor would reach the same verdict — for ~₹15.
    // Fail for free instead.
    if (failureKind(err.status) === 'request') throw err;

    breaker = afterFailure(breaker, now);
    const reason = err.status == null ? 'unreachable' : `http-${err.status}`;
    return { ...(await fallbackToVendor(buffer, reason, err)), provider: 'removebg', fellBack: true, reason };
  }
}
