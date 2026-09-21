-- ── 101: what a decoration is MADE OF becomes a table, not a CHECK constraint ────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── THE BUG THIS CLOSES ─────────────────────────────────────────────────────────────────────────
-- `cake_elements.medium` was a CHECK constraint, and three places disagreed with it about what the
-- allowed values ARE. Probed against dev on 2026-09-21: the column accepts
-- `fondant | edible_print | piped | acrylic | other` and rejects everything else.
--
--   1. `services/decorationPolicy.js` switches on 'fondant', 'chocolate', 'edible_paper', 'acrylic'.
--      So 'chocolate' and 'edible_paper' are DEAD BRANCHES — the database cannot hold either — and
--      'edible_print', the real value for a printed sheet, matches no case and falls through to the
--      permissive default: `{ modelling: true, print: true, reason: 'medium not stated' }`.
--      A printed sheet was therefore offered a HAND-MODELLING guide, which migration 032's own
--      comment calls out as the thing that must never happen: "offering modelling on an
--      EDIBLE_PAPER one would invent a process. Neither is a matter of taste." And the logged
--      reason said "not stated" about a medium that WAS stated.
--   2. `scripts/check-decoration-policy.mjs` passed green throughout, because its fixtures use
--      `medium: 'edible_paper'` — asserting the code against a vocabulary the database refuses.
--   3. Admin's "Made of" picker offered "Modelling chocolate" and "Edible paper". Both are rejected
--      on save. An admin choosing either got a failure for a choice we put in front of them.
--
-- Migration 032 intended the vocabulary the code was written against and was never applied here.
-- Rather than re-running it and picking a winner between two hand-kept lists, the list stops being
-- hand-kept.
--
-- ── WHY A TABLE ─────────────────────────────────────────────────────────────────────────────────
-- Root CLAUDE.md rule 3: every value an admin would tune must be authorable without a deploy. A
-- material is exactly that — isomalt, wafer paper, marzipan and whatever a baker works in next year
-- are catalogue facts, not code. Behind a CHECK constraint, adding isomalt is a migration, a deploy
-- and a code change in three repos, which is why the three drifted apart in the first place.
--
-- Rule 2 says the same from the other side: a second variant of an existing thing is a NEW ROW, not
-- a new branch. `element_types` (how it BEHAVES) and `element_categories` (what it IS) are already
-- tables for this reason; `medium` (what it is MADE OF) is the third axis and was the odd one out.

create table if not exists decoration_mediums (
  key         text    primary key,
  label       text    not null,
  -- ⚠️ THE POLICY IS DATA NOW. `decorationPolicy()` reads these two instead of switching on a
  -- string, so a new material arrives correct rather than falling into a default that happens to
  -- be generous. They are separate claims and collapsing them loses a real answer: "you do not
  -- hand-make this" and "you cannot print this" are different, which is why a bought wafer
  -- butterfly still offers a print.
  can_model   boolean not null default true,
  can_print   boolean not null default true,
  -- Fed to the guide prompt so it describes THIS material's process. Without it every guide is
  -- written for sugar paste — openai.js currently says "roll white fondant" and "cut from a rolled
  -- sheet of fondant" whatever the decoration is made of.
  build_note  text,
  -- Which guide shape applies. 'modelled' is the step-by-step build sheet; 'piping_nozzle' is the
  -- curated nozzle + consistency recommendation; null means we offer no making guide for this.
  guide_format text check (guide_format is null or guide_format in ('modelled', 'piping_nozzle')),
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  updated_at  timestamptz not null default now()
);

comment on table decoration_mediums is
  'What a decoration is MADE OF, and what X-Ray may therefore offer for it. Admin-authored: adding '
  'a material must never need a deploy. Orthogonal to element_types (how it behaves) and '
  'element_categories (what it is).';

