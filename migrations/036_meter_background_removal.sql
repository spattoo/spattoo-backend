-- ── 036: background removal costs credits ───────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── WHY THIS IS METERED AT ALL ──────────────────────────────────────────────────────
-- It is the ONLY user-triggered action we pay a per-image fee for and do not charge for.
-- services/backgroundRemoval.js named the risk before the feature shipped: remove.bg is ~₹15 an
-- image, and "My Decorations" puts an upload button in front of every baker and every customer, so
-- the volume is user-driven and unbounded. A baker uploading a hundred images in a month costs us
-- ₹1,500 against a ₹999 subscription, and nothing stopped that.
--
-- ── WHY CREDITS AND NOT A DAILY CAP ─────────────────────────────────────────────────
-- A cap's only escape is waiting until tomorrow, and it lands hardest on the baker with an urgent
-- order — the worst customer to block. Credits run out too, but running out is recoverable by an
-- action the baker controls: they top up, on a screen that already warns them at 80%.
--
-- ── WHY IT DOES NOT FEEL LIKE A CHARGE ──────────────────────────────────────────────
-- The monthly allowance IS the free tier. A baker only pays real money after spending credits their
-- subscription already gave them, and the price list in the app names every metered action up front,
-- so this appears there the moment this migration runs. Nothing is billed by surprise.
--
-- ── THE PRICE TRACKS OUR COST, AND OUR COST IS TEMPORARY ────────────────────────────
-- 15 credits ≈ ₹15 ≈ what remove.bg charges us. That is deliberately cost-recovery rather than
-- margin: it caps what a month's allowance can be converted into (300 credits → 20 cut-outs → ₹300
-- of vendor spend) instead of trying to profit from a utility.
--
-- It is priced high for what it is, and that is the vendor's doing. `spattoo-bgremover` (silueta,
-- self-hosted, no per-image fee) makes the true cost ~zero, and when BG_REMOVAL_PROVIDER flips to
-- 'self' this number should drop to 1–2 — a data change, no deploy. Do that promptly: 15 credits
-- for a background cut-out sits uncomfortably beside 15 for reading a whole cake photo.
insert into credit_costs (action_key, credits, label, is_active) values
  ('background_removal', 15, 'Cut out an image background', true)
on conflict (action_key) do update
  set credits = excluded.credits, label = excluded.label,
      is_active = excluded.is_active, updated_at = now();
