-- ── 128: a catalogued template records the renderer it needs ────────────────────────────────────
--
-- A template is data, but it does not render itself. It renders on whatever build of
-- @spattoo/designer the viewer is running, and those diverge two ways at once: prod web trails dev
-- because production is a deliberate deploy, and once the app is in the stores a phone carries
-- whatever build it last updated to. "A new design every week" therefore means "every week we ship
-- data that may need code the viewer does not have."
--
-- Three ways a template can need a newer build, and only the third forces a human:
--
--   1. A NEW PROCEDURAL CONTROL. `placement_config.procedural` selects a renderer out of
--      PROCEDURAL_TOOLS in CakeDesigner. An older build has no entry, and today the lookup falls
--      straight through `if (proc)` — the decoration silently does not appear. Derivable, and
--      migration 127 already records the same hazard from the other side.
--   2. A NEW placement_config KEY on an existing path. Worse: the old build does not fail a lookup,
--      it ignores the key and draws something subtly wrong. `side_rotation` (core 0.1.673) is the
--      example — without it a hand-piped rose on a wall faces backwards. No error, just a wrong
--      cake.
--   3. A BUGFIX. No new key, no new control, no config change at all — the renderer simply got more
--      correct. `ringBaseY` (core 0.1.672) is the example: a tilted ring sank half into the cake
--      because the seat was measured before the tilt. A template authored against the fixed build
--      looks right; the same template on the old build is wrong, and NOTHING IN THE DATA
--      DISTINGUISHES THEM.
--
-- Class 3 is why this is a stored number rather than something derived from the config. A purely
-- derived capability list was proposed and rejected in that order — see
-- spattoo-docs/plans/renderer-version-floor.md so it is not re-proposed.
--
-- ⚠️ TWO COLUMNS, NOT ONE, AND THAT IS THE WHOLE POINT OF THIS MIGRATION. With a single value you
-- can never distinguish "0.1.650, set deliberately after someone checked" from "0.1.650, left over
-- because nobody looked" — and that distinction is the entire investigation the first time a
-- catalogued template misbehaves on older installs. `auto_` is what the build reported and is never
-- edited by hand; `min_` is what ships and is the author's to override.
--
-- ⚠️ NULL MEANS "RENDERS ANYWHERE", and every existing row keeps it. Backfilling a floor onto the
-- current catalogue would be inventing evidence: nobody checked those templates against any
-- particular build, and a number nobody verified is worse than no number, because the gates below
-- would enforce it as though somebody had.
--
-- Read by two gates, and the first matters more than the second:
--   · THE IMPORT. A template catalogued on dev at 0.1.674 and imported into a prod running 0.1.650
--     is broken for every production WEB user at once, and web has no "update your app" remedy.
--     ImportElements.jsx already refuses a bundle on a slug collision; this is the same refusal.
--   · THE APP. Per install, once Capacitor ships: the design stays in the library, tapping it says
--     the app needs updating, with an Update now button.

alter table public.cake_templates
  add column if not exists min_core_version  text,
  add column if not exists auto_core_version text;

comment on column public.cake_templates.min_core_version is
  'Lowest @spattoo/designer version that renders this template correctly, as x.y.z. NULL = renders '
  'anywhere. Read by the dev→prod import gate and by the app version gate. Defaults to '
  'auto_core_version at catalogue time; an admin may override, and LOWERING it is a claim that the '
  'template renders correctly on builds they are not running.';

comment on column public.cake_templates.auto_core_version is
  'The @spattoo/designer version the admin was running when this template was catalogued, stamped '
  'automatically and never edited by hand. Kept beside min_core_version so an override stays '
  'visible: one column cannot tell a deliberate lowering from a value nobody looked at.';

-- ⚠️ A FLOOR MUST BE COMPARABLE, so reject anything that is not x.y.z. A free-text version column
-- collects "1.0", "v0.1.674" and "latest" within a month, and every comparison downstream then has
-- to guess. NULL stays allowed — that is "no floor", which is different from a malformed one.
alter table public.cake_templates
  drop constraint if exists cake_templates_min_core_version_semver;
alter table public.cake_templates
  add constraint cake_templates_min_core_version_semver
  check (min_core_version is null or min_core_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$');

alter table public.cake_templates
  drop constraint if exists cake_templates_auto_core_version_semver;
alter table public.cake_templates
  add constraint cake_templates_auto_core_version_semver
  check (auto_core_version is null or auto_core_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$');

-- The import gate asks "which catalogue templates does this environment's core fail to meet", which
-- is a scan of the floors alone. Partial, because the overwhelming majority of rows are NULL and
-- indexing "renders anywhere" buys nothing.
create index if not exists cake_templates_min_core_version_idx
  on public.cake_templates (min_core_version)
  where min_core_version is not null;
