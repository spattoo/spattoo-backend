-- ── 067: the Sports&Games category ───────────────────────────────────────────────────────────────
--
-- Added in dev through the admin screen on 2026-08-18. This is the same change for prod.
--
-- ── Why a migration and not a paste ─────────────────────────────────────────────────────────────
-- A category is master data, and master data authored in one environment does not reach the other on
-- its own. Writing it here means `npm run db:migrations` records it — so "has prod had this?" is a
-- question the database answers, rather than one somebody has to remember. That is the whole reason
-- the ledger exists: `supabase/baker_dietary_options.sql` sat unapplied in BOTH environments for
-- weeks and only surfaced when saving flavours broke.
--
-- ── The id is deliberately not specified ────────────────────────────────────────────────────────
-- Prod generates its own, and that is correct. Migration 065 ran separately in each environment, so
-- every category has had a different uuid on each side since the day it landed — "Animals" is
-- 047441a1-… in dev and something else here. An id is a LOCAL fact.
--
-- What must agree is the SLUG. Transport between environments should key on it and resolve to
-- whatever id the target holds; anything that ships an id is asserting a fact about a database it is
-- not running in.

INSERT INTO public.element_categories (slug, name, sort_order)
VALUES ('sports-games', 'Sports&Games', 110)
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name, sort_order = EXCLUDED.sort_order;

-- Finishes moved to 120 in dev when Sports&Games was inserted above it. The menu order is a
-- deliberate choice — it is the order customers browse in — so prod follows rather than drifting.
UPDATE public.element_categories SET sort_order = 120 WHERE slug = 'finishes';

-- Expect 12 rows, reading:
--   piping · animals · flowers-leaves · unicorn-rainbow · baby · numbers-letters ·
--   chocolate · party-shapes · people · photo-frames · sports-games · finishes
SELECT sort_order, slug, name FROM public.element_categories ORDER BY sort_order;
