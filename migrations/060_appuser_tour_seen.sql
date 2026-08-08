-- ── 060: has this PERSON been shown the designer tour ──────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/features/  (designer tour)
--
-- ── WHY A COLUMN AND NOT localStorage ───────────────────────────────────────────────
-- The tour shipped remembering itself in localStorage, which is per browser and per
-- device: a baker who opens the app on a laptop after a phone gets it again, and one
-- who clears their data gets it again. For a customer that is tolerable — they have one
-- visit and are not identified when the tour runs. A baker is authenticated from the
-- first render, so there is no reason to guess.
--
-- ── WHY baker_appusers AND NOT bakers ───────────────────────────────────────────────
-- A tour is a fact about a PERSON, not about a bakery. `bakers` is the shop; the human
-- is a row here. They are the same thing today only because STAFF_UI_ENABLED is false
-- and every bakery has exactly one app user — put it on `bakers` and the day seats ship,
-- the second person to join an existing bakery would never be offered the tour, because
-- somebody else had already seen it.
--
-- ── WHY A TIMESTAMP AND NOT A BOOLEAN ───────────────────────────────────────────────
-- `true` answers "has it been seen" and nothing else. A timestamp answers that (NOT NULL
-- means seen) and also "when", which is the column you actually want the first time
-- somebody asks whether people finish it, or whether a baker who signed up in March has
-- seen the version of the tour written in August. Same width, strictly more information.
--
-- Re-showing after the steps change is deliberately NOT modelled here. If that is ever
-- wanted it is a version number, not a wipe of this column — the fact that they saw the
-- old one stays true.
ALTER TABLE baker_appusers
  ADD COLUMN IF NOT EXISTS tour_seen_at timestamptz;

COMMENT ON COLUMN baker_appusers.tour_seen_at IS
  'When this person was first shown the designer tour. NULL = never. Per PERSON, not per '
  'bakery — bakers is the shop, and a second staff member deserves their own first run.';
