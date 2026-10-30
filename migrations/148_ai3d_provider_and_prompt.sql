-- ── 148: the 3D generation row stops being Meshy-only ───────────────────────────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run — every step is guarded.
--
-- Sandeep: *"explore meshy.ai, tripo.ai or any other 3d generators that can fit into spattoo"*, then
-- *"build a studio in admin, where we can switch between tripo and meshy"*.
--
-- 009 created `meshy_generations` for one vendor and one shape: an image goes in, a GLB comes out.
-- Both halves of that are now too narrow. Tripo is a second vendor, and TEXT to 3D has no source
-- image at all — which is why `source_image_key` has to stop being NOT NULL.
--
-- ⚠️ THE TABLE KEEPS ITS NAME, DELIBERATELY. `meshy_generations` is wrong the moment Tripo lands,
-- and renaming it is still not worth it: `routes/meshy.js`, the shipped Image → 3D wizard and the
-- account-global webhook all address it, and a rename is a coordinated edit across three of those
-- for a cosmetic gain. The `provider` column is what makes it honest; the name is a scar.
--
-- ⚠️ `meshy_task_id` LIKEWISE KEEPS ITS NAME and now holds whichever vendor's task id. It is UNIQUE,
-- which is what the Meshy webhook matches on, and two vendors' id spaces colliding is not a real
-- risk (both are long opaque strings). A second nullable column per vendor would have meant every
-- read asking which one to look at.
--
-- ⚠️ `provider` DEFAULTS TO 'meshy' SO EVERY EXISTING ROW STAYS TRUE. Those rows were all Meshy, so
-- the default is a fact about history rather than a guess, and the shipped wizard keeps working
-- without being touched.
--
-- ⚠️ `wants_parts` IS RECORDED, NOT INFERRED. Tripo's Generate Parts add-on and Meshy's Auto Split
-- both cost extra credits, so whether a run asked for parts is the first thing anyone comparing
-- cost per usable element will want, and it cannot be recovered from the GLB afterwards — a model
-- that came back fused might have been asked to split and failed to.
alter table meshy_generations add column if not exists provider    text not null default 'meshy';
alter table meshy_generations add column if not exists mode        text not null default 'image';
alter table meshy_generations add column if not exists prompt      text;
alter table meshy_generations add column if not exists wants_parts boolean not null default false;
alter table meshy_generations alter column source_image_key drop not null;

-- Guard rails on the two new vocabularies. Added separately and guarded, because a CHECK that
-- already exists is an error rather than a no-op.
do $$ begin
  alter table meshy_generations add constraint meshy_generations_provider_check
    check (provider in ('meshy', 'tripo'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table meshy_generations add constraint meshy_generations_mode_check
    check (mode in ('image', 'text'));
exception when duplicate_object then null; end $$;

-- ⚠️ A TEXT RUN NEEDS A PROMPT AND AN IMAGE RUN NEEDS AN IMAGE. Without this a text row with no
-- prompt is accepted and fails later inside the vendor, where the error is theirs and unreadable.
do $$ begin
  alter table meshy_generations add constraint meshy_generations_input_check
    check ((mode = 'image' and source_image_key is not null)
        or (mode = 'text'  and prompt           is not null));
exception when duplicate_object then null; end $$;

-- What it should look like afterwards:
--   select provider, mode, count(*) from meshy_generations group by 1, 2;
--   → every pre-existing row reads ('meshy', 'image')
