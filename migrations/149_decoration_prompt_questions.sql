-- ── 149: what we ASK a baker before generating a 3D decoration becomes data ──────────────────────
-- Apply manually to dev/prod Supabase (no migration runner). Safe to re-run.
--
-- ── THE PROBLEM ─────────────────────────────────────────────────────────────────────────────────
-- Sandeep: *"if a baker asks for a lion, it might give a real lion 3d. but baker usually wants is a
-- fondant lion, and that too in seating position. we cant directly send that as prompt - but the
-- questions we ask are based on what element baker asks - for flowers it could be different."*
--
-- A generator answers the prompt it is given. "lion" returns a photoreal lion: wrong material, no
-- flat base, far over the triangle budget, and unrecolourable because it arrives textured. The
-- baker wanted a seated fondant lion. The gap between those is three questions — but WHICH three
-- depends on what the thing IS. A flower is never "sitting"; it is a bud or open, single or a
-- spray, flat-backed for the side of a cake or round for the top.
--
-- ── WHY A TABLE, NOT A SWITCH ON CATEGORY ───────────────────────────────────────────────────────
-- Root CLAUDE.md rule 2: behaviour flows from data, never from a branch on a name. The moment this
-- is `if (category === 'flowers-leaves')` the twenty-second category has no questions and nobody
-- notices. Rule 3: an admin must be able to add a question without a deploy — and they will, every
-- time a generation comes back wrong in a new way. That is the whole feedback loop of this feature.
--
-- ── WHY IT HANGS OFF element_categories ─────────────────────────────────────────────────────────
-- The identity axis already exists and is already master data: Animals, Flowers & Leaves, Vehicles,
-- People, Sea, Baby, Fruits. A new taxonomy for "what kind of thing is this" would be a second
-- answer to a question the catalogue has answered since migration 073 — and the category is
-- ALREADY a required field on the element row, so asking for it costs the baker nothing new.
-- `category_id is null` means "ask this for everything".

create table if not exists decoration_prompt_questions (
  id          uuid primary key default gen_random_uuid(),
  -- NULL = universal. Not a sentinel row, because a FK to a magic "all" category would let someone
  -- delete it and silently drop every universal question.
  category_id uuid references element_categories(id) on delete cascade,
  key         text not null,
  label       text not null,
  help        text,
  -- ⚠️ 'mediums' IS THE WHOLE REASON THIS COLUMN EXISTS, and it closes a bug that was live today.
  -- A question whose source is 'mediums' stores NO options: it reads `decoration_mediums` where
  -- `can_model`, which is the one place that knows what a decoration can be MADE of. The
  -- alternative — seeding fondant/chocolate/... as option rows here — is a fifth hand-kept copy of
  -- a vocabulary that migration 101 made a table precisely to stop, and whose own comment says
  -- "admin can no longer hold its own copy". The admin prompt builder had already drifted: it
  -- offered "Buttercream", which maps to `cream`, which has can_model = false.
  source      text not null default 'options' check (source in ('options', 'mediums')),
  required    boolean not null default false,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  updated_at  timestamptz not null default now(),
  unique (category_id, key)
);

-- ⚠️ POSTGRES TREATS NULLS AS DISTINCT IN A UNIQUE CONSTRAINT, so the `unique (category_id, key)`
-- above does NOT stop two universal questions sharing a key — exactly the rows most likely to be
-- duplicated, because they are the ones every category inherits.
create unique index if not exists decoration_prompt_questions_universal_key
  on decoration_prompt_questions (key) where category_id is null;

comment on table decoration_prompt_questions is
  'What to ask before generating a 3D decoration, per element_categories. category_id null = asked '
  'for every category. source=mediums reads decoration_mediums rather than storing options.';

create table if not exists decoration_prompt_options (
  id          uuid primary key default gen_random_uuid(),
  question_id uuid not null references decoration_prompt_questions(id) on delete cascade,
  key         text not null,
  label       text not null,
  -- ⚠️ THE FRAGMENT THAT REACHES THE GENERATOR, and it is the only part that costs money to get
  -- wrong. Empty is legitimate and means "adds nothing" — that is what a "No preference" option is,
  -- and it must not be modelled as a missing row, or the baker cannot say it.
  phrase      text not null default '',
  is_default  boolean not null default false,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  unique (question_id, key)
);

comment on table decoration_prompt_options is
  'An answer to a decoration_prompt_question. `phrase` is what reaches the generator.';

-- ── The questions ───────────────────────────────────────────────────────────────────────────────
-- ⚠️ EVERY PHRASE BELOW WAS MEASURED AGAINST TRIPO, not written from taste. The run that kept its
-- parts AND came in under the 25,000-triangle decor cap carried "simple rounded shapes"; asking for
-- fur put an earlier run at 501,326 triangles, because fur cannot exist without a texture and we
-- generate UNTEXTURED so the parts stay recolourable. "sitting"/"standing" is what gives the model
-- a flat base — without one it floats, and a decoration that cannot sit on a cake is not one.
--
-- ⚠️ AND NOTHING HERE ASKS FOR COLOUR. The point of untextured parts is that the baker colours them
-- per part afterwards in the designer; a colour in the prompt is paid-for geometry we then discard.

insert into decoration_prompt_questions (category_id, key, label, help, source, required, sort_order) values
  (null, 'medium',    'Made of',      'Only materials that can actually be modelled are offered.', 'mediums', true,  10),
  (null, 'placement', 'Where it goes', 'Decides whether it is modelled in the round or flat-backed.', 'options', false, 20),
  (null, 'detail',    'Detail',       'More detail is more triangles, and triangles are the budget.', 'options', false, 30)
