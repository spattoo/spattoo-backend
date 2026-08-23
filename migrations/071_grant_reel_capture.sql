-- ── 071: who may record a reel, and whose name is on it ─────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- Docs: spattoo-docs/plans/reel-for-bakers.md, spattoo-docs/features/reel-capture.md
--
-- ── WHY THE KEYS MUST BE WRITTEN TO EVERY PLAN ──────────────────────────────────────────────────
-- The resolver reads a plan's value with hasOwnProperty:
--
--     const raw = hasOwnProperty(features, key) ? features[key] : def.fallback;
--
-- Both keys have `fallback: false`, so a plan row that does not carry them resolves FALSE. That is
-- the correct failure direction — a missing key locks rather than unlocks — but it is exactly how
-- the Edible Print Studio shipped gated shut for everybody, including the tiers that had paid for
-- it (see migration 050). So every plan gets an explicit value here, including the FALSE ones.
--
-- ── reel_capture: TRUE ON EVERY TIER, INCLUDING SPARK AND FLAME ─────────────────────────────────
-- Not an oversight, and not generosity. Recording runs entirely on the baker's own device: their
-- GPU renders the frames, their hardware encoder writes the MP4, the file lands in their downloads.
-- No upload, no transcode, no storage, no queue — a Spark baker recording a thousand reels costs us
-- nothing but their battery. There is no cost to recover, so gating it would be a pure pricing
-- choice.
--
-- And for a feature whose entire output is PUBLISHED IN PUBLIC, locking it is the weaker choice: a
-- locked feature generates no awareness, a watermarked one markets us every time it is posted.
--
-- ── reel_branding: THE BLAZE LEVER ──────────────────────────────────────────────────────────────
-- TRUE  → the reel carries the bakery's own name.
-- FALSE → a small "made with Spattoo".
--
-- The upgrade reads as "take our name off your marketing", which is the Canva/Loom model and
-- converts because the customer sees the mark on their own work every day.
--
-- ⚠️ The free mark must not be made ugly on purpose. Its value depends entirely on bakers being
-- WILLING to post the video; an eyesore gets cropped out or never published, trading a distribution
-- channel for a little pressure.
--
-- ── A LAPSED SUBSCRIPTION LOSES BOTH ────────────────────────────────────────────────────────────
-- BLOCKED_STATUSES collapses everything to `fallback`, so a lapsed baker cannot record at all rather
-- than recording with our name on it. That falls out of the existing resolver and needs nothing here
-- — noted so nobody later reads it as a gap.

BEGIN;

-- Every paid tier may record.
update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('reel_capture', true)
 where name in ('spark', 'flame', 'blaze', 'forge');

-- Blaze and above get their own name on it.
update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('reel_branding', true)
 where name in ('blaze', 'forge');

-- Written explicitly rather than left absent, so the value is a decision on the row and not an
-- accident of the fallback — and so the admin plan editor shows it as OFF rather than as missing.
update subscription_plans
   set features = coalesce(features, '{}'::jsonb) || jsonb_build_object('reel_branding', false)
 where name in ('spark', 'flame');

COMMIT;

-- Merge (`||`) rather than jsonb_build_object on its own: a migration must not assume it knows every
-- key a plan row currently carries.
--
-- Verify:
--   select name,
--          features->'reel_capture'  as capture,
--          features->'reel_branding' as branding
--     from subscription_plans order by sort_order;
-- Expected: capture true on all four; branding true on blaze/forge, false on spark/flame.
