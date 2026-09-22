import { logError } from './telemetry.js';

// SEC-9 — shared 500 responder for route-level catch blocks and inline Supabase-error returns.
// Mirrors the central errorHandler (middleware/errorHandler.js): reports to telemetry, then returns
// a clean, NON-leaky body carrying the request id for support correlation — never the raw
// Postgres/Supabase message (which exposes constraint/column/internal detail).
//
// Routes keep their existing `(req, res)` signature (no `next` needed). Use ONLY for 5xx/internal
// failures; KEEP 4xx validation messages as-is (those are safe and useful to the caller).
export function serverError(req, res, err) {
  /* ⚠️ AN EXPECTED OPERATING CONDITION IS NOT A 500, AND MUST NOT PAGE SENTRY. The first of these
     is the provider running out of credit: on 2026-09-22 the OpenAI balance reached $0 and an admin
     pressing "Generate guide" was told "Internal server error" while Sentry raised it as a defect.
     Nothing was broken. The remedy was a top-up, and the screen said nothing that would lead anyone
     there.
     A carried `status` and `expected: true` (see lib/providerQuota.js) says the thrower already
     knows what this is: answer with its own message and status, and do not report it. Alerts that
     fire on known, recoverable states are alerts people learn to close unread. */
  if (err?.expected && err?.status) {
    return res.status(err.status).json({
      error: err.message,
      code: err.code ?? null,
      request_id: req?.id,
    });
  }
  logError(err, req);
  return res.status(500).json({ error: 'Internal server error', request_id: req?.id });
}
