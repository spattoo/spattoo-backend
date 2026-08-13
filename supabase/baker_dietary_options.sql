-- ── baker_dietary_exclusions ──────────────────────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- WHAT: not every bakery does vegan. This is the baker switching a dietary option OFF
-- for their whole tenant. Extends supabase/dietary_requirements.sql (the vocabulary) and
-- supabase/flavour_dietary.sql (per-flavour conflicts) — three different questions:
--
--   dietary_requirements            what a customer can ask for, platform-wide
--   baker_dietary_exclusions (here) does this bakery deal in that at all?
--   flavour_dietary_conflicts       they do eggless — but not for THIS flavour
--
-- Deliberately mirrors baker_flavour_exclusions / baker_template_exclusions: same
-- "baker switches off one of Spattoo's globals" shape, same replace-set route, so there
-- is one pattern in this codebase rather than a fourth variation of it.
--
-- ── A ROW MEANS "NOT OFFERED" — AND THAT MEANS TWO DIFFERENT THINGS ───────────
-- The effect deliberately depends on dietary_requirements.kind, which is exactly what
-- that column exists for. It is not a special case; it is the distinction the whole
-- feature is built on:
--
--   kind='diet'      (eggless / vegan / Jain) — a MENU. If a bakery doesn't do vegan,
--                    the option is HIDDEN from their order form. Showing it would invite
--                    an order they will refuse, which helps nobody.
--
--   kind='allergen'  (nut / gluten / dairy) — NOT a menu, and NEVER hidden. A customer's
--                    nut allergy does not go away because the baker doesn't cater to it.
--                    Hide the chip and the allergy goes back into the free-text
--                    "Special instructions" box — the precise transmission loss this
--                    whole feature was built to fix — or goes unsaid entirely, because a
--                    form that doesn't ask implies it doesn't matter. So the option stays
--                    on the form, is still RECORDED on the order, and merely carries a
--                    warning: "this bakery can't guarantee nut-free, please talk to them."
--                    The baker still gets to say "not us" up front; the customer still
--                    gets to state their allergy; nobody discovers it on the day.
--
-- Same non-blocking posture as everything else here: it warns, it never refuses an
-- order, and it asserts nothing about what any cake contains (ToS §3.4 / B5.9 / C2.3).
--
-- ── SCALE ─────────────────────────────────────────────────────────────────────
-- Bounded: at most (bakers × requirements) rows, and only for the ones switched OFF —
-- a baker who offers everything stores nothing. Never grows with orders. `orders` and
-- `order_dietary_requirements` remain the only hot tables in this feature.
--
-- Stores the compact `requirement_id smallint`, never the text key (CLAUDE.md: the
-- referencing side takes the surrogate). The API translates at the boundary, so routes
-- and HTTP still speak 'vegan'.
--
-- ACCESS PATTERN: "what does baker B not offer" — one query per order-form load, served
-- by the leading baker_id of the PK. The reverse ("who doesn't do vegan") is not a query
-- the product makes, so there is no second index.

CREATE TABLE IF NOT EXISTS baker_dietary_exclusions (
  baker_id       uuid        NOT NULL REFERENCES bakers(id) ON DELETE CASCADE,
  requirement_id smallint    NOT NULL REFERENCES dietary_requirements(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (baker_id, requirement_id)
);

COMMENT ON TABLE baker_dietary_exclusions IS
  'Per-baker switched-OFF dietary options. A row = this bakery does not deal in that requirement. Effect depends on dietary_requirements.kind: a diet option (eggless/vegan/jain) is HIDDEN from the order form; an allergen (nut/gluten/dairy) is NEVER hidden — it stays on the form and is still recorded, carrying a "cannot guarantee" warning, because a customer''s allergy does not disappear when a baker stops offering it and hiding it would push it back into free text. Mirrors baker_flavour_exclusions. Absence of a row = offered.';
