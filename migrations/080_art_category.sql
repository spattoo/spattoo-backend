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
-- ── sort_order 118, and ⚠️ ONLY IF THE ROW IS NEW ───────────────────────────────────────────────
-- 118 sits between Toppers and Finishes, in the gaps 065 left so a category can be inserted without
-- renumbering its neighbours. It is a PLACEHOLDER for an environment that has no Art category yet.
--
-- ⚠️ DO NOTHING, NOT DO UPDATE — the opposite of 069, deliberately. This category already exists in
-- dev, created by hand, at sort_order 150. DO UPDATE would have dragged it to 118 and renamed it, in
-- an environment where somebody had already decided where it goes. The menu order is a real choice
-- made with the arrows on the Element Categories screen — the same screen 069's own comment points
-- at — and the sort_orders there have already drifted from every number in these migrations
-- (Toppers was written as 115 and now reads 140). A migration that "reconciles" them is not fixing
-- drift, it is overruling an admin.
--
-- 069's DO UPDATE was right for ITS case: reconciling a row that an element import had minted as a
-- side effect, where no human had chosen anything. The test is whether a person decided, not whether
-- the row happens to differ from the file.

INSERT INTO public.element_categories (slug, name, sort_order)
VALUES ('art', 'Art', 118)
ON CONFLICT (slug) DO NOTHING;

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
