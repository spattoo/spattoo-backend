import { config } from '../config.js';

// SEC-8 — CORS origin allowlist. Only our own web origins may script the API from a browser,
// replacing the wide-open `cors()` that reflected `*`.
//
// O(1) in tenants: every storefront subdomain ({slug}.<base>) + the app/marketing hosts match ONE
// base-domain rule — NEVER a per-baker list. Requests with NO Origin header (server-to-server, curl,
// same-origin, native webviews) are allowed: CORS only governs cross-origin BROWSER requests, and a
// browser always sets Origin honestly, so this can't be spoofed by a malicious site.
//
// (Future: baker-owned custom domains — deferred — will need a dynamic check against verified
// domains in the DB; add it here as another branch, not as a wildcard.)
export function isAllowedOrigin(origin, cors = config.cors) {
  if (!origin) return true;                                  // non-browser / same-origin
  let url;
  try { url = new URL(origin); } catch { return false; }
  const host = url.hostname;

  // Local dev (http, any port) — bare localhost/127.0.0.1 AND *.localhost subdomain storefronts
  // (the `{slug}.localhost:5173` model). Gated by env so prod can turn it off.
  if (cors.allowLocalhost && (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost'))) return true;
  if (cors.extraOrigins.includes(origin)) return true;

  // Real origins must be https and inside the base domain — apex OR any subdomain. The leading dot in
  // `.${base}` prevents suffix spoofing (e.g. `evil-spattoo.com` / `spattoo.com.attacker.com`).
  if (url.protocol !== 'https:') return false;
  return host === cors.baseDomain || host.endsWith(`.${cors.baseDomain}`);
}

// Options object for the `cors` middleware. Returning `false` (not an Error) means "no CORS headers"
// → the browser blocks the cross-origin read, without turning the request into a 500.
export function corsOptions(cors = config.cors) {
  return { origin: (origin, cb) => cb(null, isAllowedOrigin(origin, cors)) };
}