on conflict do nothing;

insert into decoration_prompt_options (question_id, key, label, phrase, is_default, sort_order)
select q.id, v.key, v.label, v.phrase, v.is_default, v.sort_order
from decoration_prompt_questions q
join (values
  ('placement', 'top',  'Top of the cake',  'modelled in the round with a flat base so it stands on the cake', true,  10),
  ('placement', 'side', 'Side of the cake', 'flat-backed relief so it sits flush against a vertical surface', false, 20),
  ('placement', 'any',  'No preference',    '',                                                              false, 30),
  ('detail',    'simple',   'Simple',   'simple rounded shapes, few separate pieces', true,  10),
  ('detail',    'moderate', 'Moderate', 'clean shapes with a few distinct pieces',    false, 20),
  ('detail',    'detailed', 'Detailed', 'detailed sculpted shapes',                   false, 30)
) as v(qkey, key, label, phrase, is_default, sort_order) on v.qkey = q.key
where q.category_id is null
on conflict do nothing;

-- ── Per-category questions ──────────────────────────────────────────────────────────────────────
-- Seeded by SLUG, and only for slugs that exist — a category this install does not have is skipped
-- rather than failing the migration. Production and dev do not hold identical category rows.

insert into decoration_prompt_questions (category_id, key, label, help, source, required, sort_order)
select c.id, v.key, v.label, v.help, 'options', false, v.sort_order
from element_categories c
join (values
  -- A creature: how it sits is what gives it a base, and "cute" is what stops a photoreal animal.
  ('animals',        'pose', 'How it sits', 'Gives the model a flat base to stand on.', 40),
  ('animals',        'look', 'Look',        'Cute reads as a cake decoration; realistic reads as a statue.', 50),
  ('people',         'pose', 'How it sits', 'Gives the model a flat base to stand on.', 40),
  ('people',         'look', 'Look',        'Cute reads as a cake decoration; realistic reads as a statue.', 50),
  ('baby',           'pose', 'How it sits', 'Gives the model a flat base to stand on.', 40),
  ('sea',            'pose', 'How it sits', 'Gives the model a flat base to stand on.', 40),
  -- A flower is never "sitting". These are the axes that actually vary.
  ('flowers-leaves', 'form',  'Form',  'One bloom, or a spray with leaves.',            40),
  ('flowers-leaves', 'bloom', 'Bloom', 'How far open the flower is.',                   50),
  ('vehicles',       'view',  'Shape', 'Full round, or a flat-backed side profile.',    40),
  ('fruits',         'form',  'Form',  'Whole, or cut to show the inside.',             40)
) as v(slug, key, label, help, sort_order) on v.slug = c.slug
on conflict do nothing;

insert into decoration_prompt_options (question_id, key, label, phrase, is_default, sort_order)
select q.id, v.key, v.label, v.phrase, v.is_default, v.sort_order
from decoration_prompt_questions q
join element_categories c on c.id = q.category_id
join (values
  ('pose', 'sitting',  'Sitting',       'sitting upright with a flat base',   true,  10),
  ('pose', 'standing', 'Standing',      'standing upright with a flat base',  false, 20),
  ('pose', 'lying',    'Lying flat',    'lying flat, low profile',            false, 30),
  ('pose', 'any',      'No preference', '',                                   false, 40),
  ('look', 'cute',      'Cute',      'cute stylised proportions, large head, friendly face', true,  10),
  ('look', 'realistic', 'Realistic', 'realistic proportions',                                false, 20),
  ('form_flower', 'single', 'Single bloom',   'a single bloom',                        true,  10),
  ('form_flower', 'spray',  'Spray',          'a small spray of blooms with leaves',   false, 20),
  ('form_flower', 'stem',   'With stem',      'one bloom on a short stem with leaves', false, 30),
  ('bloom', 'bud',  'Bud',       'a closed bud',    false, 10),
  ('bloom', 'half', 'Half open', 'half open',       false, 20),
  ('bloom', 'full', 'Full open', 'fully open',      true,  30),
  ('view', 'round', 'Full round',   'modelled in the round',                 true,  10),
  ('view', 'side',  'Side profile', 'flat-backed side profile, low relief',  false, 20),
  ('form_fruit', 'whole',  'Whole',  'whole and uncut',            true,  10),
  ('form_fruit', 'half',   'Halved', 'cut in half, cut face up',   false, 20),
  ('form_fruit', 'slice',  'Slice',  'a single slice',             false, 30)
) as v(qkey, key, label, phrase, is_default, sort_order)
  -- `form` means different things for a flower and a fruit, so the seed disambiguates by category
  -- while the stored key stays the short one the prompt builder reads.
  on v.qkey = case when q.key = 'form' and c.slug = 'flowers-leaves' then 'form_flower'
                   when q.key = 'form' and c.slug = 'fruits'         then 'form_fruit'
                   else q.key end
where q.category_id is not null
on conflict do nothing;

-- ⚠️ SERVICE_ROLE ONLY — NO anon/authenticated GRANT, deliberately. These are read through our own
-- API (`GET /api/decoration-prompt-questions`), which is also where the "Made of" question is
-- resolved against decoration_mediums. Granting the browser direct access would let a client read
-- the raw `source: 'mediums'` rows and work out for itself what that means — and the way it would
-- do that is by holding its own material list, which is the exact drift this whole design exists to
-- prevent. `decoration_mediums` (101) takes the same posture for the same reason.
-- check:migration-grants asked for this to be stated; stating it changed the answer.
grant all on decoration_prompt_questions to service_role;
grant all on decoration_prompt_options   to service_role;
