-- ── 069: the Toppers category ────────────────────────────────────────────────────────────────────
--
-- Added for prod so a promoted 3D topper has a home in the decorations menu. Same shape as 067
-- (Sports&Games), and for the same reasons — worth restating, because the temptation each time is to
-- edit the seed in 065 instead:
--
-- ── 065 IS SPENT. IT WILL NOT RUN AGAIN ─────────────────────────────────────────────────────────
-- Migration 065 carried the starting list of categories and has already been applied in every
-- environment. Adding a row to its INSERT executes NOWHERE: not in dev, not in prod. The only
-- database that would ever see it is one created from scratch afterwards — so the edit reads as done
-- while the two live environments quietly disagree with the file and with each other. Master data
-- added later gets its own migration, always.
--
-- ── The id is deliberately not specified ────────────────────────────────────────────────────────
-- Prod mints its own. 065 ran separately in each environment, so every category has always had a
-- different uuid on each side — "Animals" is one value in dev and another here. An id is a LOCAL
-- fact. What must agree is the SLUG, which is what element bundles key on when they resolve a
-- category against whatever the target holds.
--
-- ── sort_order 115 ──────────────────────────────────────────────────────────────────────────────
-- Between Sports&Games (110) and Finishes (120), in the gaps 065 deliberately left so a category can
-- be inserted without renumbering its neighbours. This is a PLACEHOLDER position, not a judgement:
-- the menu order is a deliberate choice and the arrows on the Element Categories screen are where it
-- gets made. Moving it there is one click and needs no migration.
--
-- ON CONFLICT DO UPDATE, not DO NOTHING: if prod already has a 'toppers' slug — created by hand, or
-- minted by an element import that carried it — this reconciles it to the intended name and position
-- rather than silently leaving whatever is there.

INSERT INTO public.element_categories (slug, name, sort_order)
VALUES ('toppers', 'Toppers', 115)
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;

-- Expect 13 rows. Toppers should read between Sports&Games and Finishes.
SELECT sort_order, slug, name FROM public.element_categories ORDER BY sort_order;
