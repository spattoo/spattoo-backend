-- GLB cost stats on cake_elements (ASSET_OPTIMIZATION_PLAN.md §3/§5). Captured at ingest from the
-- GLB Studio review so the element's real cost on phones is known + auditable, and the runtime budget
-- guard can read it later. Over-cap is FLAGGED (over_cap), never blocked — some toppers must stay heavy.
--
-- asset_class is a compact surrogate (smallint), not text, per the hot-table rule: 1=scatter, 2=decor,
-- 3=topper. The API translates to/from the readable key at the boundary. All additive + nullable.
alter table public.cake_elements
  add column if not exists asset_class       smallint,
  add column if not exists tri_count         integer,
  add column if not exists texture_max_dim   smallint,
  add column if not exists decoded_mem_kb    integer,
  add column if not exists optimized_size_kb integer,
  add column if not exists over_cap          boolean not null default false,
  add column if not exists optimizer_version smallint,
  add column if not exists optimized_at      timestamptz;

comment on column public.cake_elements.asset_class is
  'GLB cost tier (compact surrogate): 1=scatter/small, 2=decor, 3=topper/hero. Drives the §3 caps.';
comment on column public.cake_elements.decoded_mem_kb is
  'Estimated decoded GPU memory (KB) — the metric that actually bounds phone RAM, not file size.';
comment on column public.cake_elements.over_cap is
  'True if any measured stat exceeds the asset_class caps. A flag for visibility, not a block.';
