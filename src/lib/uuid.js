// ── One UUID pattern ─────────────────────────────────────────────────────────────────────────────
//
// The same regex was written out in three files — lib/assetKeys.js, routes/designSessions.js and
// routes/orderLink.js — and a fourth was about to be typed for the order-channel lookup. Each is a
// shape check standing in front of a database call, so a copy that drifts does not fail loudly: it
// lets a malformed id through to a query, or rejects a real one.
//
// Canonical here. The two older copies outside the order-link feature are left alone deliberately —
// they work, and rewriting them is a separate change with its own risk — but nothing new should add
// a fifth.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this the shape of a UUID? Cheap, and worth asking before any lookup by id. */
export const isUuid = (v) => UUID_RE.test(String(v ?? ''));
