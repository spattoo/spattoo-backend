// ── When a failed cut-out becomes remove.bg's problem ────────────────────────────────────────────
// The decision only, with NO IMPORTS — no fetch, no config, no clock. Same reason creditAlerts.js and
// decorationPolicy.js are pure: this is the part with the interesting rules, and every one of them is
// a rule about SPENDING MONEY. It should be assertable without booting the application or being down.
// See scripts/check-bg-fallback.mjs.
//
// The rules exist because a fallback to a metered vendor is the one kind of error handling that can
// quietly cost more than the failure did.

// ── Whose fault was it? ──────────────────────────────────────────────────────────────────────────
// 'outage'  — OURS. Unreachable, timed out, or 5xx. remove.bg can answer instead, and the baker must
//             not be charged: they asked for the cheap path and we are the ones who could not serve it.
// 'request' — THEIRS. Any other 4xx: the bytes are the problem (too large, not an image, empty). The
//             vendor would fail on the same bytes, so falling back means paying ~₹15 to fail. Don't.
//
// `status` is null when there was no HTTP response at all — DNS, refused connection, socket hang-up,
// or our own timeout firing. All of those are the service being unavailable.
export function failureKind(status) {
  if (status == null) return 'outage';
  if (status >= 500) return 'outage';
  // 408/429 come back as a transient "try later" rather than a verdict on the bytes. Our own service
  // sends neither today, but a proxy or platform edge in front of it can, and treating those as the
  // caller's fault would refuse to fall back exactly when falling back is the point.
  if (status === 408 || status === 429) return 'outage';
  return 'request';
}

// ── Circuit breaker ──────────────────────────────────────────────────────────────────────────────
// Without one, every upload during an outage waits out the full timeout before falling back — so a
// dead service does not just stop working, it makes the whole feature slow for everyone. After a few
// consecutive failures we stop asking for a minute and go straight to the vendor.
//
// Deliberately consecutive, not a rate: one failure among many successes is a bad image or a blip,
// and tripping on that would send healthy traffic to a paid vendor.
export const BREAKER_TRIP_AFTER  = 3;
export const BREAKER_COOLDOWN_MS = 60_000;

export function freshBreaker() {
  return { consecutiveFailures: 0, openedAt: null };
}

export function breakerOpen(breaker, now, cooldownMs = BREAKER_COOLDOWN_MS) {
  if (breaker.openedAt == null) return false;
  return now - breaker.openedAt < cooldownMs;
}

export function afterFailure(breaker, now, tripAfter = BREAKER_TRIP_AFTER) {
  const consecutiveFailures = breaker.consecutiveFailures + 1;
  return {
    consecutiveFailures,
    openedAt: consecutiveFailures >= tripAfter ? now : breaker.openedAt,
  };
}

// One success closes it completely. A half-open probe that succeeded means the service is back, and
// keeping a partial failure count would re-trip it on the next unrelated blip.
export function afterSuccess() {
  return freshBreaker();
}

// ── Daily spend ceiling ──────────────────────────────────────────────────────────────────────────
// An outage is bounded by how long we take to fix it, which at 3am is "hours". Uncapped, this is a
// mechanism that converts our downtime into a vendor invoice at ~₹15 an image, and nobody finds out
// until the bill. Past the ceiling we stop falling back and let the cut-out fail — the upload studio
// already handles that by letting the baker save the image as-is, which is a worse decoration but not
// a worse day than an unbounded charge.
//
// Days are IST, matching istMonthStart() in creditAlerts.js: the cap is a business decision about
// money, and it should roll over at midnight where the business is, not in UTC.
export const DEFAULT_DAILY_CAP = 200;

export function freshCap() {
  return { day: null, used: 0 };
}

export function istDayKey(now) {
  return new Date(now + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function capReached(cap, now, limit = DEFAULT_DAILY_CAP) {
  if (limit <= 0) return true;                       // 0 disables the fallback entirely
  if (cap.day !== istDayKey(now)) return false;      // new day, counter is stale
  return cap.used >= limit;
}

export function afterFallback(cap, now) {
  const day = istDayKey(now);
  return { day, used: cap.day === day ? cap.used + 1 : 1 };
}
