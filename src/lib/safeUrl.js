// SEC-16 — normalize a stored, user-controlled web URL at the WRITE-POINT (defense-in-depth behind
// the front-end `safeHref` render guard). Only absolute http(s) URLs are kept; anything else —
// `javascript:`/`data:`/`vbscript:` schemes, relative or malformed strings, empty — becomes null so a
// dangerous-scheme URL can never be persisted (and thus can't reach an href even if a future render
// site forgets to sanitise). Mirror of spattoo-core `storefrontKit.js → safeHref`; the two runtimes
// can't share one module, so keep them in sync.
export function normalizeWebUrl(url) {
  if (typeof url !== 'string') return null;
  const v = url.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') ? v : null;
  } catch {
    return null;
  }
}
