-- ── 031: the build-sequence image for a library element's guide ─────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- The photo-order half of this shipped first: a decoration read off a customer's photo stores its
-- stage image alongside its steps, inside orders.xray_spec (migration 029, no new column, because
-- the steps themselves already lived there).
--
-- An ELEMENT guide has no such container — element_craft_guide is a row, not a document — so the
-- key gets a column. The value is an R2 KEY, never a URL: the public base is deployment config and
-- would rot every stored row if it were baked in. routes/craftGuide.js expands it on read.
--
-- WHY THIS IS THE CASE THAT PAYS FOR ITSELF. An element guide is generated ONCE and every future
-- cake using that decoration gets it free — so one image call is amortised across every baker who
-- ever places that element, rather than being paid for per order. The photo case is the opposite:
-- the decoration exists only on that one order, so its picture can never be reused.
alter table element_craft_guide add column if not exists stages_key text;

comment on column element_craft_guide.stages_key is
  'R2 key of the generated build-sequence image (elements/guides/<element_id>/stages.webp), or NULL. Generated once per element and shared, unlike the photo-order equivalent in orders.xray_spec which belongs to a single order. Store the KEY, never the URL — the public base is deployment config.';
