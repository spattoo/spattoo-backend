-- ── flavour ↔ dietary requirement conflicts ───────────────────────────────────
-- Run once in the Supabase SQL editor. Safe to re-run (idempotent).
--
-- WHAT: lets the order form say "you asked for nut-free, but Hazelnut Praline normally
-- contains nuts — please confirm with ABC Bakery" AT ORDER TIME, instead of that
-- contradiction surfacing on the bench on Saturday morning. Extends
-- supabase/dietary_requirements.sql, which captures the requirement itself.
-- See spattoo-docs/features/dietary-requirements.md.
--
-- ── THIS IS A WARNING, NOT A GATE ─────────────────────────────────────────────
-- Nothing here blocks an order, and no UI built on it may disable a flavour. Two
-- reasons, and both are load-bearing:
--
--   1. A disabled option ASSERTS that the platform knows what is compatible. ToS §3.4
--      says the opposite in terms — Spattoo records a requirement and verifies nothing;
--      the baker decides and confirms (B5.9); recording is not a substitute for asking
--      (C2.3). Blocking would quietly turn that disclaimer back into a representation,
--      which is the single thing this whole feature has been built to avoid.
--   2. The data is human-authored and WILL drift. A baker who has not updated their
--      declarations, or who would happily make an exception, must not lose the order —
--      and the customer must not be stopped without being told why. A warning fails
--      safe in both directions; a block only fails one way.
--
-- So the rows below feed a warning that names the baker and tells the customer to talk
-- to them. The customer can always proceed.
--
-- ── TWO LAYERS, BECAUSE THERE ARE TWO DIFFERENT FACTS ─────────────────────────
-- "Hazelnut Praline contains nuts" is a property of the FLAVOUR — true for every baker
-- on the platform, forever. Asking 25,000 bakers to each declare it is the same row
-- authored 25,000 times, and wrong the moment one of them forgets.
--
-- "We don't do eggless Tiramisu" is a property of ONE KITCHEN — the baker down the road
-- does. It is genuinely per-baker and cannot be centralised.
--
-- Hence a global baseline plus a SPARSE per-baker override, resolved baseline-then-
-- override at read time. (Same shape as the capability + sparse-override model planned
-- for decoration↔shape compatibility — one pattern, not a second one invented here.)
--
-- ── WHY THE OVERRIDE IS A BOOLEAN AND NOT A DELETE-LIST ───────────────────────
-- The override must be able to point BOTH ways. If it could only ADD a conflict, the
-- baseline would become a claim a baker cannot correct — a baker who genuinely makes a
-- nut-free hazelnut sponge would be permanently contradicted by us, on their own
-- storefront, with no way to answer. `conflicts=false` is that answer. Absence of a row
-- means "no opinion, use the baseline", which is why this is a 3-state resolution and
-- not a boolean column on some flavour row.
--
-- ── SCALE (see CLAUDE.md "persisted schema is forever") ───────────────────────
-- Neither table is hot. Both grow with BAKERS × FLAVOURS, never with orders — `orders`
-- and `order_dietary_requirements` are the tables that grow to millions and neither is
-- touched here. Dense worst case at 25k bakers × ~15 flavours × 6 requirements is ~2.2M
-- override rows; real data is far sparser, because a row only exists where a baker
-- disagrees with the baseline.
--
-- The surrogate-FK rule still applies regardless of size: both tables reference
-- dietary_requirements by its compact `id smallint`, NEVER the text key. The API
-- translates at the boundary so route code and HTTP still speak 'nut_free'.
--
-- ACCESS PATTERN: exactly one query per order-form load — "every declaration for baker
-- B" — served by the leading baker_id of the unique indexes. There is no reverse query
-- ("which bakers cannot do eggless") anywhere in the product, so there is no second
-- index to carry. Add one when a query actually needs it, not before.

-- ── layer 1: the global baseline (Spattoo-authored, in admin) ─────────────────
-- Only GLOBAL flavours get a baseline. A baker's own custom flavour is their recipe;
-- Spattoo has no basis for an opinion on it, which is why there is no baseline table
-- for baker_flavours — only the override below can speak for those.
--
-- A row means: "this flavour, as generally made, does not satisfy this requirement."
-- It is a DEFAULT the baker can overturn, not a verified ingredient claim — see the
-- ToS note above.
CREATE TABLE IF NOT EXISTS flavour_dietary_conflicts (
  flavour_id     uuid        NOT NULL REFERENCES flavours(id) ON DELETE CASCADE,
  requirement_id smallint    NOT NULL REFERENCES dietary_requirements(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flavour_id, requirement_id)
);