-- ── The materials ───────────────────────────────────────────────────────────────────────────────
-- ⚠️ EVERY KEY THE LIVE COLUMN ALREADY HOLDS IS SEEDED, so the foreign key below can be added
-- without touching a single existing row. Production may hold values dev does not; adding rows is
-- safe, remapping them is not, and a migration that silently rewrites catalogue data to fit a
-- tidier list is how a decoration quietly changes what it is made of.
insert into decoration_mediums (key, label, can_model, can_print, guide_format, build_note, sort_order) values
  ('fondant',      'Fondant / gumpaste',        true,  true,  'modelled',
   'Sugar paste, kneaded soft and either rolled into a sheet and cut, or modelled in the round from shaped pieces. Dries firm.', 10),

  ('modelling_chocolate', 'Modelling chocolate', true, true,  'modelled',
   'Chocolate and glucose worked to a pliable paste. Warms and softens in the hands, so it is shaped in short sessions and chilled to hold detail.', 20),

  ('marzipan',     'Marzipan',                  true,  true,  'modelled',
   'Almond paste, modelled like fondant but softer and oilier; it takes colour unevenly and is usually finished with dusts rather than gels.', 30),

  -- ⚠️ ISOMALT IS NOT SUGAR PASTE AND ITS GUIDE MUST NOT READ LIKE ONE. It is cooked, poured and
  -- set — there is no rolling, no kneading and no drying time. A guide that said "roll it thin"
  -- would be describing a process that does not exist for this material, which is the same failure
  -- as offering a modelling guide for a printed sheet.
  ('isomalt',      'Isomalt / sugar glass',     true,  false, 'modelled',
   'Sugar substitute melted to around 170C and poured into a mould or drawn on a silicone mat, then left to set hard and clear. Worked hot, never rolled; brittle once cool and ruined by humidity.', 40),

  ('wafer_paper',  'Wafer paper (shaped)',      true,  true,  'modelled',
   'Edible rice paper cut to shape, then softened with water or steam so it curls and holds a form, dried, and usually dusted or edged by hand. This is the SHAPED craft — petals, ruffles, flowers — not a printed sheet.', 50),

  ('royal_icing',  'Royal icing',               true,  false, 'modelled',
   'Icing sugar and egg white piped onto parchment or a mat and left to dry hard, then lifted off. Built flat in layers rather than modelled.', 60),

  -- ⚠️ THE PRINTED SHEET, AND THE REASON THIS WHOLE TABLE MATTERS. There is no hand-modelled
  -- version of a print, so `can_model` is false — the failure a generous default was causing.
  ('edible_print', 'Edible print (printed sheet)', false, true, null,
   'A design printed in edible ink onto an icing or wafer sheet and applied to the cake. Nothing is modelled: what varies is the artwork and the size it is printed at.', 70),

  -- Cream, in either technique. The nozzle guide already covers piping and the modelling format is
  -- written for sugar paste, so it would read wrongly here.
  ('cream',        'Buttercream / whipped',     false, false, 'piping_nozzle',
   'Buttercream or whipped cream, piped through a nozzle or spread and shaped with a palette knife.', 80),
  ('piped',        'Piped (legacy key)',        false, false, 'piping_nozzle',
   'Retained because the column already holds this value. Same material as cream; prefer `cream` for new elements.', 85),

  ('acrylic',      'Acrylic / non-edible',      false, false, null,
   'A bought non-edible topper. Not made and not printed — it is sourced.', 90),

  ('other',        'Other',                     true,  true,  'modelled',
   null, 100)
on conflict (key) do update set
  label        = excluded.label,
  can_model    = excluded.can_model,
  can_print    = excluded.can_print,
  guide_format = excluded.guide_format,
  build_note   = excluded.build_note,
  sort_order   = excluded.sort_order,
  updated_at   = now();

-- ── Point the column at the table ───────────────────────────────────────────────────────────────
-- The CHECK goes and a foreign key replaces it, so the vocabulary has exactly one home. Every value
-- currently stored is seeded above, so this cannot orphan a row — but it is verified below rather
-- than asserted, because a production value dev has never seen would fail the constraint at the
-- worst possible moment.
do $$
declare orphan text;
begin
  select string_agg(distinct medium, ', ') into orphan
    from cake_elements
   where medium is not null
     and medium not in (select key from decoration_mediums);
  if orphan is not null then
    raise exception 'cake_elements.medium holds value(s) not in decoration_mediums: %. Seed them before re-running.', orphan;
  end if;
end $$;

alter table cake_elements drop constraint if exists cake_elements_medium_chk;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cake_elements_medium_fk') then
    alter table cake_elements
      add constraint cake_elements_medium_fk foreign key (medium)
      references decoration_mediums (key) on update cascade;
  end if;
end $$;

comment on column cake_elements.medium is
  'MATERIAL only — technique lives in element_types, and cream is not always piped. FK to '
  'decoration_mediums, which also carries whether X-Ray may offer a making guide or a print. An '
  'admin HINT for what to pre-build, NEVER a gate on what a baker may do. Null = not stated.';

-- Server-only, like the other vocabulary tables: read through the API, never from a browser.
alter table decoration_mediums enable row level security;

-- Expect: 11 materials, and every stored medium resolving to one of them.
select key, label, can_model, can_print, guide_format from decoration_mediums order by sort_order;
select coalesce(medium, '(not stated)') as medium, count(*)
  from cake_elements group by 1 order by 2 desc;
