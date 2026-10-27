-- ── 142: "Welcome home" joins the occasion vocabulary ───────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────────────────────────
-- Sandeep: *"when a relative or a family member returning back home from a foreign trip, people
-- celebrate."* They do, and the list could not name it. The nearest value was `other` — "Just
-- because" — which is what 059 already called out as the one that "tells it nothing at all".
--
-- ⚠️ IT IS THE MISSING HALF OF A PAIR WE ALREADY HAVE. `farewell` has been here since 059: the
-- cake for somebody leaving. The cake for the same person coming back had nowhere to go. One
-- direction of a journey was nameable and the other was not, which is the clearest argument that
-- this is a gap rather than an addition.
--
-- ── "Welcome home", NOT "Trip" ──────────────────────────────────────────────────────────────────
-- Three reasons, in the order they matter:
--
--   1. It is what goes ON the cake. "Welcome home" is piped in buttercream every week; nobody
--      writes "Trip". The occasion a customer picks and the words they want should be the same
--      phrase, so the picker reads as a sentence they recognise rather than a category.
--   2. "Trip" names the JOURNEY, not the celebration, so it is ambiguous about which end — a cake
--      before someone leaves is `farewell`, and a list carrying both `farewell` and `trip` invites
--      the wrong one.
--   3. It does not assume abroad. A student home from university, a parent back from months on a
--      site, a relative returning after a long posting — same cake, same occasion. Keying it to
--      foreign travel would narrow a thing that is mostly domestic.
--
-- Same reasoning as 059's `new_home`, never "Housewarming": name the moment, not a format or an
-- assumption about it.
--
-- ⚠️ THE CONSTRAINT WIDENS FIRST, AND THE CLIENT LIST FOLLOWS — 059 states it and it still holds.
-- A value the CHECK does not know reaches the insert and surfaces as an unreadable 500 on a
-- customer's enquiry. So this file goes to dev and prod BEFORE cakeDraft.js offers the option.
--
-- Dropped and recreated rather than added to: a CHECK cannot be extended in place, and naming it
-- the same keeps 043's name as the one to look for.

BEGIN;

ALTER TABLE public.orders DROP CONSTRAINT IF EXISTS orders_occasion_valid;

ALTER TABLE public.orders ADD CONSTRAINT orders_occasion_valid CHECK (
  occasion IS NULL OR occasion IN
  ('birthday','anniversary','wedding','engagement','bridal_shower','baby_shower',
   'new_home','graduation','new_job','festival','farewell','welcome_home','corporate','love','other'));

COMMENT ON COLUMN public.orders.occasion IS
  'What the cake is for. Fixed vocabulary, widened by 059 and 142: birthday | anniversary | wedding | engagement | bridal_shower | baby_shower | new_home | graduation | new_job | festival | farewell | welcome_home | corporate | love | other. `farewell` and `welcome_home` are the two ends of the same journey. `love` is a motive rather than an event. Customer-facing labels live in spattoo-core cakeDraft.js OCCASIONS and must stay in step with this list.';

COMMIT;

-- ── The tag, so a template can be FILED under it ────────────────────────────────────────────────
-- 108's rule: every master-list occasion a template could be filed under has a tag of the same
-- slug. Hyphenated here, underscored in the master list — 108 explains why both spellings stay.
--
-- sort_order 85 puts it directly after Farewell (80) and before Office do (90), so the pair reads
-- together in the picker. Life events 10–99, festivals 100+, per 108.
insert into tags (name, slug, category, ai_assignable, sort_order, is_active)
select v.name, v.slug, 'occasion', false, v.sort_order, true
from (values
  ('Welcome home', 'welcome-home', 85)
) as v(name, slug, sort_order)
where not exists (
  select 1 from tags t where t.slug = v.slug and t.category = 'occasion'
);

-- Verify — the constraint accepts the new value, and the tag is filed beside Farewell:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname = 'orders_occasion_valid';
--   select slug, name, sort_order from tags where category = 'occasion' order by sort_order;
