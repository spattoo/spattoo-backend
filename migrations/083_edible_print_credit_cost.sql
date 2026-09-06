-- ── 083: what an edible print costs a baker ──────────────────────────────────────────────────────
--
-- X-Ray spots the edible prints on a reference photo — the goose, the plaque — and generates them
-- onto the A4 sheet. That spends real money, so it is metered, and the price is DATA here rather
-- than a constant in code: a provider price change should move our margin, not our shelf price.
-- See plans/edible-prints-from-a-reference-photo.md.
--
-- ── 25 credits, and where that comes from ───────────────────────────────────────────────────────
--
-- The rule (features/ai-credits.md): priced on value to the baker, floored by cost, at a target of
-- ≥80% gross margin, 1 credit ≈ ₹1 retail, USD→INR 90.
--
--   one image, gpt-image-2, medium 1024x1024   ≈ $0.053  =  ₹4.77 landed
--   at the 80% target                          →  ₹23.85  →  24 credits
--   shipped at                                     25 credits  =  81% margin
--
-- Sanity-checked against the one comparable row. `sticker_generate` is 60 credits at a stated 77%
-- margin, which implies ₹13.80 landed — about a HIGH-quality image. A print is a medium one, so a
-- little over a third of the price is the right shape, not a bargain.
--
-- ⚠️ The $0.053 is a PUBLIC figure, not an invoice. If gpt-image-2 lands dearer — at $0.08 the
-- margin here falls to 71% — this row is what changes, in admin, without a deploy. That is the
-- whole reason it is a table.
--
-- ── One press, one image ────────────────────────────────────────────────────────────────────────
-- Admin's Extract Elements can ask for several variants and keep the best, because Spattoo pays and
-- a bad one is simply not saved. A baker pays per press, so a press is ONE image. Charging 25 and
-- silently generating four would be the same row meaning four different prices.
--
-- ── Generated once, then free forever ───────────────────────────────────────────────────────────
-- The print lands in the baker's own uploads and is reusable on every future sheet at no further
-- cost — the same bargain `element_build_guide` already makes ("one per decoration, then free
-- forever"). The baker is paying for the GENERATION, never for the reuse.
--
-- ── ⚠️ IDENTIFY IS DELIBERATELY NOT AN ACTION HERE ──────────────────────────────────────────────
-- Deciding WHICH decorations are prints is folded into the X-Ray photo read the order already paid
-- for (`photo_to_xray_estimate`, 15 credits). It is a property of that same read of that same
-- photo, and billing twice to look at one photograph is how a fair meter starts feeling grabby.
-- It also keeps the button honest: X-Ray can offer "generate these" on every order without the
-- offer itself having cost anything. Do not add an `edible_print_identify` row.
--
-- ── is_active = false, because it is not built ──────────────────────────────────────────────────
-- `is_active` means "currently offered". False keeps the billing card from advertising a feature
-- that does not exist, and makes `reserve_ai_credits` fail closed with UNKNOWN_ACTION if anything
-- calls it early. Flip it to true in the change that ships the feature — not before.
--
-- `label` is what the baker is BILLED for and must match what they PRESSED. It must also be unique
-- among ACTIVE rows (migration 026, partial unique index): two actions sharing a label render as
-- one job at two prices and read as a bug. This one is reached from X-Ray, so it says so, like the
-- other two.

insert into credit_costs (action_key, credits, label, is_active) values
  ('edible_print_generate', 25, 'X-Ray — make an edible print', false)
on conflict (action_key) do update
  set credits = excluded.credits, label = excluded.label,
      is_active = excluded.is_active, updated_at = now();

-- Expect the new row inactive, and no duplicate label among the active ones.
select action_key, credits, label, is_active
  from credit_costs
 order by is_active desc, action_key;
