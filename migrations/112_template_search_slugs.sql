-- ── 112: what a template can be FOUND by, beyond its own name and tags ──────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────────────────────────
-- Sandeep: "if a cake has ranbow in it, and the template is names 'kids birthday cake', when user
-- searches the template with rainbow, it does not show up. thats a big gap in fact."
--
-- A template is findable today by its NAME and its OWN tags. The design knows far more — which
-- decorations are on the cake, and what is literally piped on it — and nothing has ever read either.
-- `search_slugs` is that, derived: element names, element tag slugs and display names, and the
-- cake's own text.
--
-- ── WHY A STORED COLUMN RATHER THAN A JOIN AT READ TIME ─────────────────────────────────────────
-- ⚠️ THE CHEAP VERSION IS NOT AVAILABLE. Joining template_elements when the list is read would
-- cover the element half — but Layer 1 removed `design` from the list query
-- (plans/template-browsing-at-scale.md), so the cake's TEXT is not there to derive from at read
-- time. Storing it also keeps the list read one query rather than two.
--
-- ── WHAT IT COSTS, MEASURED RATHER THAN GUESSED ─────────────────────────────────────────────────
-- Measured on dev before building, across the real catalogue:
--
--   avg terms per template   3.5      max 12
--   avg bytes added          53       max 133
--
-- The plan estimated "a couple of hundred bytes, taking a row from roughly 500 to 750". That was
-- four times too pessimistic: a row grows about a tenth, not a half.
--
-- ⚠️ AND A FINDING THE MEASUREMENT EXPOSED. All 56 elements in use are UNTAGGED
-- (avg_tags_per_element 0.00), so 3.4 elements yield 3.5 terms — one per element, the NAME and
-- nothing else. The element-tag half of this is written and inert; element names carry the feature
-- today. That is also why the cake's text matters more here than the plan first weighted it.
--
-- ── CHIPS AND SEARCH STAY SEPARATE ──────────────────────────────────────────────────────────────
-- This is searched and never drawn. The filter's chips come from `template_tags`, which a person
-- curated; folding derived terms in there would put every element's name into the funnel as a chip.
-- Search widens, the filter stays legible. See plans/catalogue-findability.md.

alter table public.cake_templates
  add column if not exists search_slugs text[];

comment on column public.cake_templates.search_slugs is
  'Derived, never authored: element names + element tag slugs/names + the design''s own text. '
  'Rebuilt by syncTemplateDerived on every design write, and by '
  'scripts/backfill-template-elements.mjs. Searched, never displayed.';

-- ⚠️ NO INDEX YET, DELIBERATELY. Search is CLIENT-side today: the whole filtered list is already in
-- the browser, and the predicate runs there (spattoo-core designer/templateFilter.js). A GIN index
-- would serve a server-side search that does not exist. Add one WITH that query, not before it —
-- an unused index is write cost on every template save for nothing.
--
-- When it is wanted:
--   create index idx_cake_templates_search_slugs on public.cake_templates using gin (search_slugs);

-- ── What landed ─────────────────────────────────────────────────────────────────────────────────
-- Null until the backfill runs; new saves populate themselves.
select
  count(*)                                              as templates,
  count(*) filter (where search_slugs is not null)      as with_terms,
  coalesce(round(avg(cardinality(search_slugs)), 1), 0) as avg_terms
from public.cake_templates
where design is not null;
