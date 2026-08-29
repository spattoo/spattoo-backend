-- ── 080: the Art category ────────────────────────────────────────────────────────────────────────
--
-- A home in the decorations menu for things the baker DRAWS rather than places: the chocolate pen
-- first, and the cream pen alongside it. Every other category is a subject — Animals, Sky, Toppers.
-- This one is a technique, which is the honest description: what unites a piped monogram, a filigree
-- leaf and a drawn outline is the hand and the bag, not what any of them depicts.
--
-- ── 065 IS SPENT. IT WILL NOT RUN AGAIN ─────────────────────────────────────────────────────────
-- Migration 065 carried the starting list of categories and has already been applied everywhere.
-- Adding a row to its INSERT executes NOWHERE — the edit reads as done while the live environments
-- quietly disagree with the file. Master data added later gets its own migration, always.
--
-- ── The id is deliberately not specified ────────────────────────────────────────────────────────
-- 065 ran separately in each environment, so every category has a different uuid on each side. An id
-- is a LOCAL fact; what must agree is the SLUG, which is what element bundles key on.
--
-- ── sort_order 118 ─────────────────────────────────────────────────────────────────────────────
-- Between Toppers (115) and Finishes (120), in the gaps 065 left so a category can be inserted
-- without renumbering its neighbours. A PLACEHOLDER position, not a judgement: the menu order is a
-- deliberate choice and the arrows on the Element Categories screen are where it gets made.
--
-- ON CONFLICT DO UPDATE, not DO NOTHING: if an 'art' slug already exists — created by hand, or minted
-- by an element import that carried it — this reconciles it rather than leaving whatever is there.

INSERT INTO public.element_categories (slug, name, sort_order)
VALUES ('art', 'Art', 118)
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;

-- ⚠️ THE ELEMENT ROWS ARE NOT CREATED HERE, and that is deliberate rather than an omission. No
-- migration in this repo inserts into cake_elements: rows are master data an admin authors on
-- Manage Elements, with a name, a thumbnail and a category they can change without a deploy. This
-- migration only builds the shelf.
--
-- To put the chocolate pen on it: Add Element → procedural, generator `chocolate_pen`, category Art.
-- The generator key is what the designer's PROCEDURAL_TOOLS registry looks up; a row without it
-- appears in the picker and does nothing when tapped.

-- Verify — Art should read between Toppers and Finishes:
--   select sort_order, slug, name from element_categories order by sort_order;
