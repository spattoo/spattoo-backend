-- ── 094: why a decoration guide has no picture ────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
-- A decoration guide is TWO paid calls: the steps, then the tutorial sheet. The second
-- can fail on its own, and when it does the guide is kept — the words are the product.
--
-- But the REASON only ever existed in a Render log line. `stages_key` went in as null,
-- which records THAT there is no picture and nothing about why, so an admin looking at
-- the screen that spent the money could not see what happened. Reported as "it's only
-- generating text".
--
-- The message is now returned on the build response, which covers the moment it fails.
-- It does not survive a reload, and a guide generated last week has no message at all.
-- This column is where it lives instead.
--
-- ⚠️ ADMIN-ONLY, AND THE SELECT LIST IS WHAT ENFORCES THAT. This is a provider's raw
-- error string — it names models and quotes internal API text, and it is written for
-- whoever authors the catalogue, never for a baker. `CRAFT_FIELDS` in routes/craftGuide
-- deliberately does NOT list it, so the two baker-reachable reads (X-Ray's batch fetch
-- and the baker's own decoration-steps route) cannot return it even by accident.
-- `ADMIN_CRAFT_FIELDS` adds it for the two admin reads. A new baker-facing read that
-- needs guide columns must use CRAFT_FIELDS, and then this cannot leak by default.
--
-- ⚠️ It is cleared on every successful build, not only set on failure. A stale reason
-- sitting beside a picture that now exists is worse than no reason: it describes an
-- attempt that has been superseded, and it would be read as current.
--
-- Nothing backfills. Every existing row gets null, including the one that prompted this
-- — its message is gone, and the next rebuild is what produces one.

alter table element_craft_guide
  add column if not exists stages_error text;

comment on column element_craft_guide.stages_error is
  'Why the tutorial sheet could not be generated on the last build, verbatim from the '
  'provider. Null when the sheet succeeded (cleared on every success) or when the guide '
  'predates this column. ADMIN-ONLY: never selected by a baker-facing read — see '
  'CRAFT_FIELDS vs ADMIN_CRAFT_FIELDS in src/routes/craftGuide.js.';
