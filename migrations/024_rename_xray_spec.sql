-- ── 024: design_estimate → xray_spec ────────────────────────────────────────────────
-- A rename, nothing else. No data moves, no type changes, no behaviour change.
--
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- WHY, since a rename is never free:
--
-- The columns were named `design_estimate*` when they landed in 022 (2026-07-29). Both halves of
-- that name were wrong, and both were wrong in ways that mislead rather than merely read poorly:
--
--   "estimate" — in THIS product's vocabulary an estimate is a PRICE.
--   PRICING_AND_QUOTE_PLAN.md: "the customer never sees a Spattoo estimate — only the baker's
--   issued quote", "the wrong estimate hurts the baker". A jsonb column called design_estimate,
--   sitting on `orders` beside quoted_price, quote_valid_until and advance_paid_at, reads as
--   money-adjacent to anyone who did not write it.
--
--   "design" — nothing was designed. `orders.design_snapshot` is the real design, authored in the
--   3D designer. Side by side, `design_snapshot` and `design_estimate` invite the reading that the
--   second is a draft or a cheaper variant of the first. It is neither: it is the structure we read
--   off a customer's reference photo so the X-Ray pipeline has something to compute from.
--
-- `xray_spec` says what it is and where it belongs. The `xray_` prefix makes the whole feature
-- greppable — someone searching "xray" now finds the storage as well as the report — and `spec`
-- says it is the INPUT to the guide, not the guide.
--
-- Deliberately NOT `xray_result`: the result (tin sizes, gel recipes, nozzle recommendations, the
-- checklist) is computed on every open and never stored. A column called _result would have someone
-- opening it expecting the finished sheet.
--
-- Done now rather than later because the columns are two days old, almost certainly hold no rows,
-- and CLAUDE.md's "PERSISTED SCHEMA IS FOREVER" applies from the day a name ships, not from the day
-- someone notices it is wrong.

alter table orders rename column design_estimate        to xray_spec;
alter table orders rename column design_estimate_meta   to xray_spec_meta;
alter table orders rename column design_estimate_edited to xray_spec_edited;

-- The partial index was created against the old column name; Postgres keeps the index working
-- through a rename, but its NAME would still say design_estimate. Recreate it so the name matches
-- what it indexes — an index whose name lies is a small thing that costs someone ten minutes later.
drop index if exists orders_design_estimate_idx;
create index if not exists orders_xray_spec_idx
  on orders (baker_id) where xray_spec is not null;

comment on column orders.xray_spec is
  'IMMUTABLE model reading of a reference-photo order, in design_snapshot shape — the INPUT X-Ray computes from. Never updated in place; corrections belong in xray_spec_edited.';
comment on column orders.xray_spec_meta is
  '{ provider, model, prompt_version, confidence, credit_transaction_id, source_photo_key, coverage } — provenance for the spec above.';
comment on column orders.xray_spec_edited is
  'Baker-corrected copy of xray_spec. NULL until they change something. spec vs edited is the accuracy signal.';
