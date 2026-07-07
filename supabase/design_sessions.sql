-- ── design_sessions ────────────────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- A design session is a LIVE co-design room: a baker and/or customer edit one cake
-- design together in real time (one "pen"/edit baton at a time), with an optional
-- read-only spectator (Phase 2). It is an EVENT (a baker/customer can start many),
-- so it is its own table — not a column on orders or bakers.
--
-- Transport is Supabase Realtime (Broadcast + Presence) on the channel
-- `session:<id>` — the row `id` IS the channel + join-link reference. This table is
-- the DURABLE source of truth the realtime layer rides on: who holds the pen
-- (editor_user_id), the last-persisted design (design_snapshot, to hydrate late
-- joiners and persist on end), and the lifecycle (status_id).
--
-- Scale: this is a HIGH-VOLUME table (grows with every session across all bakers),
-- room-scoped, O(active sessions) — never per-tenant. So its status reference is a
-- compact smallint surrogate FK to the design_session_statuses lookup (NOT a text
-- key on every row), and the hot access pattern (baker_id, status_id) is indexed.
-- See CLAUDE.md "PERSISTED SCHEMA IS FOREVER — model the hot table".

-- ── 1. design_session_statuses (bounded lookup; the readable key lives here) ─────
CREATE TABLE IF NOT EXISTS design_session_statuses (
  id    smallint PRIMARY KEY,          -- compact surrogate stored on the hot table
  key   text NOT NULL UNIQUE,          -- readable natural key; callers speak this, never the int
  label text NOT NULL
);

INSERT INTO design_session_statuses (id, key, label) VALUES
  (1, 'active',  'Active'),            -- room is live
  (2, 'ended',   'Ended'),             -- finished / closed by a participant
  (3, 'expired', 'Expired')            -- timed out (past expires_at); swept, not deleted
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label;

-- ── 2. design_sessions (the hot table) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS design_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- also the channel + link ref: session:<id>
  baker_id        uuid NOT NULL REFERENCES bakers(id)    ON DELETE CASCADE,   -- denormalized (immutable) for tenancy/RLS
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,           -- the invited customer (NULL for a baker-solo start)
  order_id        uuid REFERENCES orders(id)    ON DELETE SET NULL,           -- set when the session is finalizing an existing order
  status_id       smallint NOT NULL DEFAULT 1 REFERENCES design_session_statuses(id),  -- active|ended|expired (surrogate FK)
  host_user_id    uuid NOT NULL,                     -- auth.users id of whoever started the session (no FK: auth schema)
  editor_user_id  uuid,                              -- auth.users id currently holding the pen (NULL = nobody is editing)
  design_snapshot jsonb,                             -- last-persisted live design (hydrate late joiners; persist on end)
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_active_at  timestamptz NOT NULL DEFAULT now(),-- bumped on each design persist; drives idle expiry
  ended_at        timestamptz,
  expires_at      timestamptz                        -- hard stop; a repeatable job marks status_id=expired (never an in-proc timer)
);

CREATE INDEX IF NOT EXISTS design_sessions_baker_status_idx ON design_sessions (baker_id, status_id);  -- hot access pattern
CREATE INDEX IF NOT EXISTS design_sessions_customer_idx     ON design_sessions (customer_id);
CREATE INDEX IF NOT EXISTS design_sessions_order_idx        ON design_sessions (order_id);

-- ── 3. Realtime Authorization (RLS on the broadcast channel) ─────────────────────
-- OPTIONAL / apply when wiring Phase 1 realtime. Supabase Realtime Authorization gates
-- who may read/send on channel `session:<id>` by running RLS on realtime.messages with
-- the connecting user's JWT. This makes channel MEMBERSHIP cryptographic — only a staff
-- member of the session's baker, or the session's customer, can join the room. (The pen
-- itself — who may send design:update among trusted members — is enforced app-side in
-- Phase 1; the anonymous read-only spectator token + a receive-only policy is Phase 2.)
--
-- Verify against the live project before relying on it (the realtime.messages shape /
-- topic helper can vary by Supabase version). Left commented so Phase 0 (no realtime
-- client yet) is unaffected.
--
-- CREATE OR REPLACE FUNCTION public.is_design_session_member(session_uuid uuid)
-- RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
--   SELECT EXISTS (
--     SELECT 1 FROM design_sessions s
--     WHERE s.id = session_uuid
--       AND s.status_id = 1
--       AND (
--         EXISTS (SELECT 1 FROM baker_appusers u WHERE u.baker_id = s.baker_id AND u.auth_user_id = auth.uid())
--         OR EXISTS (SELECT 1 FROM customers c   WHERE c.id = s.customer_id     AND c.auth_user_id = auth.uid())
--       )
--   );
-- $$;
--
-- ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "design_session members read/write"
--   ON realtime.messages FOR ALL TO authenticated
--   USING      ( topic LIKE 'session:%' AND public.is_design_session_member( substr(topic, 9)::uuid ) )
--   WITH CHECK ( topic LIKE 'session:%' AND public.is_design_session_member( substr(topic, 9)::uuid ) );