COMMENT ON TABLE flavour_dietary_conflicts IS
  'Global baseline: this flavour, as generally made, does not satisfy this dietary requirement (e.g. Hazelnut Praline vs nut_free). Admin-authored master data, and a DEFAULT ONLY — a baker can overturn any row via baker_flavour_dietary_conflicts. Drives a warning that names the baker; it never blocks an order and no UI may disable a flavour on the strength of it (ToS §3.4 / B5.9 / C2.3).';

-- NOT SEEDED ON PURPOSE. Which flavours conflict with which requirements is content,
-- and content is authored in admin by a person who knows the recipes — not guessed here
-- and shipped as fact. The tool ships empty; the first row is a human decision.

-- ── layer 2: the per-baker override (sparse) ──────────────────────────────────
-- A row means: "for THIS baker, this flavour × this requirement is settled, whatever
-- the baseline says." conflicts=true adds a conflict the baseline missed; conflicts=
-- false clears one the baseline asserted. No row = no opinion, fall through to layer 1.
--
-- EXCLUSIVE ARC: exactly one of flavour_id / baker_flavour_id is set, so a declaration
-- can attach to a global flavour or to one of the baker's own, with a real FK on both
-- sides. The alternative — a polymorphic (kind, id) pair — has no FK at all and leaves
-- orphan rows behind the moment a flavour is deleted, so it is not used.
CREATE TABLE IF NOT EXISTS baker_flavour_dietary_conflicts (
  baker_id         uuid        NOT NULL REFERENCES bakers(id) ON DELETE CASCADE,
  flavour_id       uuid            NULL REFERENCES flavours(id) ON DELETE CASCADE,
  baker_flavour_id uuid            NULL,   -- FK added in the guard below
  requirement_id   smallint    NOT NULL REFERENCES dietary_requirements(id),
  -- true  = "we cannot make this flavour meet that requirement"
  -- false = "we CAN, despite the global baseline" — the baker's right of reply
  conflicts        boolean     NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT baker_flavour_dietary_one_target
    CHECK (num_nonnulls(flavour_id, baker_flavour_id) = 1)
);

-- Uniqueness is two PARTIAL indexes rather than a primary key: a PK cannot contain
-- NULLs, and the exclusive arc means one of the two target columns is always NULL.
CREATE UNIQUE INDEX IF NOT EXISTS baker_flavour_dietary_global_uniq
  ON baker_flavour_dietary_conflicts (baker_id, flavour_id, requirement_id)
  WHERE flavour_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS baker_flavour_dietary_custom_uniq
  ON baker_flavour_dietary_conflicts (baker_id, baker_flavour_id, requirement_id)
  WHERE baker_flavour_id IS NOT NULL;

COMMENT ON TABLE baker_flavour_dietary_conflicts IS
  'Sparse per-baker override of flavour_dietary_conflicts. conflicts=true adds a conflict, conflicts=false clears one the global baseline asserted (a baker who really does make a nut-free hazelnut sponge must be able to say so). No row = no opinion, fall through to the baseline. Exclusive arc: exactly one of flavour_id / baker_flavour_id is set.';

-- ── the baker_flavours foreign key, guarded ───────────────────────────────────
-- baker_flavours is read by GET /api/flavours but has no DDL in the repo and no
-- authoring UI, so this script cannot assume it exists. Adding the FK inline would
-- abort the whole migration halfway if it doesn't. Guarded, the tables land either way
-- and the constraint appears as soon as the table does — re-run this file after
-- creating baker_flavours and the FK is picked up.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'baker_flavours')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint
                     WHERE conname = 'baker_flavour_dietary_custom_fk')
  THEN
    ALTER TABLE baker_flavour_dietary_conflicts
      ADD CONSTRAINT baker_flavour_dietary_custom_fk
      FOREIGN KEY (baker_flavour_id) REFERENCES baker_flavours(id) ON DELETE CASCADE;
    RAISE NOTICE 'baker_flavour_dietary_custom_fk added.';
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema = 'public' AND table_name = 'baker_flavours')
  THEN
    RAISE NOTICE 'baker_flavours not found — FK skipped. Re-run this file after creating it.';
  END IF;
END $$;

-- ── deliberately NOT here ─────────────────────────────────────────────────────
-- 1. No conflict flag stored on the order. A conflict is DERIVED from (the order's
--    requirements × the tier's flavour × current declarations), and declarations
--    change. A stored flag would go stale and start lying on the one screen where
--    being wrong is worst — the bench sheet. It is recomputed on every read instead.
-- 2. No record that the customer was warned and proceeded anyway. That has real value
--    in a dispute, but it is a consent-trail concern and belongs with consent_events
--    (see features/legal-consent.md), not as a column here. Half-building it would be
--    worse than not having it, because a partial trail reads as a complete one.
-- 3. Nothing for free-text flavours. orders.flavours stores {tier,name,flavourId,source}
--    and a hand-typed flavour has flavourId=null — no id, no declaration to match, no
--    warning. That gap is honest and documented rather than papered over.
