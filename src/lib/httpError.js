import { logError } from './telemetry.js';

// SEC-9 — shared 500 responder for route-level catch blocks and inline Supabase-error returns.
// Mirrors the central errorHandler (middleware/errorHandler.js): reports to telemetry, then returns
// a clean, NON-leaky body carrying the request id for support correlation — never the raw
// Postgres/Supabase message (which exposes constraint/column/internal detail).
//
// Routes keep their existing `(req, res)` signature (no `next` needed). Use ONLY for 5xx/internal
// failures; KEEP 4xx validation messages as-is (those are safe and useful to the caller).
export function serverError(req, res, err) {
  logError(err, req);
  return res.status(500).json({ error: 'Internal server error', request_id: req?.id });
}
