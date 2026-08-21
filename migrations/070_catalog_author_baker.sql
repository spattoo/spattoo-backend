-- ── 070: which bakery may author catalogue templates ─────────────────────────────────────────────
--
-- Templates in the catalogue (baker_id IS NULL) are ours to write. Templates a baker makes are
-- THEIRS, and taking one into the catalogue — even a very good one — is appropriating work somebody
-- did for their own shop. So publishing to the catalogue is restricted to bakeries we author from,
-- and this column is what makes that a rule the database can state rather than a habit somebody
-- has to keep.
--
-- ── It defaults to FALSE, and that is what makes this dev-only ──────────────────────────────────
-- Authoring happens in dev: a template is written there, published to the catalogue there, and
-- reaches prod through export/import, which only carries baker_id IS NULL rows. Prod therefore never
-- needs to publish anything.
--
-- That falls out of the default rather than needing an environment check. Nobody is a catalogue
-- author until somebody says so, so prod refuses every publish by construction — no NODE_ENV branch,
-- no code path that exists only in one place and is therefore only tested in one place. And if we
-- ever DO want to author in prod, it is a flag, not a release.
--
-- Nothing is marked here on purpose. Naming a bakery in a migration would hardcode one environment's
-- data into a file that runs in all of them, and the id differs per environment anyway. In dev:
--
--   UPDATE public.bakers SET is_catalog_author = true WHERE slug = '<our-bakery-slug>';
ALTER TABLE public.bakers
  ADD COLUMN IF NOT EXISTS is_catalog_author boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.bakers.is_catalog_author IS
  'May this bakery''s templates be copied into the global catalogue? FALSE for every real baker — '
  'their templates are their own work. Set only on the bakeries we author from, and only in the '
  'environment we author in (dev), which is what stops prod publishing anything without a code branch.';
