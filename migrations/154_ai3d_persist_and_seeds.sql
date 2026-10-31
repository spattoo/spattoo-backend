-- ── 154: a paid generation stops evaporating, and can be varied one thing at a time ─────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── THE MONEY BUG ───────────────────────────────────────────────────────────────────────────────
-- `meshy_generations.glb_key` has existed since the table did, is READ in four places, and the
-- studio flow never WROTE it. Measured on dev 2026-10-31: 8 successful runs, 1 with a copy — and
-- that one came through the older `routes/meshy.js`, which does mirror and says why ("Meshy URLs
-- expire"). The newer flow hands the vendor URL straight back and re-polls by task id, so when a
-- vendor ages a task out the model is gone and the credits are spent.
--
-- Sandeep: *"where do we store the generated model temporarily? in memory is risky and if lost
-- baker looses credits. we should store them in R2, even if its temporary?"* Yes — and for a BAKER
-- there is no "temporary": they paid for it.
--
-- ⚠️ THE OLD REASONING WAS NOT WRONG, IT WAS ABOUT SOMEBODY ELSE. The route's comment argued that
-- "studio runs are experiments that get looked at once and thrown away; copying every one into R2
-- would fill the bucket with rejects". True of STAFF, who generate to measure a vendor. A baker
-- generates to put something on a cake tomorrow. Same fork as everywhere else in this feature: the
-- answer depends on who is at the keyboard.
--
-- So: mirror every success, and let a lifecycle rule expire the ones nobody chose
-- (`scripts/set-r2-lifecycle.mjs`, prefix `ai3d/runs/`, 30 days). Promotion to an element COPIES
-- the file out of that prefix, so an element never points at an expiring object.

-- ⚠️ THE SEEDS ARE WHAT MAKE A SECOND ATTEMPT CHEAP. Tripo's docs: "Using the same seed with the
-- same input will produce an identical 3D mesh." There is no conversational editing — `refine_model`
-- exists but refuses anything newer than v2.0-20240919 — so "the same bear, but sitting" is
-- impossible. With the seed stored it becomes possible to vary ONE thing and get a related model
-- rather than an unrelated one, which is the whole point of asking a baker questions at all.
-- `texture_seed` is separate from `model_seed`, so geometry and colour can be pinned independently.
alter table meshy_generations add column if not exists model_seed   bigint;
alter table meshy_generations add column if not exists texture_seed bigint;

comment on column meshy_generations.model_seed is
  'Tripo model_seed. Same prompt + same seed = identical geometry, so a follow-up run can vary one '
  'thing instead of re-rolling. There is no edit-an-existing-model API; this is the substitute.';

-- ⚠️ A GENERATION IS NOT AN ELEMENT UNTIL SOMEBODY SAYS SO. Sandeep: *"should we make this a baker
-- element yet? yes but this is an explicit baker action."* A generation that silently became a
-- catalogue row would put rejects in front of customers, and the baker never chose it. Null until
-- promoted; set to the element it became, so a run can say "this one is already yours".
alter table meshy_generations add column if not exists promoted_element_id uuid
  references cake_elements(id) on delete set null;

comment on column meshy_generations.promoted_element_id is
  'The element this generation became, or NULL. Promotion is an explicit action — a generation is '
  'visible to its maker either way, but only a promoted one is a catalogue element.';

create index if not exists meshy_generations_creator_recent
  on meshy_generations (created_by, created_at desc);
